import { test, expect, step, seedNotes, debugBreak, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Round K rich-rendering suite. Covers the heavy/lazy renderers gated by
 * detectContentFeatures in src/lib/db.ts and dispatched from NoteViewer:
 *   - mermaid (flowchart + sequence, invalid input)
 *   - BPMN renderer (labeled BPMN code block for readable XML)
 *   - GeoJSON (Leaflet map + markers)
 *   - 3D models (inline STL via data URL, orthographic projection, viewports)
 *   - code-block language matrix (runnable vs static, syntax highlighting)
 *
 * Heavy renderers are async and network/GPU dependent, so every assertion here
 * is expect-polling with generous timeouts (mermaid 15s, three.js 20s,
 * leaflet 20s). No toHaveScreenshot for dynamic renderers — only step() shots.
 */

function makeNote(overrides: Partial<NoteSeed> = {}): NoteSeed {
  const now = new Date();
  return {
    title: 'Untitled',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: ['2024-01-01'],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

/** Open a seeded note and switch it to view mode (where renderers mount). */
async function openNoteInView(page: Page, title: string): Promise<void> {
  await page.locator('div.group', { hasText: title }).click();
  await expect(page.getByRole('button', { name: 'View', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View', exact: true }).click();
}

/** Locate a CodeBlock by its language label (the header <span> text). */
function codeBlock(page: Page, lang: string) {
  return page.locator('.prose-notes div.relative', {
    has: page.getByText(lang, { exact: true }),
  });
}

// A minimal valid ASCII STL (a tetrahedron, 4 facets). STLLoader.parse accepts
// ASCII STL; Model3DBlock loads the source from a data: URL (see Model3DBlock.tsx
// loadModel: attachment -> data: -> fetch). We base64-encode it so the block
// content is a single-line data URL that needs no network.
const STL = `solid tetra
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 0 1
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 0 1 0
    vertex 0 0 1
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 1 0 0
    vertex 0 1 0
    vertex 0 0 1
  endloop
endfacet
endsolid tetra
`;
const STL_DATA_URL = 'data:application/octet-stream;base64,' + Buffer.from(STL).toString('base64');

test('renders multiple mermaid diagrams in one note', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Multi Mermaid',
      content: `# Multi Mermaid

\`\`\`mermaid
graph TD
    A[Start] --> B[Process]
    B --> C[End]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant Alice
    participant Bob
    Alice->>Bob: Hello
\`\`\`
`,
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Multi Mermaid');
  await debugBreak(page, 'multi-mermaid — two diagrams should render');

  // Both diagrams render asynchronously into <svg> elements. Scoped to
  // .mermaid-diagram; :not(.lucide) excludes the header tab icons.
  await expect(page.locator('.mermaid-diagram svg:not(.lucide)')).toHaveCount(2, { timeout: 15000 });
  await step(page, 'two-diagrams');
});

test('renders a mermaid sequence diagram', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Sequence',
      content: `# Sequence

\`\`\`mermaid
sequenceDiagram
    participant Alice
    participant Bob
    Alice->>Bob: Hello Bob, how are you?
    Bob-->>Alice: Great!
\`\`\`
`,
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Sequence');
  await debugBreak(page, 'sequence — participant labels should be in the svg');

  const svg = page.locator('.mermaid-diagram svg:not(.lucide)');
  await expect(svg).toBeVisible({ timeout: 15000 });
  // Participant names render as <text> inside the mermaid svg.
  await expect(svg).toContainText('Alice');
  await expect(svg).toContainText('Bob');
  await step(page, 'sequence');
});

test('handles invalid mermaid gracefully', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Bad Mermaid',
      content: `# Bad Mermaid

\`\`\`mermaid
graph TD; A-->
\`\`\`

This paragraph should still render.
`,
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Bad Mermaid');
  await debugBreak(page, 'invalid-mermaid — observe the error/fallback');

  // APP BEHAVIOR: MermaidBlock catches render errors and shows a
  // "Mermaid error: ..." banner (bg-destructive/10) instead of a raw fallback
  // or a blank area. The rest of the note still renders.
  await expect(page.getByText(/Mermaid error/)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.prose-notes', { hasText: 'This paragraph should still render.' })).toBeVisible();
  await step(page, 'invalid-mermaid');
});

test('renders BPMN blocks with a dedicated BPMN renderer', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'BPMN',
      content: `# BPMN

\`\`\`bpmn
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="p1" isExecutable="true">
    <startEvent id="start" />
    <endEvent id="end" />
  </process>
</definitions>
\`\`\`
`,
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'BPMN');
  await debugBreak(page, 'bpmn-renderer — diagram canvas should be visible');

  // APP BEHAVIOR: NoteViewer renders BPMN XML as an interactive diagram via
  // bpmn-js. The diagram mounts a .bjs-container canvas; the optional code view
  // is toggled with the "Code" tab.
  const bpmnBlock = page.locator('.prose-notes div.my-3', { hasText: 'BPMN' });
  await expect(bpmnBlock.locator('.bjs-container')).toBeVisible({ timeout: 20000 });
  // Optional code view.
  await bpmnBlock.getByRole('button', { name: 'Code' }).click();
  await expect(bpmnBlock).toContainText('startEvent');
  await bpmnBlock.getByRole('button', { name: 'Diagram Preview' }).click();
  await expect(bpmnBlock.locator('.bjs-container')).toBeVisible({ timeout: 20000 });
  await step(page, 'bpmn-renderer');
});

test('renders a geojson map with markers', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Geo Map',
      content: `# Geo Map

\`\`\`geojson
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Sydney" },
      "geometry": { "type": "Point", "coordinates": [151.2093, -33.8688] }
    },
    {
      "type": "Feature",
      "properties": { "name": "London" },
      "geometry": { "type": "Point", "coordinates": [-0.1276, 51.5074] }
    },
    {
      "type": "Feature",
      "properties": { "name": "New York" },
      "geometry": { "type": "Point", "coordinates": [-74.006, 40.7128] }
    }
  ]
}
\`\`\`
`,
      hasGeoJson: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Geo Map');
  await debugBreak(page, 'geojson-map — leaflet container + markers');

  // Leaflet mounts a .leaflet-container. Markers are DOM <img.leaflet-marker-icon>
  // elements independent of tile imagery (tiles may fail offline — we never
  // assert on tile pixels). Points are on different continents so they do not
  // cluster into a single cluster marker.
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(3, { timeout: 20000 });
  await step(page, 'geojson-map');
});

test('renders an inline STL model', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'STL Inline',
      content: `# STL Inline

\`\`\`3dmodel
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'STL Inline');
  await debugBreak(page, 'stl-canvas — three.js canvas should render');

  // Model3DBlock loads the data-URL STL and mounts a WebGL <canvas>.
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await step(page, 'stl-canvas');
});

test('applies orthographic projection frontmatter to a 3d model', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await seedNotes(page, [
    makeNote({
      title: 'Ortho Model',
      content: `# Ortho Model

\`\`\`3dmodel
---
projection: orthographic
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Ortho Model');
  await debugBreak(page, 'ortho-model — canvas should render without errors');

  // The DOM does not expose the camera type, so we assert what is assertable:
  // the model renders (canvas) and no severe console/page errors occurred.
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => errors).toEqual([]);
  await step(page, 'ortho-model');
});

test('renders a multi-viewport 3d grid', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Viewports',
      content: `# Viewports

\`\`\`3dmodel
---
viewports:
  - name: Isometric
  - name: Top View
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Viewports');
  await debugBreak(page, 'viewport-grid — two viewport labels should render');

  // The viewport sub-header renders each viewport's name once the model loads.
  await expect(page.getByText('Isometric', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Top View', { exact: true })).toBeVisible({ timeout: 20000 });
  await step(page, 'viewport-grid');
});

test('only runnable languages get a Run button', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Runners',
      content: `# Runners

\`\`\`js
console.log("hi")
\`\`\`

\`\`\`python
print("hi")
\`\`\`
`,
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Runners');
  await debugBreak(page, 'js-runnable — js has Run, python does not');

  // jsRunner registers 'js'/'javascript'; python has no runner (codeRunners.ts).
  await expect(codeBlock(page, 'js').getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(codeBlock(page, 'python').getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await step(page, 'js-runnable');
  await step(page, 'py-static');
});

test('syntax highlights multiple languages', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Multi Lang',
      content: `# Multi Lang

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`python
print("hi")
\`\`\`

\`\`\`html
<div>hi</div>
\`\`\`
`,
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Multi Lang');
  await debugBreak(page, 'multi-lang — three highlighted blocks with labels');

  // Each block renders a shiki-highlighted .shiki-wrapper with its language label.
  await expect(page.locator('.prose-notes .shiki-wrapper')).toHaveCount(3, { timeout: 15000 });
  await expect(codeBlock(page, 'ts')).toBeVisible();
  await expect(codeBlock(page, 'python')).toBeVisible();
  await expect(codeBlock(page, 'html')).toBeVisible();
  await step(page, 'multi-lang');
});
