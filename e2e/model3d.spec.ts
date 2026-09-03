import { test, expect, step, seedNotes, debugBreak, type NoteSeed } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Round L — full Model3DBlock option surface.
 *
 * Pins the DOM-assertable behavior of src/components/Model3DBlock.tsx:
 *   - default single "Default" viewport inheriting global config
 *   - multiple viewports with distinct names / cameras
 *   - per-viewport mode (Solid / Surface Angle / Wireframe) + switching
 *   - frozen viewports (pan/zoom/drag/grab disabled -> no control pads)
 *   - default interactive pads
 *   - per-viewport projection (perspective vs orthographic)
 *   - y-up coordinate system
 *   - planar uvProjection
 *   - texture override via data URL
 *
 * three.js is async + GPU dependent, so every assertion is expect-polling with
 * a 20s canvas timeout. No toHaveScreenshot for 3D — only step() shots.
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

/** Collect console errors + pageerrors; assert empty at the end of a test. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/**
 * Locate a viewport container by its sub-header name. Each viewport renders as
 * a `div.relative.flex.flex-col` (the outer block is `relative` but NOT
 * `flex flex-col`, so this selector is unambiguous).
 */
function viewport(page: Page, name: string) {
  return page.locator('div.relative.flex.flex-col', {
    has: page.getByText(name, { exact: true }),
  });
}

/** The mode button inside a viewport (Solid / Surface Angle / Wireframe). */
function modeButton(page: Page, vpName: string, mode: string) {
  return viewport(page, vpName).getByRole('button', { name: mode, exact: true });
}

// A minimal valid ASCII STL (a tetrahedron, 4 facets). STLLoader.parse accepts
// ASCII STL; Model3DBlock loads the source from a data: URL. Base64-encoded so
// the block content is a single-line data URL that needs no network.
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

// A valid 1x1 transparent PNG for the texture-override test.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('defaults to a single Default viewport inheriting global config', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Default VP',
      content: `# Default VP

\`\`\`3dmodel
---
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Default VP');
  await debugBreak(page, 'default-viewport — one "Default" sub-header, Solid active');

  // No `viewports` key -> viewportsList falls back to a single viewport named
  // "Default" that inherits the global camera/mode.
  await expect(page.getByText('Default', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.prose-notes canvas')).toHaveCount(1, { timeout: 20000 });
  // mode defaults to 'Solid' -> the Solid button carries the active styling.
  await expect(modeButton(page, 'Default', 'Solid')).toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Default', 'Wireframe')).not.toHaveClass(/bg-slate-900/);
  await step(page, 'default-viewport');
  await expect.poll(() => errors).toEqual([]);
});

test('renders multiple viewports with different cameras', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Multi Camera',
      content: `# Multi Camera

\`\`\`3dmodel
---
viewports:
  - name: Front
    camera: [0, 0, 20]
  - name: Side
    camera: [20, 0, 0]
  - name: Top
    camera: [0, 20, 0]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Multi Camera');
  await debugBreak(page, 'multi-camera — three viewport sub-headers + three canvases');

  // Each viewport renders its own sub-header name and its own canvas.
  await expect(page.getByText('Front', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Side', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Top', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.prose-notes canvas')).toHaveCount(3, { timeout: 20000 });
  await step(page, 'multi-camera');
  await expect.poll(() => errors).toEqual([]);
});

test('supports per-viewport mode configurations', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Mixed Modes',
      content: `# Mixed Modes

\`\`\`3dmodel
---
viewports:
  - name: Wire VP
    mode: Wireframe
  - name: Solid VP
    mode: Solid
  - name: Angle VP
    mode: Surface Angle
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Mixed Modes');
  await debugBreak(page, 'mixed-modes — each sub-header shows its configured mode active');

  await expect(page.locator('.prose-notes canvas')).toHaveCount(3, { timeout: 20000 });
  // Each viewport's renderMode initializes from its own config.mode.
  await expect(modeButton(page, 'Wire VP', 'Wireframe')).toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Solid VP', 'Solid')).toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Angle VP', 'Surface Angle')).toHaveClass(/bg-slate-900/);
  // The non-configured modes are NOT active in each viewport.
  await expect(modeButton(page, 'Wire VP', 'Solid')).not.toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Solid VP', 'Wireframe')).not.toHaveClass(/bg-slate-900/);
  await step(page, 'mixed-modes');
  await expect.poll(() => errors).toEqual([]);
});

test('switches a viewport mode via its buttons', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Mode Switch',
      content: `# Mode Switch

