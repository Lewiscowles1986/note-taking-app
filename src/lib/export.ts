import type { Note } from './db';
import { saveAs } from 'file-saver';
import { exportViewToHtml } from './exportView';

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

/**
 * Build the HTML for a single note: capture the live rendered view when it is
 * on screen (preserves graphics: mermaid/BPMN/chart SVG, maps, 3D models, code
 * highlighting, images), otherwise fall back to a plain markdown conversion.
 */
function htmlForNote(note: Note): string {
  return exportViewToHtml(note) ?? noteToHtml(note);
}

export function exportToHtml(note: Note) {
  const html = htmlForNote(note);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  saveAs(blob, `${note.title.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

export function exportToPdf(note: Note) {
  const html = htmlForNote(note);
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

  for (const note of notes) {
    const slug = slugify(note.title);
    const noteFolder = folder.folder(slug);
    if (!noteFolder) continue;

    // Rendered HTML copy and the markdown source live side by side.
    noteFolder.file(`${slug}.html`, noteToHtml(note));
    noteFolder.file('README.md', `# ${note.title}\n\nTags: ${note.tags.join(', ')}\nCategory: ${note.category}\n\n${note.content}`);

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
