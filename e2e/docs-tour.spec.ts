import { test, expect, seedNotes, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Round M — documentation tour.
 *
 * This spec is GATED: it only runs when E2E_DOCS=1 AND on the "chromium"
 * project. In a normal `npx playwright test` run every test here is skipped, so
 * the suite's runtime and git state are 100% unaffected.
 *
 * When it does run, it walks each major feature to its most photogenic,
 * deterministic state and captures PNGs with stable semantic filenames
 * directly into docs/images/. At the end it writes docs/FEATURES.md, so the
 * gallery page and its images regenerate together atomically.
 *
 * Run it with:  npm run docs:screenshots
 *           or:  E2E_DOCS=1 npx playwright test e2e/docs-tour.spec.ts --project=chromium
 *
 * No debugBreak here — this spec must run unattended.
 */

const IMAGES_DIR = path.join(process.cwd(), 'docs', 'images');
const DOCS_DIR = path.join(process.cwd(), 'docs');

// Fixed deterministic desktop viewport (the chromium project already uses
// 1440x900; this makes the intent explicit and guards against config drift).
test.use({ viewport: { width: 1440, height: 900 } });

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

// A minimal valid ASCII STL (a tetrahedron, 4 facets). Base64-encoded so the
// block content is a single-line data URL that needs no network.
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

/** Capture a screenshot directly into docs/images/<name>.png. */
async function shot(page: Page, name: string, opts?: { fullPage?: boolean }): Promise<string> {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const filePath = path.join(IMAGES_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: opts?.fullPage ?? false });
  console.log(`[docs] ${name}: ${filePath}`);
  return filePath;
}

/** Open a seeded note by title and wait for its header. */
async function openNote(page: Page, title: string): Promise<void> {
  await page.locator('div.group', { hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
}

/** Open a seeded note and switch it to view mode (where renderers mount). */
async function openNoteInView(page: Page, title: string): Promise<void> {
  await openNote(page, title);
  await page.getByRole('button', { name: 'View', exact: true }).click();
}

// ─── app-overview ──────────────────────────────────────────────────────────
test('captures app overview', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Welcome to Note Haven',
      content:
        '# Welcome to Note Haven\n\nYour notes live entirely in your browser. Write in Markdown, add tags, and organize by category.\n\n## Getting started\n\n- Type `/` for slash commands\n- Press **View** to render your note\n- Use the calendar to find notes by date',
      tags: ['guide', 'intro'],
      category: 'General',
      pinned: true,
    }),
    makeNote({ title: 'Meeting Notes', content: '# Meeting Notes\n\nDiscuss the Q3 roadmap and priorities.', tags: ['work'], category: 'Work' }),
    makeNote({ title: 'Grocery List', content: 'Buy milk, eggs, and bread.', tags: ['life'], category: 'Personal' }),
    makeNote({ title: 'Project Ideas', content: '# Project Ideas\n\nBrainstorm new features for the app.', tags: ['ideas'], category: 'Work' }),
  ]);
  await page.goto(APP_PATH);
  await openNote(page, 'Welcome to Note Haven');
  await shot(page, 'app-overview');
});

// ─── sidebar-search ──────────────────────────────────────────────────────────
test('captures sidebar search', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({ title: 'Meeting Notes', content: '# Meeting Notes\n\nDiscuss the Q3 roadmap.', tags: ['work'], category: 'Work' }),
    makeNote({ title: 'Grocery List', content: 'Buy milk, eggs, and bread.', tags: ['life'], category: 'Personal' }),
    makeNote({ title: 'Project Ideas', content: '# Project Ideas\n\nBrainstorm new features.', tags: ['ideas'], category: 'Work' }),
    makeNote({ title: 'Reading List', content: 'Books to read this month.', tags: ['life'], category: 'Personal' }),
  ]);
  await page.goto(APP_PATH);
  await page.getByPlaceholder('Search notes...').fill('meeting');
  await expect(page.getByText('Meeting Notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Grocery List', { exact: true })).toBeHidden();
  await shot(page, 'sidebar-search');
});

