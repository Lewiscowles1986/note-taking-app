import { test, expect, step, seedNotes, debugBreak, type NoteSeed } from './fixtures';

/**
 * Round J tag-behavior suite. Thoroughly covers tag add/remove/dedup/trim,
 * search-by-tag, the Tags facet, and how the tag filter combines with search
 * and category filters. Uses the shared freshDb/seedNotes/step/debugBreak
 * helpers from fixtures.ts.
 *
 * APP BEHAVIOR notes (from src/components/NoteMetaBar.tsx):
 *  - addTag() trims leading/trailing whitespace, then dedupes with a
 *    CASE-SENSITIVE `note.tags.includes(tag)` check. So "Work" and "work" are
 *    treated as two distinct tags.
 *  - Only Enter (or the + button) commits a tag — there is no comma handling.
 *  - Internal spaces and emoji are preserved verbatim.
 *  - The sidebar note item only renders `tags.slice(0, 2)` chips (NoteSidebar),
 *    so a note with 3+ tags shows only its first two in the list.
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
// meta bar, which can show the same tag text.
const sidebar = (page: import('@playwright/test').Page) => page.locator('div.w-72');

// The meta bar's tag chips: the tags flex container (which holds the "Add tag"
// input) scoped to its inline-flex chips. Distinct from the sidebar's active
// filter chip (also span.inline-flex) and the note-item tag chips (text-[10px]).
const metaTagChips = (page: import('@playwright/test').Page) =>
  page
    .locator('div.flex.items-center.gap-1\\.5.flex-wrap', { has: page.getByPlaceholder('Add tag') })
    .locator('span.inline-flex');

// The small tag chips rendered on a sidebar note item (tags.slice(0, 2)).
// Scoped by bg-primary/10 to exclude the item's date span (also text-[10px]).
const itemTagChips = (page: import('@playwright/test').Page, title: string) =>
  page.locator('div.group', { hasText: title }).locator('span.bg-primary\\/10');

// Add a tag through the meta bar UI (fill + Enter) and wait for the resulting
// chip to render before returning. Waiting on the chip (rather than the cleared
// input) guarantees the async refresh() re-render has settled, so the next add
// cannot be clobbered by a pending re-render. `expectedChipText` lets callers
// assert a normalized/trimmed chip (defaults to the raw tag).
async function addTagViaUi(
  page: import('@playwright/test').Page,
  tag: string,
  expectedChipText: string = tag
): Promise<void> {
  const input = page.getByPlaceholder('Add tag');
  await input.fill(tag);
  await input.press('Enter');
  await expect(metaTagChips(page).getByText(expectedChipText, { exact: true })).toBeVisible();
}

test('adds multiple tags to one note and shows every chip', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Multi', content: '# Multi\n\nTag me a lot' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Multi' }).click();
  await expect(page.getByRole('heading', { name: 'Multi', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before adding 3 tags');

  await addTagViaUi(page, 'alpha');
  await addTagViaUi(page, 'beta');
  await addTagViaUi(page, 'gamma');

  // Meta bar shows all three chips.
  await expect(metaTagChips(page)).toHaveCount(3);
  await expect(metaTagChips(page).filter({ hasText: 'alpha' })).toBeVisible();
  await expect(metaTagChips(page).filter({ hasText: 'beta' })).toBeVisible();
  await expect(metaTagChips(page).filter({ hasText: 'gamma' })).toBeVisible();
  await step(page, 'multi-tags');

  // APP BEHAVIOR: the sidebar item only renders tags.slice(0, 2), so only the
  // first two tags appear as chips on the list item.
  await expect(itemTagChips(page, 'Multi')).toHaveCount(2);
  await expect(itemTagChips(page, 'Multi').filter({ hasText: 'alpha' })).toBeVisible();
  await expect(itemTagChips(page, 'Multi').filter({ hasText: 'beta' })).toBeVisible();

  // Persist across reload.
  await page.reload();
  await page.locator('div.group', { hasText: 'Multi' }).click();
  await expect(page.getByRole('heading', { name: 'Multi', level: 2 })).toBeVisible();
  await expect(metaTagChips(page)).toHaveCount(3);
  await expect(metaTagChips(page).filter({ hasText: 'gamma' })).toBeVisible();
  await step(page, 'after-reload');
});

test('removes one tag while keeping the others', async ({ page }) => {
  await seedNotes(page, [
    makeNote({ title: 'Triple', content: '# Triple\n\nThree tags', tags: ['one', 'two', 'three'] }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Triple' }).click();
  await expect(page.getByRole('heading', { name: 'Triple', level: 2 })).toBeVisible();
  await expect(metaTagChips(page)).toHaveCount(3);
  await step(page, 'before-remove');
  await debugBreak(page, '3 tags present — inspect before removing the middle one');

  // Remove the middle tag ("two") via its chip's X button.
  await metaTagChips(page).filter({ hasText: 'two' }).getByRole('button').click();

  // The other two remain in the meta bar.
  await expect(metaTagChips(page)).toHaveCount(2);
  await expect(metaTagChips(page).filter({ hasText: 'one' })).toBeVisible();
  await expect(metaTagChips(page).filter({ hasText: 'three' })).toBeVisible();
  await expect(metaTagChips(page).filter({ hasText: 'two' })).toHaveCount(0);

  // Sidebar item reflects the remaining tags.
  await expect(itemTagChips(page, 'Triple')).toHaveCount(2);
  await expect(itemTagChips(page, 'Triple').filter({ hasText: 'one' })).toBeVisible();
  await expect(itemTagChips(page, 'Triple').filter({ hasText: 'three' })).toBeVisible();

  // Tags facet lists only the remaining tags.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'one', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'three', exact: true })).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'two', exact: true })).toHaveCount(0);
  await step(page, 'after-remove');
});

test('prevents duplicate tags', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Dup', content: '# Dup\n\nDedup me' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Dup' }).click();
  await expect(page.getByRole('heading', { name: 'Dup', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before duplicate attempts');

  // APP BEHAVIOR: addTag() dedupes with a CASE-SENSITIVE includes() check, so
  // adding the exact same tag twice yields one chip, but a case-variant is a
  // distinct tag and yields a second chip.
  await addTagViaUi(page, 'Work');
  await expect(metaTagChips(page)).toHaveCount(1);
  await addTagViaUi(page, 'Work');
  await expect(metaTagChips(page)).toHaveCount(1);
  await step(page, 'dup-attempt');

  // Case-variant "work" is treated as a different tag.
  await addTagViaUi(page, 'work');
  await expect(metaTagChips(page)).toHaveCount(2);
  await expect(metaTagChips(page).getByText('Work', { exact: true })).toBeVisible();
  await expect(metaTagChips(page).getByText('work', { exact: true })).toBeVisible();
  await step(page, 'case-variant');
});

test('trims and normalizes tag input', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Trim', content: '# Trim\n\nNormalize me' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Trim' }).click();
  await expect(page.getByRole('heading', { name: 'Trim', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before odd tags');

  // APP BEHAVIOR: addTag() trims leading/trailing whitespace, but preserves
  // internal spaces and emoji verbatim.
  await addTagViaUi(page, '  spaced-tag  ', 'spaced-tag');
  await expect(metaTagChips(page)).toHaveCount(1);
  await expect(metaTagChips(page).getByText('spaced-tag', { exact: true })).toBeVisible();
  await step(page, 'trimmed');

  await addTagViaUi(page, '🚀-launch');
  await expect(metaTagChips(page).getByText('🚀-launch', { exact: true })).toBeVisible();

  await addTagViaUi(page, 'internal space tag');
  await expect(metaTagChips(page).getByText('internal space tag', { exact: true })).toBeVisible();
  await expect(metaTagChips(page)).toHaveCount(3);
  await step(page, 'odd-tags');
});

test('search matches tag names', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    // The tag text appears ONLY as a tag — not in title or content.
    makeNote({ title: 'Alpha', content: '# Alpha\n\nBody text', tags: ['unique-tag-xyz'], updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nBody text', updatedAt: new Date(t.getTime() - 3600000) }),
  ]);
  await page.goto('/');
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before searching by tag');
  await step(page, 'seeded');

  // searchNotes() includes tags, so the query returns the tagged note.
  await page.getByPlaceholder('Search notes...').fill('unique-tag-xyz');
  await expect(sidebar(page).getByText('Alpha', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('Beta', { exact: true })).toBeHidden();
  await step(page, 'search-by-tag');
});

test('tag facet filters across many notes', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'N1', content: '# N1\n\nA', tags: ['alpha'], updatedAt: t }),
    makeNote({ title: 'N2', content: '# N2\n\nB', tags: ['alpha'], updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'N3', content: '# N3\n\nC', tags: ['beta'], updatedAt: new Date(t.getTime() - 7200000) }),
    makeNote({ title: 'N4', content: '# N4\n\nD', tags: ['beta'], updatedAt: new Date(t.getTime() - 10800000) }),
    makeNote({ title: 'N5', content: '# N5\n\nE', tags: ['gamma'], updatedAt: new Date(t.getTime() - 14400000) }),
  ]);
  await page.goto('/');
  await expect(page.getByText('N1', { exact: true })).toBeVisible();
  await debugBreak(page, '5 notes across 3 tags — inspect before facet filter');

  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await expect(sidebar(page).getByRole('button', { name: 'alpha', exact: true })).toBeVisible();
  await step(page, 'facet-expanded');
  await sidebar(page).getByRole('button', { name: 'alpha', exact: true }).click();

  // Exactly the alpha-tagged notes are listed.
  await expect(sidebar(page).getByText('N1', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N2', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N3', { exact: true })).toBeHidden();
  await expect(sidebar(page).getByText('N4', { exact: true })).toBeHidden();
  await expect(sidebar(page).getByText('N5', { exact: true })).toBeHidden();

  // Facet shows the active state (text-primary-foreground) on the selected tag.
  // (bg-primary alone is ambiguous: inactive buttons carry hover:bg-primary/15.)
  await expect(sidebar(page).getByRole('button', { name: 'alpha', exact: true })).toHaveClass(/text-primary-foreground/);
  await expect(sidebar(page).getByRole('button', { name: 'beta', exact: true })).not.toHaveClass(/text-primary-foreground/);
  await step(page, 'facet-filtered');
});

test('combines tag filter with search query', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'N1', content: '# N1\n\nmeeting notes', tags: ['work'], updatedAt: t }),
    makeNote({ title: 'N2', content: '# N2\n\ngrocery list', tags: ['work'], updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'N3', content: '# N3\n\nmeeting notes', tags: ['life'], updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto('/');
  await expect(page.getByText('N1', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before tag+search');

  // Activate the "work" tag filter -> N1 + N2.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await sidebar(page).getByRole('button', { name: 'work', exact: true }).click();
  await expect(sidebar(page).getByText('N1', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N2', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N3', { exact: true })).toBeHidden();
  await step(page, 'tag-filtered');

  // APP BEHAVIOR: useNotes applies search THEN tag filter (AND semantics), so
  // searching "meeting" narrows the work-tagged set to N1 only.
  await page.getByPlaceholder('Search notes...').fill('meeting');
  await expect(sidebar(page).getByText('N1', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N2', { exact: true })).toBeHidden();
  await expect(sidebar(page).getByText('N3', { exact: true })).toBeHidden();
  await step(page, 'tag-plus-search');
});

test('combines tag filter with category filter', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'N1', content: '# N1\n\nA', tags: ['work'], category: 'Work', updatedAt: t }),
    makeNote({ title: 'N2', content: '# N2\n\nB', tags: ['work'], category: 'Personal', updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'N3', content: '# N3\n\nC', tags: ['life'], category: 'Work', updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto('/');
  await expect(page.getByText('N1', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before tag+category');

  // Activate tag "work" -> N1 + N2.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await sidebar(page).getByRole('button', { name: 'work', exact: true }).click();
  await expect(sidebar(page).getByText('N1', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N2', { exact: true })).toBeVisible();
  await step(page, 'tag-filtered');

  // Activate category "Work" -> only N1 matches BOTH (AND semantics).
  await sidebar(page).getByRole('button', { name: 'Categories' }).click();
  await sidebar(page).getByRole('button', { name: 'Work', exact: true }).click();
  await expect(sidebar(page).getByText('N1', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('N2', { exact: true })).toBeHidden();
  await expect(sidebar(page).getByText('N3', { exact: true })).toBeHidden();
  await step(page, 'tag-plus-category');
});

test('shows empty state when a tag filter matches nothing', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Solo', content: '# Solo\n\nOnly tag', tags: ['solo'] })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Solo' }).click();
  await expect(page.getByRole('heading', { name: 'Solo', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before emptying the facet');

  // Activate the "solo" tag filter.
  await sidebar(page).getByRole('button', { name: 'Tags' }).click();
  await sidebar(page).getByRole('button', { name: 'solo', exact: true }).click();
  await expect(sidebar(page).getByText('Solo', { exact: true })).toBeVisible();
  await step(page, 'filter-active');

  // Remove the tag from the only note -> no notes match the filter.
  await metaTagChips(page).filter({ hasText: 'solo' }).getByRole('button').click();

  // APP BUG: the empty-state message only branches on searchQuery, not on the
  // active filters, so with a tag filter active and no matches it misleadingly
  // shows "No notes yet. Create one!" instead of a "no results for this filter"
  // message.
  await expect(sidebar(page).getByText('No notes yet. Create one!')).toBeVisible();
  await expect(sidebar(page).getByText('Solo', { exact: true })).toBeHidden();
  await step(page, 'empty-facet');
});

test('tag chips on sidebar items reflect state per note', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nA', tags: ['red', 'blue'], updatedAt: t }),
    makeNote({ title: 'Beta', content: '# Beta\n\nB', tags: ['green'], updatedAt: new Date(t.getTime() - 3600000) }),
    makeNote({ title: 'Gamma', content: '# Gamma\n\nC', tags: [], updatedAt: new Date(t.getTime() - 7200000) }),
  ]);
  await page.goto('/');
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect per-note chips');
  await step(page, 'seeded');

  // Each sidebar item shows only its own tags (not a global set).
  await expect(itemTagChips(page, 'Alpha')).toHaveCount(2);
  await expect(itemTagChips(page, 'Alpha').filter({ hasText: 'red' })).toBeVisible();
  await expect(itemTagChips(page, 'Alpha').filter({ hasText: 'blue' })).toBeVisible();

  await expect(itemTagChips(page, 'Beta')).toHaveCount(1);
  await expect(itemTagChips(page, 'Beta').filter({ hasText: 'green' })).toBeVisible();

  await expect(itemTagChips(page, 'Gamma')).toHaveCount(0);
  await step(page, 'per-note-chips');
});
