import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from '../lib/db';
import NoteSidebar from '../components/NoteSidebar';
import { exportDatabase, exportToHtml, exportToPdf, exportToZip } from '@/lib/export';
import { importFiles } from '@/lib/import';
import { toast } from 'sonner';

/**
 * NoteSidebar is fully prop-driven (the page owns query state, filters and the
 * note store), but it pulls export/import helpers and the sonner toaster at
 * module scope. Mocking those keeps the tests hermetic and lets every
 * export/import branch be asserted without touching the file system.
 */
vi.mock('@/lib/export', () => ({
  exportToHtml: vi.fn(),
  exportToPdf: vi.fn(),
  exportToZip: vi.fn(),
  exportDatabase: vi.fn(),
}));

vi.mock('@/lib/import', () => ({
  importFiles: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

type SidebarProps = Parameters<typeof NoteSidebar>[0];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A timestamp `ms` before now — the basis of the sidebar's relative dates. */
const ago = (ms: number): Date => new Date(Date.now() - ms);

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Test note',
    content: 'hello world',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    editDates: [],
    pinned: false,
    ...overrides,
  };
}

/** Fresh callback props per test so call counts never bleed between tests. */
function makeProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    notes: [],
    activeNoteId: null,
    onSelectNote: vi.fn(),
    onNewNote: vi.fn(),
    onDeleteNote: vi.fn(),
    onTogglePin: vi.fn(),
    searchQuery: '',
    onSearch: vi.fn(),
    allTags: [],
    allCategories: [],
    filterTag: null,
    filterCategory: null,
    onFilterTag: vi.fn(),
    onFilterCategory: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

/** The scroll-row div for a note: the only element carrying `.cursor-pointer`. */
function noteRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('.cursor-pointer');
  if (!(row instanceof HTMLElement)) throw new Error(`No note row found for "${title}"`);
  return row;
}

/** The remove (×) button inside an active-filter chip, scoped to that chip. */
function chipRemoveButton(chipText: string): HTMLButtonElement {
  const chip = screen.getByText(chipText).closest('span');
  if (!(chip instanceof HTMLElement)) throw new Error(`No filter chip found for "${chipText}"`);
  return within(chip).getByRole('button') as HTMLButtonElement;
}

/** The hidden multi-file input behind the header's Import button. */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('File input not found');
  return input;
}

/** Attach a fake file selection to the hidden input before firing `change`. */
function selectFiles(input: HTMLInputElement, files: File[] | FileList | null): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
}