// ─── tag-filters ────────────────────────────────────────────────────────────
test('captures tag filters', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({ title: 'Meeting Notes', content: '# Meeting Notes\n\nDiscuss the Q3 roadmap.', tags: ['work'], category: 'Work' }),
    makeNote({ title: 'Project Ideas', content: '# Project Ideas\n\nBrainstorm new features.', tags: ['work'], category: 'Work' }),
    makeNote({ title: 'Grocery List', content: 'Buy milk, eggs, and bread.', tags: ['life'], category: 'Personal' }),
    makeNote({ title: 'Reading List', content: 'Books to read this month.', tags: ['life'], category: 'Personal' }),
  ]);
  await page.goto(APP_PATH);
  const sidebar = page.locator('div.w-72');
  await sidebar.getByRole('button', { name: 'Tags' }).click();
  await sidebar.getByRole('button', { name: 'work', exact: true }).click();
  await expect(sidebar.getByText('Meeting Notes', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Grocery List', { exact: true })).toBeHidden();
  await shot(page, 'tag-filters');
});

// ─── slash-commands ─────────────────────────────────────────────────────────
test('captures slash commands', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [makeNote({ title: 'Draft', content: '# Draft\n\n' })]);
  await page.goto(APP_PATH);
  await openNote(page, 'Draft');
  const editor = page.getByPlaceholder('Start writing... Type / for commands');
  await editor.click();
  await editor.press('End');
  await editor.press('Enter');
  await editor.type('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await shot(page, 'slash-commands');
});

// ─── markdown-view ──────────────────────────────────────────────────────────
test('captures markdown view', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Markdown Showcase',
      content:
        '# Markdown Showcase\n\nSome **bold** and *italic* text with a [link](https://example.com).\n\n## Lists\n\n- First item\n- Second item\n- Third item\n\n## Table\n\n| Feature | Status |\n| --- | --- |\n| Markdown | ✅ |\n| GFM tables | ✅ |\n| Callouts | ✅ |',
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Markdown Showcase');
  await expect(page.locator('.prose-notes table')).toBeVisible();
  await shot(page, 'markdown-view', { fullPage: true });
});

// ─── callouts ──────────────────────────────────────────────────────────────
test('captures callouts', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Callouts',
      content:
        '# Callouts\n\n> [!NOTE]\n> Useful information for the reader.\n\n> [!WARNING]\n> Be careful with this step.\n\n> [!TIP]\n> A helpful tip to make things easier.',
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Callouts');
  await expect(page.locator('.callout-note')).toBeVisible();
  await expect(page.locator('.callout-warning')).toBeVisible();
  await shot(page, 'callouts', { fullPage: true });
});

// ─── code-runner ────────────────────────────────────────────────────────────
test('captures code runner', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Code Runner',
      content:
        '# Code Runner\n\n```js\nconst greeting = "Hello, Note Haven!";\nconsole.log(greeting);\nconsole.log("2 + 2 =", 2 + 2);\n```',
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Code Runner');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/\[log\]: Hello, Note Haven!/)).toBeVisible({ timeout: 10000 });
  // Wait for shiki highlighting (pre.shiki) so the screenshot shows the final
  // syntax-highlighted state instead of the loading fallback.
  await expect(page.locator('.prose-notes pre.shiki').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'code-runner');
});

// ─── mermaid-diagram ────────────────────────────────────────────────────────
test('captures mermaid diagram', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Mermaid',
      content:
        '# Mermaid\n\n```mermaid\ngraph TD\n    A[Start] --> B[Process]\n    B --> C{Decision}\n    C -->|Yes| D[End]\n    C -->|No| B\n```',
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Mermaid');
  // The diagram SVG lives in the preview pane; :not(.lucide) excludes the
  // header tab icons, which are also svgs inside the block.
  await expect(page.locator('.mermaid-diagram svg:not(.lucide)')).toBeVisible({ timeout: 15000 });
  await shot(page, 'mermaid-diagram');
  // Toggle to the code view and capture it too.
  const mermaidBlock = page.locator('.mermaid-diagram').first();
  await mermaidBlock.getByRole('button', { name: 'Code' }).click();
  await expect(mermaidBlock).toContainText('graph TD');
  // Wait for shiki highlighting (pre.shiki) so the screenshot shows the final
  // readable state instead of the loading fallback.
  await expect(mermaidBlock.locator('pre.shiki').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'mermaid-code');
});