\`\`\`3dmodel
---
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Mode Switch');
  await debugBreak(page, 'mode-switched — click Wireframe then back to Solid');

  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await expect(modeButton(page, 'Default', 'Solid')).toHaveClass(/bg-slate-900/);

  // Click Wireframe -> active state moves to Wireframe.
  await modeButton(page, 'Default', 'Wireframe').click();
  await expect(modeButton(page, 'Default', 'Wireframe')).toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Default', 'Solid')).not.toHaveClass(/bg-slate-900/);
  await step(page, 'mode-switched-wireframe');

  // Click back to Solid -> active state returns.
  await modeButton(page, 'Default', 'Solid').click();
  await expect(modeButton(page, 'Default', 'Solid')).toHaveClass(/bg-slate-900/);
  await expect(modeButton(page, 'Default', 'Wireframe')).not.toHaveClass(/bg-slate-900/);
  await step(page, 'mode-switched-solid');
  await expect.poll(() => errors).toEqual([]);
});

test('freezes a viewport when pan zoom and drag are disabled', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Frozen',
      content: `# Frozen

\`\`\`3dmodel
---
camera: [0, 0, 20]
pan: false
zoom: false
drag: false
grab: false
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Frozen');
  await debugBreak(page, 'frozen — no control pads should render');

  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  const vp = viewport(page, 'Default');

  // canRotate = drag !== false (false), canPan = pan !== false (false),
  // canZoom = zoom !== false (false), showReset = false -> NO pads at all.
  await expect(vp.getByRole('button', { name: 'Zoom In' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Zoom Out' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Orbit Left' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Pan Left' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Reset Camera View' })).toHaveCount(0);
  await step(page, 'frozen-pads');

  // A wheel event on the frozen canvas must not crash the app.
  await vp.locator('canvas').dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.locator('.prose-notes canvas')).toBeVisible();
  await step(page, 'frozen-wheel');
  await expect.poll(() => errors).toEqual([]);
});

test('keeps interactions enabled by default', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Interactive',
      content: `# Interactive

\`\`\`3dmodel
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Interactive');
  await debugBreak(page, 'interactive — pads present, click zoom-in');

  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  const vp = viewport(page, 'Default');

  // Defaults: pan/zoom/drag all enabled -> orbit, pan, and zoom pads render.
  await expect(vp.getByRole('button', { name: 'Zoom In' })).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Orbit Left' })).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Pan Left' })).toBeVisible();
  await step(page, 'interactive-pads');

  // Clicking a pad must not error and the canvas stays live.
  await vp.getByRole('button', { name: 'Zoom In' }).click();
  await expect(page.locator('.prose-notes canvas')).toBeVisible();
  await step(page, 'interactive-zoomed');
  await expect.poll(() => errors).toEqual([]);
});

test('per-viewport projection configurations', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Mixed Projection',
      content: `# Mixed Projection

\`\`\`3dmodel
---
viewports:
  - name: Persp
    projection: perspective
  - name: Ortho
    projection: orthographic
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Mixed Projection');
  await debugBreak(page, 'mixed-projection — two canvases, no errors');

  // APP BEHAVIOR: the camera type (perspective vs orthographic) is NOT exposed
  // in the DOM — Model3DViewport builds the camera inside the WebGL effect and
  // never writes a data attribute. What IS assertable: both viewports render
  // (one canvas each) and no severe console/page errors occur.
  await expect(page.getByText('Persp', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Ortho', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.prose-notes canvas')).toHaveCount(2, { timeout: 20000 });
  await step(page, 'mixed-projection');
  await expect.poll(() => errors).toEqual([]);
});

test('applies the y-up coordinate system without crashing', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Y Up',
      content: `# Y Up

\`\`\`3dmodel
---
system: y-up
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Y Up');
  await debugBreak(page, 'y-up — canvas renders without errors');

  // APP BEHAVIOR: `system` only gates `model.rotation.x = -PI/2` inside the
  // WebGL scene — it is not reflected in the DOM. Assertable signal is limited
  // to: the model renders (canvas) and no severe errors occur.
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await step(page, 'y-up');
  await expect.poll(() => errors).toEqual([]);
});

test('applies planar uvProjection without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'UV Planar',
      content: `# UV Planar

\`\`\`3dmodel
---
uvProjection: planar-x
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'UV Planar');
  await debugBreak(page, 'uv-planar — canvas renders without errors');

  // APP BEHAVIOR: uvProjection only rewrites the geometry's UV attribute before
  // rendering — not DOM-observable. Assertable: canvas renders, no errors.
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await step(page, 'uv-planar');
  await expect.poll(() => errors).toEqual([]);
});

test('applies a texture override via data URL', async ({ page }) => {
  const errors = collectErrors(page);
  await seedNotes(page, [
    makeNote({
      title: 'Textured',
      content: `# Textured

\`\`\`3dmodel
---
texture: ${PNG_1x1}
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
      hasModel3D: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await openNoteInView(page, 'Textured');
  await debugBreak(page, 'textured — canvas renders, texture loads async');

  // Texture loading is async (THREE.TextureLoader on a data URL). If it fails,
  // loadModel rejects and Model3DBlock shows the error banner instead of a
  // canvas. So: canvas visible + no severe errors proves the texture applied.
  await expect(page.locator('.prose-notes canvas')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('3D Model Rendering Error')).toHaveCount(0);
  await step(page, 'textured');
  await expect.poll(() => errors).toEqual([]);
});
