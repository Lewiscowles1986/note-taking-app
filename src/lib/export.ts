import type { Note } from './db';
import { saveAs } from 'file-saver';
import { renderNoteViewToHtml } from './exportView';

// JSZip (~95 KB minified) is only needed when the user exports a ZIP archive,
// so it is loaded on demand to keep it out of the initial bundle.
type JSZipType = typeof import('jszip')['default'];
let jsZipPromise: Promise<JSZipType> | null = null;
function loadJSZip(): Promise<JSZipType> {
  jsZipPromise ??= import('jszip').then((m) => m.default);
  return jsZipPromise;
}

function noteToHtml(note: Note): string {
  // Simple markdown-to-html for export (basic conversion)
  const html = note.content
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${note.title}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #333; line-height: 1.6; }
    h1,h2,h3 { margin-top: 1.5rem; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    blockquote { border-left: 4px solid #ddd; margin: 1rem 0; padding-left: 1rem; color: #666; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
    .tags span { background: #f0e6d3; color: #8b6914; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; margin-right: 4px; }
  </style>
</head>
<body>
  <h1>${note.title}</h1>
  <div class="meta">
    <div>Created: ${note.createdAt.toLocaleDateString()}</div>
    <div>Category: ${note.category}</div>
    ${note.tags.length ? `<div class="tags">Tags: ${note.tags.map(t => `<span>${t}</span>`).join(' ')}</div>` : ''}
  </div>
  <div>${html}</div>
</body>
</html>`;
}

/** Sanitize a title into a safe file/path slug (kebab-case). */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'note';
}

/** HTML-escape a string for embedding in exported documents/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Standalone HTML document for an ENCRYPTED note. It embeds only the encrypted
 * payload (ciphertext + metadata) — never the plaintext — so the exported file
 * preserves the note in an unreadable state that still requires the encryption
 * credential. Deliberately reads `note.encrypted` and ignores `note.content`
 * (which is the "[encrypted]" placeholder, and would be a leak if a caller ever
 * passed decrypted content while the note was still marked encrypted).
 */
function encryptedNoteToHtml(note: Note): string {
  const encrypted = note.encrypted ?? null;
  const methodLabel =
    encrypted?.method === 'keypair'
      ? `Key-pair encrypted${encrypted.keyFingerprint ? ` (key fingerprint ${escapeHtml(encrypted.keyFingerprint)})` : ''}`
      : 'Password encrypted';
  const payloadJson = encrypted ? JSON.stringify(encrypted, null, 2) : '(no encrypted payload recorded)';
  const tagsRow = note.tags.length
    ? `<div class="tags">Tags: ${note.tags.map(t => `<span>${escapeHtml(t)}</span>`).join(' ')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(note.title)}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #333; line-height: 1.6; }
    .meta { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
    .tags span { background: #f0e6d3; color: #8b6914; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; margin-right: 4px; }
    .encrypted-banner { border: 1px solid #d7b94c; background: #fdf9e8; color: #6b5a12; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; }
    .encrypted-payload { background: #f4f4f4; padding: 1rem; border-radius: 8px; color: #444; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  <div class="meta">
    <div>Created: ${note.createdAt.toLocaleDateString()}</div>
    <div>Category: ${escapeHtml(note.category)}</div>
    ${tagsRow}
  </div>
  <div class="encrypted-banner">
    <strong>${methodLabel}</strong> — this note was exported in its encrypted form.
    Its content cannot be read without the encryption credential; no plaintext was exported.
  </div>
  <h2>Encrypted content</h2>
  <pre class="encrypted-payload">${escapeHtml(payloadJson)}</pre>
</body>
</html>`;
}

/**
 * Build rich HTML for a note by rendering it through the real viewer (graphics
 * included). Falls back to a plain markdown conversion if the viewer render
 * cannot complete (e.g. the browser disallows it).
 *
 * Encrypted notes are a hard exception: they are never rendered or decrypted
 * for export — only the encrypted payload is emitted.
 */
async function htmlForNote(note: Note): Promise<string> {
  if (note.encrypted) return encryptedNoteToHtml(note);
  return (await renderNoteViewToHtml(note)) ?? noteToHtml(note);
}

/**
 * The raw-markdown source that ships in a ZIP folder's README.md. For an
 * encrypted note there is no readable source, so the encrypted payload is
 * embedded instead — content is preserved, plaintext never leaves the app.
 */
function noteMarkdownSource(note: Note): string {
  const header = `# ${note.title}\n\nTags: ${note.tags.join(', ')}\nCategory: ${note.category}\n`;
  if (note.encrypted) {
    const payloadJson = JSON.stringify(note.encrypted, null, 2);
    return `${header}\n> Password-encrypted note — exported in encrypted form. Content is embedded below and requires the encryption credential to decrypt.\n\n\`\`\`json\n${payloadJson}\n\`\`\`\n`;
  }
  return `${header}\n${note.content}`;
}

export async function exportToHtml(note: Note) {
  const html = await htmlForNote(note);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${note.title.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

export async function exportToPdf(note: Note) {
  const html = await htmlForNote(note);
  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
    };
  }
}

export async function exportDatabase() {
  const { db } = await import('./db');
  const notes = await db.notes.toArray();
  const revisions = await db.revisions.toArray();
  const keyPairs = await db.keyPairs.toArray();

  const dump = {
    exportedAt: new Date().toISOString(),
    version: db.verno,
    tables: { notes, revisions, keyPairs },
  };

  const json = JSON.stringify(dump, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  saveAs(blob, `notesapp-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

export async function exportToZip(notes: Note[]) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const folder = zip.folder('notes');
  if (!folder) return;

  // Distinct titles can slugify to the same folder name ("Note!" and "Note?"
  // both become "note"); JSZip silently overwrites same-path members, which
  // would drop a note from the archive. Disambiguate with a numeric suffix.
  const usedSlugs = new Set<string>();

  for (const note of notes) {
    const base = slugify(note.title);
    let slug = base;
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
    usedSlugs.add(slug);
    const noteFolder = folder.folder(slug);
    if (!noteFolder) continue;

    // Rendered HTML copy and the markdown source live side by side.
    noteFolder.file(`${slug}.html`, await htmlForNote(note));
    noteFolder.file('README.md', noteMarkdownSource(note));

    // Attachments sit alongside the note's markdown/HTML.
    for (const att of note.attachments) {
      if (att.data.startsWith('data:')) {
        const base64 = att.data.split(',')[1];
        noteFolder.file(att.name, base64, { base64: true });
      }
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, 'notes-export.zip');
}