// ─── mermaid-diagram-types ──────────────────────────────────────────────────
test('captures mermaid diagram types', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Mermaid Types',
      content: `# Mermaid Types

## Sequence diagram

\`\`\`mermaid
sequenceDiagram
    Alice->>Bob: Hello Bob, how are you?
    Bob-->>Alice: Great, thanks for asking!
    Alice-)Bob: Talk later
\`\`\`

## Gantt chart

\`\`\`mermaid
gantt
    title Sprint Plan
    dateFormat  YYYY-MM-DD
    section Design
    Wireframes     :done, d1, 2024-01-01, 5d
    Prototype      :active, after d1, 4d
    section Build
    Implementation :2024-01-12, 10d
    Testing        :2024-01-22, 5d
\`\`\`

## Pie chart

\`\`\`mermaid
pie title Time spent per language
    "TypeScript" : 45
    "Python" : 30
    "Rust" : 25
\`\`\`

## State diagram

\`\`\`mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review: submit
    Review --> Published: approve
    Review --> Draft: request changes
    Published --> [*]
\`\`\`

## Entity relationship

\`\`\`mermaid
erDiagram
    NOTE ||--o{ TAG : tagged-with
    NOTE {
        string id PK
        string title
    }
    TAG {
        string name
    }
\`\`\``,
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Mermaid Types');
  // Every diagram type mounts its own MermaidBlock and renders an inline SVG.
  // :not(.lucide) excludes the header tab icons, which are also svgs.
  await expect(page.locator('.mermaid-diagram svg:not(.lucide)')).toHaveCount(5, { timeout: 20000 });
  // The note body scrolls in an inner container inside an h-screen app shell,
  // which clips fullPage shots. Relax overflow on it and every ancestor so the
  // whole stack of diagrams flows into the page and is captured.
  await page.evaluate(() => {
    let el: HTMLElement | null | undefined = document.querySelector('.prose-notes')?.parentElement;
    while (el && el !== document.body) {
      const overflow = getComputedStyle(el).overflow + getComputedStyle(el).overflowY;
      if (/auto|scroll|hidden/.test(overflow)) {
        el.style.overflow = 'visible';
        el.style.height = 'auto';
        el.style.flex = 'none';
      }
      el = el.parentElement;
    }
  });
  await shot(page, 'mermaid-diagram-types', { fullPage: true });
});

// ─── bpmn-diagram ───────────────────────────────────────────────────────────
test('captures BPMN renderer', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'BPMN',
      content: `# BPMN

\`\`\`bpmn
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI">
  <process id="order-process" isExecutable="true">
    <startEvent id="start" name="Order received" />
    <task id="review" name="Review order" />
    <exclusiveGateway id="gateway" name="In stock?" />
    <task id="ship" name="Ship order" />
    <task id="backorder" name="Backorder item" />
    <endEvent id="end" name="Order complete" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="review" />
    <sequenceFlow id="f2" sourceRef="review" targetRef="gateway" />
    <sequenceFlow id="f3" sourceRef="gateway" targetRef="ship" name="Yes" />
    <sequenceFlow id="f4" sourceRef="gateway" targetRef="backorder" name="No" />
    <sequenceFlow id="f5" sourceRef="ship" targetRef="end" />
    <sequenceFlow id="f6" sourceRef="backorder" targetRef="end" />
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="order-process">
      <bpmndi:BPMNShape id="start-shape" bpmnElement="start">
        <dc:Bounds x="120" y="180" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="review-shape" bpmnElement="review">
        <dc:Bounds x="220" y="160" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gateway-shape" bpmnElement="gateway">
        <dc:Bounds x="380" y="170" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ship-shape" bpmnElement="ship">
        <dc:Bounds x="500" y="120" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="backorder-shape" bpmnElement="backorder">
        <dc:Bounds x="500" y="240" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end-shape" bpmnElement="end">
        <dc:Bounds x="680" y="180" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f1-edge" bpmnElement="f1">
        <di:waypoint x="156" y="198" />
        <di:waypoint x="220" y="200" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2-edge" bpmnElement="f2">
        <di:waypoint x="320" y="200" />
        <di:waypoint x="380" y="195" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f3-edge" bpmnElement="f3">
        <di:waypoint x="405" y="170" />
        <di:waypoint x="500" y="160" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f4-edge" bpmnElement="f4">
        <di:waypoint x="405" y="220" />
        <di:waypoint x="500" y="280" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f5-edge" bpmnElement="f5">
        <di:waypoint x="600" y="160" />
        <di:waypoint x="680" y="198" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f6-edge" bpmnElement="f6">
        <di:waypoint x="600" y="280" />
        <di:waypoint x="680" y="216" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>
\`\`\``,
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'BPMN');
  const bpmnBlock = page.locator('.prose-notes div.my-3', {
    has: page.getByText('bpmn', { exact: true }),
  });
  await expect(bpmnBlock.locator('.bjs-container')).toBeVisible({ timeout: 20000 });
  await expect(bpmnBlock).toContainText('Order received');
  await expect(bpmnBlock).toContainText('In stock?');
  await expect(bpmnBlock).toContainText('Order complete');
  await shot(page, 'bpmn-diagram');
  // Toggle to the code view and capture it too.
  await bpmnBlock.getByRole('button', { name: 'Code' }).click();
  await expect(bpmnBlock).toContainText('order-process');
  // Wait for shiki highlighting (pre.shiki) so the screenshot shows the final
  // readable state instead of the loading fallback.
  await expect(bpmnBlock.locator('pre.shiki').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'bpmn-code');
});

