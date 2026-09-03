import { test, expect, step, seedNotes, type NoteSeed } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Round D calendar suite. Covers the calendar view (notes shown on their edit
 * dates), selecting a note from the calendar back into notes mode, and — as the
 * proof for the Round D seedNotes reload-safety fix — that seeding is idempotent
 * across a page.reload().
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

/** Build a Date at UTC noon for a YYYY-MM-DD key (matches CalendarView's UTC toDateKey). */
function dateFromKey(key: string): Date {
  return new Date(key + 'T12:00:00Z');
}

/** The main month grid (distinct from the weekday-header grid). */
const grid = (page: Page) => page.locator('div.grid.grid-cols-7.flex-1 > div');

test('calendar view shows notes on their edit dates', async ({ page }) => {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);
  const monthAgo = new Date(now);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const monthAgoKey = monthAgo.toISOString().slice(0, 10);

  await seedNotes(page, [
    makeNote({
      title: 'TodayNote',
      content: '# TodayNote\n\nToday body',
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      editDates: [todayKey],
    }),
    makeNote({
      title: 'WeekAgoNote',
      content: '# WeekAgoNote\n\nWeek ago body',
      createdAt: dateFromKey(weekAgoKey),
      updatedAt: dateFromKey(weekAgoKey),
      editDates: [weekAgoKey],
    }),
    makeNote({
      title: 'MonthAgoNote',
      content: '# MonthAgoNote\n\nMonth ago body',
      createdAt: dateFromKey(monthAgoKey),
      updatedAt: dateFromKey(monthAgoKey),
      editDates: [monthAgoKey],
    }),
  ]);
  await page.goto('/');
  await expect(page.getByText('TodayNote', { exact: true })).toBeVisible();

  // Open the calendar view via the top-bar toggle (title="Calendar view").
  await page.getByTitle('Calendar view').click();
  await expect(page.getByText('Calendar', { exact: true })).toBeVisible();
  await expect(grid(page).first()).toBeVisible();
  await step(page, 'calendar-view');

  // Today's cell shows the today note. The note title only renders inside the
  // cell for its date, so its presence proves it is on today's cell; also
  // verify that cell carries today's day number.
  const todayCell = grid(page).filter({ hasText: 'TodayNote' });
  await expect(todayCell).toBeVisible();
  await expect(todayCell).toContainText(String(now.getUTCDate()));
  await step(page, 'calendar-today');

  // Navigate to the previous month and expect the ~1-month-old note there.
  // (The current month's trailing days bleed into the previous month's grid,
  // so we do NOT assert the today note is gone — it may still appear.)
  await page.locator('button:has(svg.lucide-chevron-left)').click();
  await expect(grid(page).filter({ hasText: 'MonthAgoNote' })).toBeVisible();
  await step(page, 'calendar-prev-month');
});

test('selecting a note from the calendar returns to notes', async ({ page }) => {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);

  await seedNotes(page, [
    makeNote({
      title: 'PickMe',
      content: '# PickMe\n\nPick me body',
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      editDates: [todayKey],
    }),
  ]);
  await page.goto('/');
  await page.getByTitle('Calendar view').click();
  await expect(grid(page).first()).toBeVisible();

  // Click the cell containing the note -> day-detail sidebar appears.
  await grid(page).filter({ hasText: 'PickMe' }).click();
  await expect(page.getByRole('button', { name: 'View', exact: true })).toBeVisible();
  await step(page, 'calendar-select');

  // Clicking View returns to notes mode with the note active (header h2).
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PickMe', level: 2 })).toBeVisible();
  await expect(page.getByText('Pick me body', { exact: true })).toBeVisible();
  await step(page, 'calendar-selected-note');
});

test('seeding is reload-safe (no duplicate notes after reload)', async ({ page }) => {
  const now = new Date();
  await seedNotes(page, [
    makeNote({ title: 'ReloadA', content: '# ReloadA\n\nA', updatedAt: now }),
    makeNote({ title: 'ReloadB', content: '# ReloadB\n\nB', updatedAt: new Date(now.getTime() - 3600000) }),
  ]);
  await page.goto('/');

  // Exactly 2 note items in the sidebar, and the footer count agrees.
  await expect(page.locator('div.w-72 div.group')).toHaveCount(2);
  await expect(page.getByText('2 notes')).toBeVisible();

  // Reload: the seed init script must NOT re-run (Round D fix), so still 2.
  await page.reload();
  await expect(page.locator('div.w-72 div.group')).toHaveCount(2);
  await expect(page.getByText('2 notes')).toBeVisible();
  await expect(page.getByText('ReloadA', { exact: true })).toBeVisible();
  await expect(page.getByText('ReloadB', { exact: true })).toBeVisible();
  await step(page, 'reload-no-duplicates');
});
