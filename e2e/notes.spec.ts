import { test, expect, step, seedNotes, debugBreak, type NoteSeed, APP_PATH } from './fixtures';

/**
 * Round B note-management suite. Covers pin/unpin, delete, tag add/remove,
 * category change + filter, sidebar collapse, note switching, and tag/category
 * facets. Uses the shared freshDb/seedNotes/step helpers from fixtures.ts.
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

// The sidebar root (w-72) — used to scope filter-chip clicks away from the
// meta bar, which can show the same category/tag text.
const sidebar = (page: import('@playwright/test').Page) => page.locator('div.w-72');

test('pins and unpins a note from the sidebar', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nAlpha body', updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nBeta body', updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'Gamma', content: '# Gamma\n\nGamma body', updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before pinning');

  // Gamma is last (oldest updatedAt). Pin it and it should jump to the top.
  const gammaItem = page.locator('div.group', { hasText: 'Gamma' });
  // The pinned indicator is the pin icon in the title row (distinct from the
  // hover-revealed pin button, which lives in a different div).
  const pinIndicator = gammaItem.locator('div.flex.items-center.gap-1\\.5 svg.lucide-pin');
  await gammaItem.hover();
  await gammaItem.getByRole('button', { name: 'Pin' }).click();

  // Pinned indicator visible and Gamma moves to the top of the list.
  await expect(pinIndicator).toBeVisible();
  await expect(page.locator('div.group').first()).toContainText('Gamma');
  await step(page, 'pinned');

  // Unpin: indicator gone, pin button flips back to "Pin".
  // NOTE: order does NOT revert to updatedAt desc because updateNote bumps
  // updatedAt to now on every save, so Gamma stays newest after unpinning.
  await gammaItem.hover();
  await gammaItem.getByRole('button', { name: 'Unpin' }).click();
  await expect(pinIndicator).toBeHidden();
  await expect(gammaItem.getByRole('button', { name: 'Pin' })).toBeVisible();
  await step(page, 'unpinned');
});

test('deletes a note', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Doomed', content: '# Doomed\n\nDelete me' })]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Doomed' }).click();
  await expect(page.getByRole('heading', { name: 'Doomed', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before delete');
  await step(page, 'before-delete');

  const doomedItem = page.locator('div.group', { hasText: 'Doomed' });
  await doomedItem.hover();
  await doomedItem.getByRole('button', { name: 'Delete' }).click();

  // APP BUG: no confirmation dialog is shown before deletion — the note is
  // removed immediately. The Radix AlertDialog exists in the UI kit but is
  // never wired into the delete flow, so there is no cancel path to test.
  // Scope to the sidebar: the header h2 also shows "Doomed" until the async
  // delete clears the active note, which would trip strict mode.
  await expect(sidebar(page).getByText('Doomed', { exact: true })).toBeHidden();
  await expect(page.getByText(/0 notes/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();
  await step(page, 'after-delete');
});

test('adds and removes a tag on a note', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Tagged', content: '# Tagged\n\nTag me' })]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Tagged' }).click();
  await expect(page.getByRole('heading', { name: 'Tagged', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before tagging');

  // Add a tag via the meta bar "Add tag" input.
  const addTag = page.getByPlaceholder('Add tag');
  await addTag.fill('project-x');
  await addTag.press('Enter');

  // Tag chip appears in the meta bar (span.inline-flex) and in the sidebar item.
  await expect(page.locator('span.inline-flex', { hasText: 'project-x' })).toBeVisible();
  await expect(page.locator('div.group', { hasText: 'Tagged' })).toContainText('project-x');
  await step(page, 'tag-added');

  // Expand the Tags facet and confirm the tag is listed there.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'project-x', exact: true })).toBeVisible();
  await step(page, 'tag-in-filter');

  // Remove the tag via the meta bar chip's X button.
  await page.locator('span.inline-flex', { hasText: 'project-x' }).getByRole('button').click();
  await expect(page.locator('span.inline-flex', { hasText: 'project-x' })).toBeHidden();
  await expect(page.locator('div.group', { hasText: 'Tagged' })).not.toContainText('project-x');
  await step(page, 'tag-removed');
});

test('changes category and filters by category', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nWork note', category: 'Work', updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nGeneral note', category: 'General', updatedAt: new Date(t.getTime() - 3600000) }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Alpha' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before category change');

  // Change category via the meta bar (button -> free-text input with datalist).
  await page.getByRole('button', { name: 'Work', exact: true }).click();
  const catInput = page.locator('input[list="categories"]');
  await catInput.fill('Personal');
  await catInput.press('Enter');
  await expect(page.getByRole('button', { name: 'Personal', exact: true })).toBeVisible();
  await step(page, 'category-set');

  // Filter by the new category in the sidebar Categories facet.
  await sidebar(page).getByRole('button', { name: 'Categories' }).click();
  await sidebar(page).getByRole('button', { name: 'Personal', exact: true }).click();
  // Scope to the sidebar: the header h2 also shows "Alpha" (active note).
  await expect(sidebar(page).getByText('Alpha', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('Beta', { exact: true })).toBeHidden();
  await step(page, 'category-filtered');
});

test('collapses and expands the sidebar', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Alpha', content: '# Alpha\n\nBody' })]);
  await page.goto(APP_PATH);
  await expect(page.getByPlaceholder('Search notes...')).toBeVisible();
  await debugBreak(page, 'app loaded — inspect before collapse');

  // Collapse via the PanelLeftClose toggle in the top bar.
  await page.locator('button:has(svg.lucide-panel-left-close)').click();
  await expect(page.getByPlaceholder('Search notes...')).toBeHidden();
  await step(page, 'sidebar-collapsed');

  // Expand again (toggle now shows PanelLeftOpen).
  await page.locator('button:has(svg.lucide-panel-left-open)').click();
  await expect(page.getByPlaceholder('Search notes...')).toBeVisible();
  await step(page, 'sidebar-expanded');
});

test('switches between multiple notes', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nAlpha body text', updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nBeta body text', updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'Gamma', content: '# Gamma\n\nGamma body text', updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto(APP_PATH);
  await debugBreak(page, 'notes seeded — inspect before switching');

  const editor = page.getByPlaceholder('Start writing... Type / for commands');

  await page.locator('div.group', { hasText: 'Alpha' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha', level: 2 })).toBeVisible();
  await expect(editor).toHaveValue(/# Alpha\n\nAlpha body text/);
  await step(page, 'switched-alpha');

  await page.locator('div.group', { hasText: 'Beta' }).click();
  await expect(page.getByRole('heading', { name: 'Beta', level: 2 })).toBeVisible();
  await expect(editor).toHaveValue(/# Beta\n\nBeta body text/);
  await step(page, 'switched-beta');

  await page.locator('div.group', { hasText: 'Gamma' }).click();
  await expect(page.getByRole('heading', { name: 'Gamma', level: 2 })).toBeVisible();
  await expect(editor).toHaveValue(/# Gamma\n\nGamma body text/);
  await step(page, 'switched');
});

test('filters by tag and category facets', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nA', tags: ['work'], category: 'Work', updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nB', tags: ['life'], category: 'Personal', updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'Gamma', content: '# Gamma\n\nC', tags: ['work'], category: 'Work', updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before filtering');

  // Tag facet: filter to "work" -> Alpha + Gamma, Beta hidden.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await sidebar(page).getByRole('button', { name: 'work', exact: true }).click();
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(page.getByText('Gamma', { exact: true })).toBeVisible();
  await expect(page.getByText('Beta', { exact: true })).toBeHidden();
  await step(page, 'tag-facet-filtered');

  // Clear the tag filter.
  await sidebar(page).getByRole('button', { name: 'work', exact: true }).click();
  await expect(page.getByText('Beta', { exact: true })).toBeVisible();

  // Category facet: filter to "Work" -> Alpha + Gamma, Beta hidden.
  await sidebar(page).getByRole('button', { name: 'Categories' }).click();
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(page.getByText('Gamma', { exact: true })).toBeVisible();
  await expect(page.getByText('Beta', { exact: true })).toBeHidden();
  await step(page, 'category-facet-filtered');
});