// ─── geojson-map ────────────────────────────────────────────────────────────
test('captures geojson map', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
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
\`\`\``,
      hasGeoJson: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Geo Map');
  await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(3, { timeout: 20000 });
  // Wait for real map tiles, not just markers: tiles stream in asynchronously
  // and a shot taken too early shows a grey background (this regressed once).
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible({ timeout: 20000 });
  await shot(page, 'geojson-map');
  // Toggle to the code view and capture it too.
  const geoBlock = page.locator('.prose-notes div.my-3', { hasText: 'geojson' });
  await geoBlock.getByRole('button', { name: 'Code' }).click();
  await expect(geoBlock).toContainText('FeatureCollection');
  await expect(geoBlock.locator('pre.shiki').first()).toBeVisible({ timeout: 15000 });
  await shot(page, 'geojson-code');
});

// ─── model-3d ───────────────────────────────────────────────────────────────
test('captures 3d model', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: '3D Model',
      content: `# 3D Model

\`\`\`3dmodel
${STL_DATA_URL}
\`\`\``,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, '3D Model');
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await shot(page, 'model-3d');
});

// ─── model-3d-viewports ─────────────────────────────────────────────────────
test('captures 3d viewports', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Viewports',
      content: `# Viewports

\`\`\`3dmodel
---
viewports:
  - name: Isometric
    camera: [1.5, 1.5, 1.5]
    mode: Solid
  - name: Top View
    camera: [0, 2, 0]
    mode: Wireframe
    projection: orthographic
---
${STL_DATA_URL}
\`\`\``,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Viewports');
  await expect(page.getByText('Isometric', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Top View', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.prose-notes canvas')).toHaveCount(2, { timeout: 20000 });
  await shot(page, 'model-3d-viewports');
});

// ─── model-3d-frozen ─────────────────────────────────────────────────────────
test('captures frozen 3d viewport', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [
    makeNote({
      title: 'Frozen',
      content: `# Frozen

\`\`\`3dmodel
---
pan: false
zoom: false
drag: false
grab: false
---
${STL_DATA_URL}
\`\`\``,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await openNoteInView(page, 'Frozen');
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  // Frozen viewport: no control pads render.
  await expect(page.getByRole('button', { name: 'Zoom In' })).toHaveCount(0);
  await shot(page, 'model-3d-frozen');
});

// ─── calendar-view ──────────────────────────────────────────────────────────
test('captures calendar view', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const day = (offset: number) => new Date(now.getTime() - offset * 86400000);
  const key = (offset: number) => day(offset).toISOString().slice(0, 10);
  await seedNotes(page, [
    makeNote({ title: 'Today', content: '# Today\n\nToday body', editDates: [todayKey], createdAt: now, updatedAt: now }),
    makeNote({ title: 'Yesterday', content: '# Yesterday\n\nBody', editDates: [key(1)], createdAt: day(1), updatedAt: day(1) }),
    makeNote({ title: 'Three Days Ago', content: '# Three Days Ago\n\nBody', editDates: [key(3)], createdAt: day(3), updatedAt: day(3) }),
    makeNote({ title: 'A Week Ago', content: '# A Week Ago\n\nBody', editDates: [key(7)], createdAt: day(7), updatedAt: day(7) }),
    makeNote({ title: 'Two Weeks Ago', content: '# Two Weeks Ago\n\nBody', editDates: [key(14)], createdAt: day(14), updatedAt: day(14) }),
  ]);
  await page.goto(APP_PATH);
  await page.getByTitle('Calendar view').click();
  await expect(page.getByText('Calendar', { exact: true })).toBeVisible();
  await expect(page.locator('div.grid.grid-cols-7.flex-1 > div').first()).toBeVisible();
  await shot(page, 'calendar-view');
});

// ─── encryption-locked ───────────────────────────────────────────────────────
test('captures encryption locked', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [makeNote({ title: 'Secret', content: '# Secret\n\nTop secret body' })]);
  await page.goto(APP_PATH);
  await openNote(page, 'Secret');
  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await page.getByPlaceholder('Min 8 characters').fill('correct horse battery staple');
  await page.getByPlaceholder('Confirm password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
  // Wait for the success toast to fade so the shot is clean.
  await expect(page.getByText('Note encrypted')).toBeHidden({ timeout: 10000 });
  await shot(page, 'encryption-locked');
});

