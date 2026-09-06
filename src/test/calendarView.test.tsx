import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Note } from '../lib/db';
import CalendarView from '../components/CalendarView';

/**
 * CalendarView derives everything from `new Date()`: the initially displayed
 * month, the highlighted "today" cell and the grid boundaries. Freezing Date
 * (the container runs in UTC) makes all of those deterministic.
 */
const FIXED_NOW = new Date('2024-06-15T12:00:00Z'); // Saturday, 15 June 2024
const TODAY_KEY = '2024-06-15';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Test note',
    content: 'hello world',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: new Date('2024-06-10T12:00:00Z'),
    updatedAt: new Date('2024-06-10T12:00:00Z'),
    editDates: [],
    pinned: false,
    ...overrides,
  };
}

/** A Date on the given calendar day (matches `toDateKey` output). */
const at = (dateKey: string): Date => new Date(`${dateKey}T12:00:00Z`);

/** Mirror of CalendarView's formatDateLabel — same locale, same options. */
const longDateLabel = (dateKey: string): string =>
  new Date(`${dateKey}T12:00:00`).toLocaleDateString('default', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/** Mirror of the header label: "<Month name> <year>". */
const monthHeading = (year: number, month: number): string =>
  `${new Date(year, month, 1).toLocaleString('default', { month: 'long' })} ${year}`;

/** Grid cells are the only elements carrying `cursor-pointer`. */
const allCells = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.cursor-pointer'));

/** Lead-in/spillover days from adjacent months. */
const outsideCells = (container: HTMLElement): HTMLElement[] =>
  allCells(container).filter((cell) => cell.className.includes('bg-muted/30'));

const dayNumber = (cell: HTMLElement): string => cell.querySelector('span')?.textContent ?? '';

/** Find a day cell by its day number; duplicate numbers (a current-month 1
 * and a spillover 1) are disambiguated via the month scope. */
function dayCell(container: HTMLElement, day: number, currentMonth = true): HTMLElement {
  const match = allCells(container).find(
    (cell) => dayNumber(cell) === String(day) && cell.className.includes('bg-muted/30') !== currentMonth,
  );
  if (!match) throw new Error(`No ${currentMonth ? 'current-month' : 'outside'} cell for day ${day}`);
  return match;
}

/** Count badge next to the day number (rendered only for days with notes). */
const countBadge = (cell: HTMLElement): Element | null =>
  cell.querySelector('span')?.nextElementSibling ?? null;

/** Visible note preview titles inside a day cell (the pill's inner span;
 * the pill wrapper div also carries `truncate`, hence the span qualifier). */
const pillTitles = (cell: HTMLElement): string[] =>
  Array.from(cell.querySelectorAll<HTMLElement>('span.truncate')).map((el) => el.textContent ?? '');

/** The <h2>'s row holds the prev, next and Today buttons in that order. */
function headerControls(container: HTMLElement) {
  const heading = container.querySelector('h2');
  if (!heading) throw new Error('Calendar heading not found');
  const row = heading.parentElement;
  if (!row) throw new Error('Header row not found');
  const [prev, next, today] = Array.from(row.querySelectorAll('button'));
  if (!prev || !next || !today) throw new Error('Header navigation buttons not found');
  return { heading, prev, next, today };
}

function navigate(container: HTMLElement, deltaMonths: number): void {
  const { prev, next } = headerControls(container);
  const button = deltaMonths < 0 ? prev : next;
  for (let i = 0; i < Math.abs(deltaMonths); i += 1) {
    fireEvent.click(button);
  }
}

const sidebarRoot = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('div.w-72');

function sidebarOrThrow(container: HTMLElement): HTMLElement {
  const el = sidebarRoot(container);
  if (!el) throw new Error('Day detail sidebar is not open');
  return el;
}

describe('CalendarView component', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current month grid with weekday headers and boundary days', () => {
    const { container } = render(
      <CalendarView notes={[]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );

    const now = new Date();
    expect(
      screen.getByRole('heading', { level: 2, name: monthHeading(now.getFullYear(), now.getMonth()) }),
    ).toBeTruthy();

    for (const weekday of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByText(weekday)).toBeTruthy();
    }

    // June 2024 starts on a Saturday (Mon-first grid): five May lead-in days,
    // thirty June days and no spillover row — 35 cells in 5 rows.
    const cells = allCells(container);
    expect(cells).toHaveLength(35);
    expect(outsideCells(container)).toHaveLength(5);
    expect(cells.slice(0, 5).map(dayNumber)).toEqual(['27', '28', '29', '30', '31']);
    expect(cells.slice(-1).map(dayNumber)).toEqual(['30']);

    const grid = container.querySelector<HTMLElement>('.grid-cols-7.flex-1');
    expect(grid?.style.gridTemplateRows).toBe('repeat(5, minmax(80px, 1fr))');

    // No day selected yet, so the detail sidebar is absent.
    expect(sidebarRoot(container)).toBeNull();
  });

  it('highlights today and shows entry counts and created pills on days with notes', () => {
    const notes = [
      makeNote({
        id: 1,
        title: 'Jotted today',
        createdAt: at(TODAY_KEY),
        updatedAt: at(TODAY_KEY),
        editDates: [TODAY_KEY],
      }),
    ];
    const { container } = render(
      <CalendarView notes={notes} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );

    const todayCell = dayCell(container, 15);
    expect(todayCell.querySelector('span')?.className).toContain('bg-primary');
    expect(countBadge(todayCell)?.textContent).toBe('1');
    expect(pillTitles(todayCell)).toEqual(['Jotted today']);
    // Created entries get the "Created" icon.
    expect(todayCell.querySelector('svg[aria-label="Created"]')).toBeTruthy();

    // Days without notes show neither a count badge nor pills.
    const emptyCell = dayCell(container, 11);
    expect(countBadge(emptyCell)).toBeNull();
    expect(pillTitles(emptyCell)).toEqual([]);

    // Only the today cell gets the highlight.
    expect(dayCell(container, 14).querySelector('span')?.className).not.toContain('bg-primary');
  });

  it('maps created and edited entries, deduplicates repeated edit dates and tolerates missing editDates', () => {
    const edited = makeNote({
      id: 1,
      title: 'Edited note',
      createdAt: at('2024-06-10'),
      updatedAt: at('2024-06-12'),
      // The creation day repeats and is listed again as an edit: both must
      // collapse into the single "created" entry; only 06-12 becomes "edited".
      editDates: ['2024-06-10', '2024-06-12', '2024-06-12'],
    });
    const archived = makeNote({
      id: 2,
      title: 'Archived note',
      createdAt: at('2024-05-28'),
      updatedAt: at('2024-05-28'),
      editDates: undefined,
    });
    const { container } = render(
      <CalendarView notes={[edited, archived]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );

    const createdCell = dayCell(container, 10);
    expect(countBadge(createdCell)?.textContent).toBe('1');
    expect(pillTitles(createdCell)).toEqual(['Edited note']);
    expect(createdCell.querySelector('svg[aria-label="Created"]')).toBeTruthy();
    expect(createdCell.querySelector('svg[aria-label="Edited"]')).toBeNull();

    const editedCell = dayCell(container, 12);
    expect(countBadge(editedCell)?.textContent).toBe('1');
    expect(pillTitles(editedCell)).toEqual(['Edited note']);
    expect(editedCell.querySelector('svg[aria-label="Edited"]')).toBeTruthy();

    // A note without editDates still lands on its creation day — here a
    // lead-in day from May.
    const leadInCell = dayCell(container, 28, false);
    expect(pillTitles(leadInCell)).toEqual(['Archived note']);
  });

  it('caps day previews at three pills and shows a "+N more" overflow row', () => {
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    const notes = titles.map((title, i) =>
      makeNote({
        id: i + 1,
        title,
        createdAt: at('2024-06-20'),
        updatedAt: at('2024-06-20'),
        editDates: ['2024-06-20'],
      }),
    );
    const { container } = render(
      <CalendarView notes={notes} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );

    const cell = dayCell(container, 20);
    expect(countBadge(cell)?.textContent).toBe('4');
    expect(pillTitles(cell)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(cell.textContent).toContain('+1 more');
    expect(screen.queryByText('Delta')).toBeNull();
  });

  it('navigates to the previous and next month and jumps back with Today', () => {
    const { container } = render(
      <CalendarView notes={[]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );
    const headingText = () => screen.getByRole('heading', { level: 2 })?.textContent;
    expect(headingText()).toBe('June 2024');

    fireEvent.click(headerControls(container).prev);
    expect(headingText()).toBe('May 2024');
    // May 2024 starts on a Wednesday: two April lead-in days and two June
    // spillover days round the grid out to 35 cells.
    expect(allCells(container)).toHaveLength(35);
    expect(outsideCells(container)).toHaveLength(4);
    expect(allCells(container).slice(0, 2).map(dayNumber)).toEqual(['29', '30']);
    expect(allCells(container).slice(-2).map(dayNumber)).toEqual(['1', '2']);

    fireEvent.click(headerControls(container).next);
    expect(headingText()).toBe('June 2024');
    fireEvent.click(headerControls(container).next);
    expect(headingText()).toBe('July 2024');
    // July 2024 starts on a Monday: no lead-in days, four August spillover days.
    expect(outsideCells(container)).toHaveLength(4);
    expect(dayNumber(allCells(container)[0])).toBe('1');

    fireEvent.click(headerControls(container).today);
    expect(headingText()).toBe('June 2024');
  });

  it('spills December into the next year and leads January from the previous year', () => {
    const { container } = render(
      <CalendarView notes={[]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );
    const headingText = () => screen.getByRole('heading', { level: 2 })?.textContent;

    navigate(container, 6); // June -> December 2024
    expect(headingText()).toBe('December 2024');
    // December 2024 starts on a Sunday: six November lead-in days, 31 days
    // and five January 2025 spillover days — 42 cells in 6 rows.
    expect(allCells(container)).toHaveLength(42);
    expect(outsideCells(container)).toHaveLength(11);
    expect(
      container.querySelector<HTMLElement>('.grid-cols-7.flex-1')?.style.gridTemplateRows,
    ).toBe('repeat(6, minmax(80px, 1fr))');
    expect(allCells(container).slice(-5).map(dayNumber)).toEqual(['1', '2', '3', '4', '5']);

    // The first spillover day resolves to 1 January 2025 (year + 1).
    fireEvent.click(dayCell(container, 1, false));
    expect(
      screen.getByRole('heading', { level: 3, name: longDateLabel('2025-01-01') }),
    ).toBeTruthy();
    expect(screen.getByText('No notes on this day')).toBeTruthy();

    navigate(container, 1); // December -> January 2025
    expect(headingText()).toBe('January 2025');
    // January 2025 starts on a Wednesday: two 30/31 December 2024 lead-in days.
    expect(allCells(container).slice(0, 2).map(dayNumber)).toEqual(['30', '31']);
    expect(outsideCells(container)).toHaveLength(4); // 2 lead-in + 2 February spillover

    // The first lead-in day resolves to 30 December 2024 (year - 1).
    fireEvent.click(dayCell(container, 30, false));
    expect(
      screen.getByRole('heading', { level: 3, name: longDateLabel('2024-12-30') }),
    ).toBeTruthy();
  });

  it('selects a day and shows its entries with view/edit actions in the sidebar', () => {
    const onSelectNote = vi.fn();
    const report = makeNote({
      id: 1,
      title: 'Quarterly report',
      category: 'Work',
      tags: ['alpha', 'beta', 'gamma', 'delta'],
      createdAt: at('2024-06-10'),
    });
    const unnamed = makeNote({
      id: 2,
      title: '',
      createdAt: at('2024-06-03'),
      editDates: ['2024-06-12'],
    });
    const { container } = render(
      <CalendarView notes={[report, unnamed]} onSelectNote={onSelectNote} onNewNote={vi.fn()} />,
    );

    fireEvent.click(dayCell(container, 10));
    const cell = dayCell(container, 10);
    expect(cell.className).toContain('ring-2');
    expect(cell.className).toContain('bg-primary/5');

    const sidebar = sidebarOrThrow(container);
    expect(
      within(sidebar).getByRole('heading', { level: 3, name: longDateLabel('2024-06-10') }),
    ).toBeTruthy();
    expect(within(sidebar).getByText('Quarterly report').nextElementSibling?.textContent).toBe(
      'Created · Work',
    );
    // Only the first three tags are rendered.
    expect(within(sidebar).getByText('alpha')).toBeTruthy();
    expect(within(sidebar).getByText('gamma')).toBeTruthy();
    expect(within(sidebar).queryByText('delta')).toBeNull();
    expect(sidebar.querySelector('svg[aria-label="Created"]')).toBeTruthy();
    expect(sidebar.querySelector('.flex-wrap')).toBeTruthy();

    fireEvent.click(within(sidebar).getByRole('button', { name: 'View' }));
    expect(onSelectNote).toHaveBeenCalledTimes(1);
    expect(onSelectNote).toHaveBeenCalledWith(1, 'view');

    // The edited day shows the unnamed note as "Edited", with no category
    // suffix and no tag chips.
    fireEvent.click(dayCell(container, 12));
    const editedSidebar = sidebarOrThrow(container);
    expect(pillTitles(dayCell(container, 12))).toEqual(['Untitled']);
    const editedTitle = within(editedSidebar).getByText('Untitled');
    expect(editedTitle.nextElementSibling?.textContent).toBe('Edited');
    expect(editedSidebar.querySelector('.flex-wrap')).toBeNull();
    expect(editedSidebar.querySelector('svg[aria-label="Edited"]')).toBeTruthy();

    fireEvent.click(within(editedSidebar).getByRole('button', { name: 'Edit' }));
    expect(onSelectNote).toHaveBeenCalledTimes(2);
    expect(onSelectNote).toHaveBeenLastCalledWith(2, 'edit');
  });

  it('shows the empty state for days without notes and closes the sidebar', () => {
    const { container } = render(
      <CalendarView
        notes={[makeNote({ id: 1, title: 'Only note', createdAt: at('2024-06-10') })]}
        onSelectNote={vi.fn()}
        onNewNote={vi.fn()}
      />,
    );

    fireEvent.click(dayCell(container, 10));
    expect(within(sidebarOrThrow(container)).getByText('Only note')).toBeTruthy();

    // A selected day without notes shows the empty state, no entry actions.
    fireEvent.click(dayCell(container, 15));
    expect(screen.getByText('No notes on this day')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();

    // The X button in the sidebar header closes it and clears the selection.
    const close = sidebarOrThrow(container).querySelector('button');
    if (!close) throw new Error('Sidebar close button not found');
    fireEvent.click(close);
    expect(sidebarRoot(container)).toBeNull();
    expect(screen.queryByText('No notes on this day')).toBeNull();
    expect(dayCell(container, 15).className).not.toContain('ring-2');
  });

  it('fires onNewNote from the header button', () => {
    const onNewNote = vi.fn();
    render(<CalendarView notes={[]} onSelectNote={vi.fn()} onNewNote={onNewNote} />);
    expect(onNewNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    expect(onNewNote).toHaveBeenCalledTimes(1);
  });

  it('recomputes the notes-by-day map when the notes prop changes', () => {
    const first = makeNote({ id: 1, title: 'First', createdAt: at('2024-06-10') });
    const second = makeNote({ id: 2, title: 'Second', createdAt: at('2024-06-11') });
    const view = render(
      <CalendarView notes={[first]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />,
    );

    expect(countBadge(dayCell(view.container, 10))?.textContent).toBe('1');
    expect(countBadge(dayCell(view.container, 11))).toBeNull();

    view.rerender(<CalendarView notes={[first, second]} onSelectNote={vi.fn()} onNewNote={vi.fn()} />);
    expect(countBadge(dayCell(view.container, 11))?.textContent).toBe('1');
    expect(pillTitles(dayCell(view.container, 11))).toEqual(['Second']);
  });
});