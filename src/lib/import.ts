import JSZip from 'jszip';
import { createNote, detectContentFeatures, db, type Note } from './db';

/** Parse frontmatter (---\nkey: value\n---) from markdown content */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = raw;

  // Standard YAML frontmatter: file must start with ---
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const block = raw.slice(3, end).trim();
      for (const line of block.split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const key = line.slice(0, colon).trim().toLowerCase();
          const val = line.slice(colon + 1).trim();
          meta[key] = val;
        }
      }
      body = raw.slice(end + 4).trim();
    }
  }

  return { meta, body };
}

/** Extract title from markdown: first # heading or first non-empty line */
function extractTitle(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  const firstLine = body.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.replace(/^#+\s*/, '').trim() || fallback;
}

/** Parse our own export format: # Title\n\nTags: ...\nCategory: ...\n\ncontent */
function parseExportFormat(body: string): { title: string; tags: string[]; category: string; content: string } {
  const lines = body.split('\n');
  let title = 'Untitled';
  let tags: string[] = [];
  let category = 'General';
  let contentStart = 0;

  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
      contentStart = i + 1;
    } else if (line.startsWith('Tags: ')) {
      tags = line.slice(6).split(',').map((t) => t.trim()).filter(Boolean);
      contentStart = i + 1;
    } else if (line.startsWith('Category: ')) {
      category = line.slice(10).trim();
      contentStart = i + 1;
    } else if (line.trim() === '' && contentStart > 0) {
      contentStart = i + 1;
    }
  }

  const content = lines.slice(contentStart).join('\n').trim();
  return { title, tags, category, content };
}

interface ImportResult {
  imported: number;
  errors: string[];
}

/** Import a single markdown file */
export async function importMarkdownFile(file: File): Promise<ImportResult> {
  try {
    const raw = await file.text();
    const { meta, body } = parseFrontmatter(raw);

    // Check if it matches our export format
    const parsed = parseExportFormat(body);

    const title = meta.title || parsed.title || file.name.replace(/\.md$/i, '');
    const tags = meta.tags
      ? meta.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : parsed.tags;
    const category = meta.category || parsed.category;
    const content = parsed.content || body;

    const features = detectContentFeatures(content);
    await createNote({
      title,
      content,
      tags,
      category,
      ...features,
    });

    return { imported: 1, errors: [] };
  } catch (e) {
    return { imported: 0, errors: [`Failed to import ${file.name}: ${e}`] };
  }
}

/** Import notes from a JSON file (array of note objects) */
export async function importJsonFile(file: File): Promise<ImportResult> {
  try {
    const raw = await file.text();
    const data = JSON.parse(raw);
    const items: Partial<Note>[] = Array.isArray(data) ? data : [data];

    let imported = 0;
    const errors: string[] = [];

    for (const item of items) {
      try {
        const features = detectContentFeatures(item.content || '');
        await createNote({
          title: item.title || 'Untitled',
          content: item.content || '',
          tags: Array.isArray(item.tags) ? item.tags : [],
          category: item.category || 'General',
          attachments: Array.isArray(item.attachments) ? item.attachments : [],
          pinned: item.pinned || false,
          ...features,
        });
        imported++;
      } catch (e) {
        errors.push(`Failed to import note "${item.title}": ${e}`);
      }
    }

    return { imported, errors };
  } catch (e) {
    return { imported: 0, errors: [`Failed to parse JSON: ${e}`] };
  }
}

/** Import notes from a ZIP file containing .md and/or .json files */
export async function importZipFile(file: File): Promise<ImportResult> {
  try {
    const zip = await JSZip.loadAsync(file);
    let imported = 0;
    const errors: string[] = [];

    const entries = Object.values(zip.files).filter((f) => !f.dir);

    for (const entry of entries) {
      const name = entry.name.split('/').pop() || entry.name;

      if (name.endsWith('.md')) {
        try {
          const text = await entry.async('text');
          const blob = new Blob([text], { type: 'text/markdown' });
          const mdFile = new File([blob], name);
          const result = await importMarkdownFile(mdFile);
          imported += result.imported;
          errors.push(...result.errors);
        } catch (e) {
          errors.push(`Failed to read ${name}: ${e}`);
        }
      } else if (name.endsWith('.json')) {
        try {
          const text = await entry.async('text');
          const blob = new Blob([text], { type: 'application/json' });
          const jsonFile = new File([blob], name);
          const result = await importJsonFile(jsonFile);
          imported += result.imported;
          errors.push(...result.errors);
        } catch (e) {
          errors.push(`Failed to read ${name}: ${e}`);
        }
      }
      // Skip .html and other files
    }

    return { imported, errors };
  } catch (e) {
    return { imported: 0, errors: [`Failed to read ZIP: ${e}`] };
  }
}

/** Import a full database backup JSON file (exported by exportDatabase) */
export async function importDatabaseBackup(file: File): Promise<ImportResult> {
  try {
    const raw = await file.text();
    const data = JSON.parse(raw);

    // Detect backup format: has a `tables` key with `notes` array
    if (!data.tables || !Array.isArray(data.tables.notes)) {
      return { imported: 0, errors: ['Not a valid database backup file'] };
    }

    let imported = 0;
    const errors: string[] = [];

    // Import notes
    for (const note of data.tables.notes) {
      try {
        const { id, ...rest } = note;
        // Restore dates
        rest.createdAt = new Date(rest.createdAt);
        rest.updatedAt = new Date(rest.updatedAt);
        rest.attachments = rest.attachments || [];
        rest.tags = rest.tags || [];
        rest.editDates = rest.editDates || [];
        rest.pinned = rest.pinned || false;
        await createNote(rest);
        imported++;
      } catch (e) {
        errors.push(`Failed to import note "${note.title}": ${e}`);
      }
    }

    // Import revisions
    if (Array.isArray(data.tables.revisions)) {
      for (const rev of data.tables.revisions) {
        try {
          const { id, ...rest } = rev;
          rest.savedAt = new Date(rest.savedAt);
          await db.revisions.add(rest);
        } catch (e) {
          // skip duplicate revisions silently
        }
      }
    }

    // Import key pairs
    if (Array.isArray(data.tables.keyPairs)) {
      for (const kp of data.tables.keyPairs) {
        try {
          await db.keyPairs.put(kp);
        } catch (e) {
          // skip
        }
      }
    }

    return { imported, errors };
  } catch (e) {
    return { imported: 0, errors: [`Failed to parse backup: ${e}`] };
  }
}

/** Import from any supported file(s) */
export async function importFiles(files: FileList): Promise<ImportResult> {
  let imported = 0;
  const errors: string[] = [];

  for (const file of Array.from(files)) {
    let result: ImportResult;

    if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
      result = await importMarkdownFile(file);
    } else if (file.name.endsWith('.json')) {
      // Try to detect if it's a database backup
      const text = await file.text();
      try {
        const parsed = JSON.parse(text);
        if (parsed.tables && Array.isArray(parsed.tables.notes)) {
          const blob = new Blob([text], { type: 'application/json' });
          result = await importDatabaseBackup(new File([blob], file.name));
        } else {
          const blob = new Blob([text], { type: 'application/json' });
          result = await importJsonFile(new File([blob], file.name));
        }
      } catch {
        result = await importJsonFile(file);
      }
    } else if (file.name.endsWith('.zip')) {
      result = await importZipFile(file);
    } else {
      result = { imported: 0, errors: [`Unsupported file type: ${file.name}`] };
    }

    imported += result.imported;
    errors.push(...result.errors);
  }

  return { imported, errors };
}