// ─── encryption-dialog ───────────────────────────────────────────────────────
test('captures encryption dialog', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await seedNotes(page, [makeNote({ title: 'Secret', content: '# Secret\n\nTop secret body' })]);
  await page.goto(APP_PATH);
  await openNote(page, 'Secret');
  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  const dialog = page.locator('div.fixed.inset-0.z-50');
  await expect(dialog.getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Key Pairs' }).click();
  await shot(page, 'encryption-dialog');
});

// ─── empty-state ────────────────────────────────────────────────────────────
test('captures empty state', async ({ page }) => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  await page.goto(APP_PATH);
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();
  await shot(page, 'empty-state');
});

// ─── FEATURES.md writer (runs last, after every screenshot) ─────────────────
test('writes the feature gallery', async () => {
  test.skip(
    !process.env.E2E_DOCS || test.info().project.name !== 'chromium',
    'docs tour runs only with E2E_DOCS=1 on the chromium project'
  );
  const md = buildFeaturesMd();
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, 'FEATURES.md'), md);
  expect(fs.existsSync(path.join(DOCS_DIR, 'FEATURES.md'))).toBe(true);
});

// ─── FEATURES.md content ─────────────────────────────────────────────────────
interface GallerySection {
  file: string;
  title: string;
  caption: string;
}