describe('NoteSidebar component', () => {
  beforeEach(() => {
    vi.mocked(importFiles).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders rows with pin marker, active highlight, tag slice, previews and dates', () => {
    const props = makeProps({
      notes: [
        makeNote({
          id: 1,
          title: 'Pinned note',
          pinned: true,
          tags: ['work', 'urgent', 'extra'],
          content: '# Pinned *body* text',
          updatedAt: ago(5 * MINUTE),
        }),
        makeNote({ id: 2, title: 'Old note', content: 'y'.repeat(100), updatedAt: ago(5 * HOUR) }),
        makeNote({ id: 3, title: 'Fresh note', content: '', updatedAt: new Date() }),
        makeNote({ id: 4, title: 'Ancient note', updatedAt: new Date('2024-01-01T00:00:00Z') }),
      ],
      activeNoteId: 1,
    });
    render(<NoteSidebar {...props} />);

    // The active row is highlighted; the others carry the hover variant.
    expect(noteRow('Pinned note').className).toContain('bg-sidebar-accent');
    expect(noteRow('Old note').className).toContain('hover:bg-sidebar-accent/50');

    // The pinned row shows the Pin glyph beside its title; the unpinned one not.
    expect(screen.getByText('Pinned note').previousElementSibling?.tagName).toBe('svg');
    expect(screen.getByText('Old note').previousElementSibling).toBeNull();

    // Only the first two tags of a note become chips.
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('urgent')).toBeTruthy();
    expect(screen.queryByText('extra')).toBeNull();

    // Previews strip markdown punctuation, fall back when empty, cap at 80.
    expect(screen.getByText('Pinned body text')).toBeTruthy();
    expect(screen.getByText('y'.repeat(80)).textContent).toHaveLength(80);
    expect(screen.getByText('No content')).toBeTruthy();

    // Relative labels for minutes/hours/now and a locale date beyond a day.
    expect(screen.getByText('5m ago')).toBeTruthy();
    expect(screen.getByText('5h ago')).toBeTruthy();
    expect(screen.getByText('Just now')).toBeTruthy();
    expect(screen.getByText(new Date('2024-01-01T00:00:00Z').toLocaleDateString())).toBeTruthy();

    // Footer shows the plural form for several notes.
    expect(screen.getByText('4 notes · Stored locally')).toBeTruthy();
  });

  it('shows both empty states and the singular footer count', () => {
    const blank = render(<NoteSidebar {...makeProps()} />);
    expect(screen.getByText('No notes yet. Create one!')).toBeTruthy();
    expect(screen.getByText('0 notes · Stored locally')).toBeTruthy();
    blank.unmount();

    // An active search query switches the empty-state copy.
    const filtered = render(<NoteSidebar {...makeProps({ searchQuery: 'needle' })} />);
    expect(screen.getByText('No notes found')).toBeTruthy();
    filtered.unmount();

    // A single note uses the singular footer label.
    const single = render(<NoteSidebar {...makeProps({ notes: [makeNote({ title: 'Only one' })] })} />);
    expect(screen.getByText('Only one')).toBeTruthy();
    expect(screen.getByText('1 note · Stored locally')).toBeTruthy();
  });

  it('fires select, pin-toggle, delete and new-note callbacks', () => {
    const pinned = makeNote({ id: 1, title: 'Alpha', pinned: true });
    const plain = makeNote({ id: 2, title: 'Beta' });
    const props = makeProps({ notes: [pinned, plain], activeNoteId: 1 });
    render(<NoteSidebar {...props} />);

    // Clicking a row selects the note.
    fireEvent.click(noteRow('Alpha'));
    expect(props.onSelectNote).toHaveBeenCalledWith(1);
    fireEvent.click(noteRow('Beta'));
    expect(props.onSelectNote).toHaveBeenCalledWith(2);

    // Pin buttons are titled by the current state and pass the whole note on.
    fireEvent.click(screen.getByTitle('Unpin'));
    expect(props.onTogglePin).toHaveBeenCalledWith(pinned);
    fireEvent.click(screen.getByTitle('Pin'));
    expect(props.onTogglePin).toHaveBeenCalledWith(plain);

    // Delete is row-scoped and does not select the note.
    fireEvent.click(within(noteRow('Alpha')).getByTitle('Delete'));
    expect(props.onDeleteNote).toHaveBeenCalledWith(1);
    expect(props.onSelectNote).toHaveBeenCalledTimes(2);
    fireEvent.click(within(noteRow('Beta')).getByTitle('Delete'));
    expect(props.onDeleteNote).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByTitle('New note'));
    expect(props.onNewNote).toHaveBeenCalledTimes(1);
  });

  it('pushes typed search text up and renders the controlled query', () => {
    const props = makeProps();
    const first = render(<NoteSidebar {...props} />);
    const input = screen.getByPlaceholderText('Search notes...') as HTMLInputElement;
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'grocery' } });
    expect(props.onSearch).toHaveBeenCalledWith('grocery');
    first.unmount();

    // Reverse direction: the displayed value comes from the searchQuery prop.
    render(<NoteSidebar {...makeProps({ searchQuery: 'needle' })} />);
    expect((screen.getByPlaceholderText('Search notes...') as HTMLInputElement).value).toBe('needle');
  });

  it('toggles the export panel and wires every export action', () => {
    const notes = [makeNote({ id: 7, title: 'Active note' })];
    const props = makeProps({ notes, activeNoteId: 7 });
    render(<NoteSidebar {...props} />);

    // The panel is closed until the toolbar toggle opens it.
    expect(screen.queryByText('Export all as ZIP')).toBeNull();
    fireEvent.click(screen.getByTitle('Export'));

    fireEvent.click(screen.getByText('Export current as HTML'));
    expect(vi.mocked(exportToHtml)).toHaveBeenCalledWith(notes[0]);
    fireEvent.click(screen.getByText('Export current as PDF'));
    expect(vi.mocked(exportToPdf)).toHaveBeenCalledWith(notes[0]);
    fireEvent.click(screen.getByText('Export all as ZIP'));
    expect(vi.mocked(exportToZip)).toHaveBeenCalledWith(notes);
    fireEvent.click(screen.getByText('Download full database backup'));
    expect(vi.mocked(exportDatabase)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Database backup downloaded');

    // A second toggle click closes the panel again.
    fireEvent.click(screen.getByTitle('Export'));
    expect(screen.queryByText('Export current as HTML')).toBeNull();
  });

  it('disables per-note exports without an active note and skips unknown active ids', () => {
    // An activeNoteId that matches no note: buttons stay enabled, nothing exports.
    const orphan = render(
      <NoteSidebar {...makeProps({ notes: [makeNote({ id: 7 })], activeNoteId: 999 })} />,
    );
    fireEvent.click(screen.getByTitle('Export'));
    fireEvent.click(screen.getByText('Export current as HTML'));
    fireEvent.click(screen.getByText('Export current as PDF'));
    expect(vi.mocked(exportToHtml)).not.toHaveBeenCalled();
    expect(vi.mocked(exportToPdf)).not.toHaveBeenCalled();
    orphan.unmount();

    // No active note at all: both per-note exports are disabled.
    render(<NoteSidebar {...makeProps({ notes: [makeNote({ id: 7 })] })} />);
    fireEvent.click(screen.getByTitle('Export'));
    expect(screen.getByText('Export current as HTML')).toBeDisabled();
    expect(screen.getByText('Export current as PDF')).toBeDisabled();
  });

  it('imports files, toasts the count, refreshes and resets the input', async () => {
    vi.mocked(importFiles).mockResolvedValue({ imported: 2, errors: [] });
    const onRefresh = vi.fn();
    const { container } = render(<NoteSidebar {...makeProps({ onRefresh })} />);
    const input = fileInput(container);
    selectFiles(input, [new File(['# hello'], 'a.md', { type: 'text/markdown' })]);

    fireEvent.change(input);

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Imported 2 notes'));
    expect(vi.mocked(importFiles)).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('uses the singular toast label when exactly one note is imported', async () => {
    vi.mocked(importFiles).mockResolvedValue({ imported: 1, errors: [] });
    const { container } = render(<NoteSidebar {...makeProps()} />);
    const input = fileInput(container);
    selectFiles(input, [new File(['x'], 'a.md')]);

    fireEvent.change(input);

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Imported 1 note'));
  });

  it('reports import errors without refreshing when nothing was imported', async () => {
    vi.mocked(importFiles).mockResolvedValue({ imported: 0, errors: ['b.zip: unreadable'] });
    const onRefresh = vi.fn();
    const { container } = render(<NoteSidebar {...makeProps({ onRefresh })} />);
    const input = fileInput(container);
    selectFiles(input, [new File(['x'], 'b.zip')]);

    fireEvent.change(input);

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('b.zip: unreadable'));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('shows success and error toasts together for a mixed result', async () => {
    vi.mocked(importFiles).mockResolvedValue({ imported: 1, errors: ['c.md: bad frontmatter'] });
    const onRefresh = vi.fn();
    const { container } = render(<NoteSidebar {...makeProps({ onRefresh })} />);
    const input = fileInput(container);
    selectFiles(input, [new File(['x'], 'c.md')]);

    fireEvent.change(input);

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Imported 1 note');
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('c.md: bad frontmatter');
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('stays silent when a result imports nothing and has no errors', async () => {
    vi.mocked(importFiles).mockResolvedValue({ imported: 0, errors: [] });
    const onRefresh = vi.fn();
    const { container } = render(<NoteSidebar {...makeProps({ onRefresh })} />);
    const input = fileInput(container);
    selectFiles(input, [new File(['x'], 'd.md')]);

    fireEvent.change(input);

    await waitFor(() => expect(vi.mocked(importFiles)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('ignores the change event when the input has no files selected', () => {
    const onRefresh = vi.fn();
    const { container } = render(<NoteSidebar {...makeProps({ onRefresh })} />);
    const input = fileInput(container);

    // The header button opens the same hidden input through its ref.
    fireEvent.click(screen.getByTitle('Import notes'));

    // Neither a missing nor an empty selection reaches importFiles.
    selectFiles(input, null);
    fireEvent.change(input);
    selectFiles(input, []);
    fireEvent.change(input);

    expect(vi.mocked(importFiles)).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('shows active filter chips with working clear buttons', () => {
    const props = makeProps({ filterTag: 'work', filterCategory: 'personal' });
    render(<NoteSidebar {...props} />);

    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.getByText('personal')).toBeTruthy();

    fireEvent.click(chipRemoveButton('work'));
    expect(props.onFilterTag).toHaveBeenCalledWith(null);
    fireEvent.click(chipRemoveButton('personal'));
    expect(props.onFilterCategory).toHaveBeenCalledWith(null);
  });

  it('opens the tag and category pickers and toggles filters upward', () => {
    const props = makeProps({ allTags: ['work', 'urgent'], allCategories: ['Inbox', 'Journal'] });
    const { container } = render(<NoteSidebar {...props} />);

    // Collapsed by default: right chevrons and no chips.
    expect(screen.queryByRole('button', { name: 'work' })).toBeNull();
    expect(container.querySelector('.lucide-chevron-down')).toBeNull();
    expect(container.querySelector('.lucide-chevron-right')).not.toBeNull();

    // Opening the picker flips the chevron and reveals the tag chips.
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    expect(container.querySelector('.lucide-chevron-down')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'work' }));
    expect(props.onFilterTag).toHaveBeenCalledWith('work');
    expect(screen.getByRole('button', { name: 'urgent' }).className).toContain('bg-sidebar-accent');

    fireEvent.click(screen.getByRole('button', { name: 'Categories' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    expect(props.onFilterCategory).toHaveBeenCalledWith('Inbox');
  });

  it('clears a filter by clicking its already-selected chip', () => {
    const tagsProps = makeProps({ allTags: ['work'], filterTag: 'work' });
    const tagsView = render(<NoteSidebar {...tagsProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const chip = screen.getByRole('button', { name: 'work' });
    expect(chip.className).toContain('bg-primary'); // selected styling
    fireEvent.click(chip);
    expect(tagsProps.onFilterTag).toHaveBeenCalledWith(null);
    tagsView.unmount();

    const catProps = makeProps({ allCategories: ['Journal'], filterCategory: 'Journal' });
    const catView = render(<NoteSidebar {...catProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Categories' }));
    fireEvent.click(screen.getByRole('button', { name: 'Journal' }));
    expect(catProps.onFilterCategory).toHaveBeenCalledWith(null);
    catView.unmount();
  });

  it('renders no chips for pickers with empty tag or category lists', () => {
    render(<NoteSidebar {...makeProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    fireEvent.click(screen.getByRole('button', { name: 'Categories' }));
    expect(screen.queryByRole('button', { name: 'work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
  });
});