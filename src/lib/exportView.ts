// Rich note-view capture for the print / HTML / PDF / ZIP exporters.
//
// Earlier exporters converted the raw markdown (`note.content`) with regexes,
// which stripped out every graphic (mermaid / BPMN / chart SVGs, GeoJSON maps,
// 3D models, code highlighting, images). This module instead renders the note
// through the real `NoteViewer` viewer OFF-SCREEN (regardless of what mode the
// UI is in, or which note is currently open), waits for the async graphics to
// settle, and captures the result into a self-contained HTML document:
//
//   * inline SVG (mermaid, BPMN, charts, …) is preserved as vector markup,
//   * `<canvas>` elements (3D model viewports, …) are snapped to embedded
//     `<img data-url>`s,
//   * the app's compiled CSS is inlined so the document renders standalone,
//   * everything is wrapped in a complete `<!DOCTYPE html>…` document.
//
// `renderNoteViewToHtml` returns `null` if rendering could not be completed
// (e.g. browser restrictions), and the callers in `export.ts` fall back to a
// plain-text conversion.
import { createElement } from 'react';
import type { Note } from './db';

// Give slower widgets (e.g. larger 3D models / map tiles) time to finish
// rendering before the off-screen capture is taken.
const DEFAULT_SETTLE_MS = import.meta.env.MODE === 'test' ? 5 : 1200;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      window.setTimeout(resolve, 16);
    }
  });
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

interface WebGLSnapshot {
  renderer: { render(scene: unknown, camera: unknown): void };
  scene: unknown;
  camera: unknown;
}

/**
 * Replace a canvas with an embedded image snapshot of its current pixels.
 * Returns true when the canvas was replaced.
 */
function rasterizeCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    if (!canvas.width || !canvas.height) return false;
    // For WebGL (e.g. the 3D model viewport) force a synchronous draw on the
    // live three.js renderer first: Chromium does not present frames for
    // invisible/off-viewport canvases, so toDataURL() would otherwise return a
    // blank image.
    const snapshot = (canvas as HTMLCanvasElement & { __webglSnapshot?: WebGLSnapshot }).__webglSnapshot;
    if (snapshot) {
      try {
        snapshot.renderer.render(snapshot.scene, snapshot.camera);
      } catch {
        // Fall through to whatever the buffer currently holds.
      }
    }
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || dataUrl === 'data:,') return false;
    const img = document.createElement('img');
    img.alt = 'rendered graphic';
    img.setAttribute('style', 'max-width:100%; height:auto; display:block;');
    img.setAttribute('src', dataUrl);
    canvas.parentNode?.replaceChild(img, canvas);
    return true;
  } catch {
    // Canvas pixels are not readable (e.g. a WebGL buffer that cannot be
    // preserved); leave the canvas in place rather than raising.
    return false;
  }
}

/**
 * Serialize an element to markup, snapping any canvas elements to images so
 * their rendered graphics survive the export. The caller's node may be a
 * throwaway off-screen container, so canvases are rasterized in place (after a
 * synchronous WebGL draw that reads live renderer references) before reading
 * the markup.
 */
function serializeViewNode(node: HTMLElement): string {
  for (const canvas of Array.from(node.querySelectorAll('canvas'))) {
    rasterizeCanvas(canvas as HTMLCanvasElement);
  }
  // Drop the non-functional interactive 3D control chrome (rotation / pan /
  // zoom / reset overlays, the render-mode switcher, the model-name bar and
  // the download button) from the exported markup — they rely on live JS/WebGL
  // state and would render as dead buttons over the model. Matched by the
  // stable `model3d-export-ui` class (also hidden by CSS in the exported
  // stylesheet as a fallback). The rasterized model image the canvas was
  // replaced with above is what carries the graphics.
  for (const ctl of Array.from(node.querySelectorAll('.model3d-export-ui'))) {
    ctl.remove();
  }
  return node.outerHTML;
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

/** Wrap captured view markup in a standalone, print-friendly HTML document. */
function wrapDocument(title: string, styles: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; color: #1f2937; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    .note-export-root { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem; }
    /* Interactive 3D control chrome (model-name bar, viewport bar, rotation /
       pan / zoom / reset overlays, download button) has no function in a
       static export. Fallback hide (primary path strips it from the markup). */
    .model3d-export-ui { display: none !important; }
    @media print {
      .note-export-root { max-width: 100%; padding: 0; }
      button, .note-export-ui, .no-print { display: none !important; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <main class="note-export-root">${body}</main>
</body>
</html>`;
}

/**
 * Wait for the rendered view to settle after mount: let lazy code-split blocks
 * commit, webfonts load, images decode, and async graphic effects (mermaid,
 * shiki, three, leaflet) finish.
 */
async function settle(container: HTMLElement, settleMs: number): Promise<void> {
  await nextFrame();
  await nextFrame();
  const fontsReady = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  if (fontsReady) {
    try {
      await fontsReady;
    } catch {
      // Ignore font-loading failures.
    }
  }
  const images = Array.from(container.querySelectorAll('img'));
  await Promise.allSettled(
    images.map((img) => {
      if (img.complete) return undefined;
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      });
    })
  );
  await new Promise((resolve) => setTimeout(resolve, settleMs));
}

/**
 * Render a note off-screen through the real viewer and capture it as a
 * self-contained HTML document. Returns `null` on any failure.
 */
export async function renderNoteViewToHtml(
  note: Note,
  settleMs: number = DEFAULT_SETTLE_MS
): Promise<string | null> {
  const [{ createRoot }, { default: NoteViewer }] = await Promise.all([
    import('react-dom/client'),
    import('@/components/NoteViewer'),
  ]);

  // Keep the container ON-SCREEN (behind everything, invisible) rather than
  // translated off the viewport: Chromium culls painting for off-viewport
  // elements, so a WebGL canvas there never reaches its drawing buffer and
  // `toDataURL()` returns a blank image. A transparent, non-interactive layer
  // still composites and presents WebGL frames we can snapshot.
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed; top:0; left:0; width:860px; opacity:0; pointer-events:none;';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  const root = createRoot(container);
  try {
    root.render(createElement(NoteViewer, { note }));
    await settle(container, settleMs);
    const content = container.querySelector<HTMLElement>('.prose-notes');
    if (!content) return null;
    return wrapDocument(note.title, collectStyles(), serializeViewNode(content));
  } catch {
    return null;
  } finally {
    try {
      root.unmount();
    } catch {
      // Ignore unmount failures.
    }
    container.remove();
  }
}