const GALLERY: GallerySection[] = [
  {
    file: 'app-overview',
    title: 'Your Notes at a Glance',
    caption:
      'The main workspace pairs a searchable sidebar with a full Markdown editor. Notes are stored entirely in your browser, so everything you write stays on your device.',
  },
  {
    file: 'sidebar-search',
    title: 'Find Anything Instantly',
    caption:
      'Real-time full-text search narrows your notes as you type, so you can jump straight to the note you need without scrolling.',
  },
  {
    file: 'tag-filters',
    title: 'Organize with Tags',
    caption:
      'Tags and categories let you group related notes. Expand the Tags facet and click a tag to filter the list down to just those notes.',
  },
  {
    file: 'slash-commands',
    title: 'Write Faster with Slash Commands',
    caption:
      'Type `/` in the editor to open a command palette for inserting code blocks, headings, lists, and more without leaving the keyboard.',
  },
  {
    file: 'markdown-view',
    title: 'Beautiful Markdown Rendering',
    caption:
      'Switch to View mode to see your Markdown rendered with headings, bold and italic text, lists, links, and GitHub-flavored tables.',
  },
  {
    file: 'callouts',
    title: 'Callouts for Emphasis',
    caption:
      'Obsidian-style callouts like `> [!NOTE]` and `> [!WARNING]` add styled highlights that draw attention to important information.',
  },
  {
    file: 'code-runner',
    title: 'Run Code in Your Notes',
    caption:
      'JavaScript code blocks can be executed right inside a note. Press Run to see the output — including `console.log` — without leaving the page.',
  },
  {
    file: 'mermaid-diagram',
    title: 'Live Diagrams with Mermaid',
    caption:
      'Write Mermaid syntax in a fenced code block and Note Haven renders it as a flowchart, sequence diagram, or other diagram directly in your note.',
  },
  {
    file: 'mermaid-code',
    title: 'Mermaid Source View',
    caption:
      'Toggle to the code view to inspect the underlying Mermaid syntax directly, alongside the rendered diagram.',
  },
  {
    file: 'mermaid-diagram-types',
    title: 'More Mermaid Diagram Types',
    caption:
      'Sequence, gantt, pie, state, and entity-relationship diagrams all render natively — each fenced `mermaid` block becomes a live diagram in your note.',
  },
  {
    file: 'bpmn-diagram',
    title: 'Readable BPMN Workflows',
    caption:
      'BPMN XML is recognized as a dedicated renderer and presented in a labeled, readable block so workflow definitions stay easy to inspect in your notes.',
  },
  {
    file: 'bpmn-code',
    title: 'BPMN Source View',
    caption:
      'Toggle to the code view to inspect the underlying BPMN XML directly, alongside the rendered diagram.',
  },
  {
    file: 'geojson-map',
    title: 'Interactive Maps',
    caption:
      'Paste GeoJSON into a code block to render an interactive map with markers. Great for trip plans, field notes, or anything location-based.',
  },
  {
    file: 'geojson-code',
    title: 'GeoJSON Source View',
    caption:
      'Toggle to the code view to inspect the underlying GeoJSON directly, alongside the rendered map.',
  },
  {
    file: 'model-3d',
    title: '3D Models in Your Notes',
    caption:
      'Embed STL or OBJ models and explore them in 3D. Orbit, pan, and zoom with the on-screen controls, all rendered locally in your browser.',
  },
  {
    file: 'model-3d-viewports',
    title: 'CAD-Style Multi-Viewports',
    caption:
      'Configure multiple viewports with different cameras and render modes — like a CAD workspace — to inspect a model from several angles at once.',
  },
  {
    file: 'model-3d-frozen',
    title: 'Frozen Viewports',
    caption:
      'A viewport can be frozen so the model is shown at a fixed angle with no controls, perfect for a clean, presentation-ready view.',
  },
  {
    file: 'calendar-view',
    title: 'A Calendar of Your Notes',
    caption:
      'The calendar view shows which notes you edited on each day, so you can retrace your writing history and find notes by date.',
  },
  {
    file: 'encryption-locked',
    title: 'Keep Notes Private',
    caption:
      'Encrypt a note with a password and it locks immediately. Its contents are hidden until you unlock it, keeping sensitive information safe.',
  },
  {
    file: 'encryption-dialog',
    title: 'Manage Encryption Keys',
    caption:
      'Beyond passwords, Note Haven supports RSA key pairs. Generate, import, and export keys to keep your encrypted notes accessible across devices.',
  },
  {
    file: 'empty-state',
    title: 'Start Fresh',
    caption:
      'A clean first-run state greets you with a single button to create your first note — no setup, no account, no cloud.',
  },
];

function buildFeaturesMd(): string {
  const lines: string[] = [];
  lines.push('# Note Haven — Feature Gallery');
  lines.push('');
  lines.push(
    'Note Haven is a local-first, privacy-focused Markdown note-taking app. Your notes live in your browser, and you can write, render, diagram, map, model, and encrypt them all in one place.'
  );
  lines.push('');
  lines.push('> These screenshots are captured automatically by the Playwright documentation tour. See the [Testing](#testing) section below to regenerate them.');
  lines.push('');
  for (const section of GALLERY) {
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(`![${section.title}](images/${section.file}.png)`);
    lines.push('');
    lines.push(section.caption);
    lines.push('');
  }
  lines.push('## Testing');
  lines.push('');
  lines.push(
    'The gallery is produced by the E2E documentation tour, which walks each feature to a deterministic state and captures the screenshots above. The images and this page are generated together, so they always stay in sync.'
  );
  lines.push('');
  lines.push('Regenerate the gallery with:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run docs:screenshots');
  lines.push('```');
  lines.push('');
  lines.push(
    'This runs `E2E_DOCS=1 playwright test e2e/docs-tour.spec.ts --project=chromium`. The tour is gated behind the `E2E_DOCS` environment variable, so a normal `npm run test:e2e` run skips it entirely and never touches `docs/`.'
  );
  lines.push('');
  return lines.join('\n');
}
