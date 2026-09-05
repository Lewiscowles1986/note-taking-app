import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Index from '@/pages/Index';
import { createNote, db, type Note } from '@/lib/db';

/**
 * Mobile layout coverage for Index. Uses the same real-hooks / real-Dexie
 * approach as index.test.tsx, but forces the mobile branch by mocking
 * useIsMobile → true. Verifies the top-sheet flow:
 *   - the sidebar is a top sheet (no `.w-72` inline column)
 *   - selecting a note closes the sheet and opens the editor (full-screen)
 *   - a back button reopens the sheet / returns to selection
 *   - "New note" closes the sheet and lands in the editor.
 *
 * NoteViewer / NoteMetaBar are replaced with the same stand-ups as
 * index.test.tsx so the editor textarea stays real (autosave observable).
 */
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

vi.mock('@/components/NoteViewer', async () => {
  const { createElement } = await import('react');
  return {
    default: function MockNoteViewer({ note }: { note: Note }) {
      return createElement('div', { 'data-testid': 'mock-note-viewer' }, `${note.title}|${note.content}`);
    },
  };
});

vi.mock('@/components/NoteMetaBar', async () => {
  const { createElement } = await import('react');
  return {
    default: function MockNoteMetaBar() {
      return createElement('div', { 'data-testid': 'mock-meta-bar' });
    },
  };
});

async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

/** The `.cursor-pointer` row that opens a note from the (sheet) list. */
function noteRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('.cursor-pointer');
  if (!(row instanceof HTMLElement)) throw new Error(`No note row found for "${title}"`);
  return row;
}

/** The mobile back button in the top bar. */
function backButton(): HTMLButtonElement {
  const icon = document.querySelector('.lucide-chevron-left');
  if (!(icon instanceof Element)) throw new Error('Mobile back button not found');
  const button = icon.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Mobile back button is not a button');
  return button;
}

describe('Index — mobile (useIsMobile forced true)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('renders the note list as a top sheet, not an inline .w-72 column', async () => {
    await createNote({ title: 'Mobile note', content: 'mobile body' });
    const { container } = render(<Index />);

    // The inline desktop column must NOT be present on mobile.
    expect(container.querySelector('.w-72')).toBeNull();
    // The sheet opens on load (start at selection) and shows the note row.
    expect(await screen.findByText('Mobile note')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Start writing... Type / for commands')).toBeNull();
  });

  it('selecting a note closes the sheet, shows the editor and a back button', async () => {
    await createNote({ title: 'Picked', content: 'peekaboo' });
    const { container } = render(<Index />);

    fireEvent.click(await within(document.body).findByText('Picked').then((el) => {
      const row = el.closest('.cursor-pointer');
      if (!(row instanceof HTMLElement)) throw new Error('row not found');
      return row;
    }));

    // Sheet closed, editor full-screen with the note content.
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Start writing... Type / for commands')).toHaveValue('peekaboo'),
    );
    expect(container.querySelector('.w-72')).toBeNull();
    // Back button present so the user can return to selecting notes.
    expect(backButton()).toBeInTheDocument();
  });

  it('back button returns to the note list (reopens the sheet)', async () => {
    await createNote({ title: 'Return me', content: 'body' });
    render(<Index />);

    fireEvent.click(await screen.findByText('Return me').then((el) => {
      const row = el.closest('.cursor-pointer');
      if (!(row instanceof HTMLElement)) throw new Error('row not found');
      return row;
    }));
    await waitFor(() => expect(screen.getByPlaceholderText('Start writing... Type / for commands')).toHaveValue('body'));

    fireEvent.click(backButton());
    // The list sheet is open again — NoteSidebar-only search box is present.
    expect(await screen.findByPlaceholderText('Search notes...')).toBeInTheDocument();
    expect(screen.getAllByText('Return me').length).toBeGreaterThanOrEqual(1);
    // No inline `.w-72` column is ever mounted on mobile.
    expect(document.querySelector('.w-72')).toBeNull();
  });

  it('New note closes the sheet and lands in the editor', async () => {
    render(<Index />);

    // Empty state: the sheet's own New-note button is the primary path.
    fireEvent.click(screen.getByTitle('New note'));

    await screen.findByPlaceholderText('Start writing... Type / for commands');
    expect(await screen.findByRole('heading', { name: 'Untitled' })).toBeInTheDocument();
    expect(await db.notes.toArray()).toHaveLength(1);
  });
});
