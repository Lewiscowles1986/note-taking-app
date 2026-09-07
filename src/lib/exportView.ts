// Live note-view capture for the print / HTML / PDF exporters.
//
// The single-note HTML, print and PDF exporters used to convert the raw
// markdown (`note.content`) with a handful of regexes, which stripped out every
// graphic (mermaid / BPMN / chart SVGs, GeoJSON maps, 3D models, code
// highlighting, images). This module instead captures the note view that is
// actually rendered on screen (via `NoteViewer`) and turns it into a
// self-contained HTML document:
//
//   * inline SVG (mermaid, BPMN, charts, …) is preserved as vector markup,
//   * `<canvas>` elements (3D model viewports, …) are snapped to embedded
//     `<img data-url>`s,
//   * the app's compiled CSS is inlined so the document renders standalone,
//   * everything is wrapped in a complete `<!DOCTYPE html>…` document.
//
// This requires the note to be open in "View" mode at the moment of export so
// that the rendered DOM actually exists; the consumers in `export.ts` fall back
// to a plain-text conversion when no live view is present.
import type { Note } from './db';

// The rendered content node that is currently visible. `NoteViewer` keeps this
// up to date through a ref.
let exportRoot: HTMLElement | null = null;

export function registerExportRoot(el: HTMLElement | null): void {
  exportRoot = el;
}

export function getExportRoot(): HTMLElement | null {
  return exportRoot;
}

/**
 * Concatenate the current document's own stylesheet rules into one CSS string
 * so the exported page is self-contained. Cross-origin sheets (which throw
 * when their rules are read) are skipped silently.
 */
function collectStyles(): string {
  const parts: string[] = [];
  for (let i = 0; i < document.styleSheets.length; i++) {
    const sheet = document.styleSheets[i];
    try {
      const rules = Array.from(sheet.cssRules);
      for (const rule of rules) parts.push(rule.cssText);
    } catch {
      // Cross-origin stylesheet — cannot be read; ignore.
    }
  }
  return parts.join('\n');
}

/**
 * Replace a canvas with an embedded image snapshot of its current pixels.
 * Returns true when the canvas was replaced.
 */
function rasterizeCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    if (!canvas.width || !canvas.height) return false;
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || dataUrl === 'data:,') return false;
    const img = document.createElement('img');
    img.alt = 'rendered graphic';
    img.setAttribute('style', 'max-width:100%; height:auto; display:block;');
    img.setAttribute('src', dataUrl);
    canvas.parentNode?.replaceChild(img, canvas);
    return true;
  } catch {
    // Canvas pixels are not readable (e.g. WebGL without a preserved buffer);
    // leave the canvas in place rather than raising.
    return false;
  }
}

/**
 * Serialize a (cloned) element to markup, snapping any canvas elements to
 * images so their rendered graphics survive the export.
 */
function serializeViewNode(node: HTMLElement): string {
  const clone = node.cloneNode(true) as HTMLElement;
  for (const canvas of Array.from(clone.querySelectorAll('canvas'))) {
    rasterizeCanvas(canvas as HTMLCanvasElement);
  }
  return clone.outerHTML;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      default: return '&quot;';
    }
  });
}

/**
 * Build a self-contained HTML document from the live note view, or `null`
 * when there is no rendered view available (e.g. not in View mode).
 */
export function exportViewToHtml(note: Note): string | null {
  const root = getExportRoot();
  if (!root) return null;

  const styles = collectStyles();
  const body = serializeViewNode(root);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(note.title)}</title>
  <style>${styles}</style>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; color: #1f2937; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    .note-export-root { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem; }
    @media print {
      .note-export-root { max-width: 100%; padding: 0; }
      .note-export-ui, button, .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <main class="note-export-root">${body}</main>
</body>
</html>`;
}
