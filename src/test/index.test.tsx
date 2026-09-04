import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from 'react';
import Index from '@/pages/Index';
import { generateKeyPair, type StoredKeyPair } from '@/lib/crypto';
import { createNote, db, saveKeyPair, type Note } from '@/lib/db';
import { toast } from 'sonner';

/**
 * Index — the app's brain (ROUND 22 of the coverage campaign).
 *
 * Rendered with the REAL hooks and the real Dexie database (wiped per test):
 * useNotes owns the note list / filters / active-note state and useEncryption
 * the WebCrypto flows, so every callback Index owns (handleSave, handleNewNote,
 * handleTogglePin, handleCalendarSelect, handleEncrypt, handleDecrypt,
 * handleExportKeys, handleImportKeys) is driven through genuine data flow —
 * seeded notes, real IndexedDB reads/writes, real PBKDF2/RSA crypto.
 *
 * Two child component modules are replaced with lightweight stand-ups:
 *   - NoteViewer: code-split behind React.lazy and drags in the full
 *     react-markdown pipeline; it has its own 100%-coverage test file. The
 *     stand-up keeps the exact props Index passes observable.
 *   - NoteMetaBar: with the real children, Index's encrypted-autosave branch
 *     in handleSave is unreachable — the editor/viewer are unmounted whenever
 *     an encrypted note has no cache entry, and the real meta bar never sends
 *     `content` in onSave. The stand-up mirrors the real callbacks (encrypt
 *     toggle, category save, tag add) and additionally simulates the editor's
 *     content autosave so the "never persist plaintext over a payload" guard
 *     can be exercised (see the dedicated test below).
 *
 * sonner is mocked with the established factory so toast side effects are
 * assertable.
 */
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/NoteViewer', async () => {
  const { createElement } = await import('react');
  return {
    default: function MockNoteViewer({ note }: { note: Note }) {
      return createElement(
        'div',
        { 'data-testid': 'mock-note-viewer' },
        `${note.title}|${note.content}`,
      );
    },
  };
});

vi.mock('@/components/NoteMetaBar', async () => {
  const { createElement } = await import('react');
  return {
    default: function MockNoteMetaBar({
      note,
      onSave,
      onEncryptClick,
    }: {
      note: Note;
      onSave: (changes: Partial<Note>) => void;
      onEncryptClick?: () => void;
    }) {
      /** Same first-heading derivation rule the real editor applies. */
      const deriveTitle = (value: string): string =>
        value
          .split('\n')
          .find((line) => line.trim())
          ?.replace(/^#+\s*/, '')
          .slice(0, 80) || 'Untitled';
      return createElement(
        'div',
        { 'data-testid': 'mock-meta-bar' },
        createElement(
          'button',
          { 'data-testid': 'mock-encrypt-toggle', onClick: () => onEncryptClick?.() },
          note.encrypted ? 'Encrypted' : 'Encrypt',
        ),
        createElement(
          'button',
          { 'data-testid': 'mock-save-category', onClick: () => onSave({ category: 'Archived' }) },
          'Save category',
        ),
        createElement(
          'button',
          {
            'data-testid': 'mock-add-tag',
            onClick: () => onSave({ tags: [...note.tags, 'urgent'] }),
          },
          'Add tag',
        ),
        createElement(
          'button',
          {
            'data-testid': 'mock-save-content-only',
            onClick: () => onSave({ content: 'content-only-payload' }),
          },
          'Save content only',
        ),
        createElement('textarea', {
          'data-testid': 'mock-meta-content',
          defaultValue: note.content,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.target.value;
            onSave({ content: value, title: deriveTitle(value) });
          },
        }),
      );
    },
  };
});

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

/** Seed one note with explicit field overrides. */
const seed = (overrides: Partial<Note>): Promise<number> => createNote(overrides);

/** Minutes ago, for deterministic updatedAt ordering. */
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/** The sidebar root: the only `w-72` element in the notes layout. */
function sidebarRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('.w-72');
  if (!(root instanceof HTMLElement)) throw new Error('Sidebar not rendered');
  return root;
}

/** The scroll-row div for a note: the only element carrying `.cursor-pointer`. */
function noteRow(container: HTMLElement, title: string): HTMLElement {
  const row = within(sidebarRoot(container)).getByText(title).closest('.cursor-pointer');
  if (!(row instanceof HTMLElement)) throw new Error(`No note row found for "${title}"`);
  return row;
}

/** The main-header button that collapses/expands the sidebar (icon-only). */
function sidebarToggle(container: HTMLElement): HTMLButtonElement {
  const icon = container.querySelector('.lucide-panel-left-close, .lucide-panel-left-open');
  if (!(icon instanceof Element)) throw new Error('Sidebar toggle icon not found');
  const button = icon.closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Sidebar toggle button not found');
  return button;
}

/** The day-detail card for a calendar entry (its `.group` wrapper). */
function calendarEntryCard(title: string): HTMLElement {
  const card = screen
    .getAllByText(title)
    .map((el) => el.closest('div.group'))
    .find((el): el is HTMLElement => el instanceof HTMLElement);
  if (!card) throw new Error(`No calendar entry card found for "${title}"`);
  return card;
}

/** The real editor textarea. */
function editorTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Start writing... Type / for commands') as HTMLTextAreaElement;
}

/** Wait for the seeded row, click it and wait until it is the active note. */
async function selectNote(container: HTMLElement, title: string): Promise<void> {
  await within(sidebarRoot(container)).findByText(title);
  fireEvent.click(noteRow(container, title));
  await screen.findByRole('heading', { name: title });
}

/** Open the encryption dialog and encrypt the active note with a password. */
async function encryptWithPasswordViaDialog(password: string): Promise<void> {
  fireEvent.click(screen.getByTestId('mock-encrypt-toggle'));
  await screen.findByText('Note Encryption');
  fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), { target: { value: password } });
  fireEvent.change(screen.getByPlaceholderText('Confirm password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Encrypt Note' }));
  await waitFor(
    () => expect(screen.getByRole('heading', { name: 'Note is Encrypted' })),
    { timeout: 10_000 },
  );
  // The dialog unmounts one tick after the refreshed locked screen appears.
  await waitFor(() => expect(screen.queryByText('Note Encryption')).toBeNull());
}

/** Open the encryption dialog on its Key Pairs tab. */
async function openEncryptionKeysTab(): Promise<void> {
  fireEvent.click(screen.getByTestId('mock-encrypt-toggle'));
  await screen.findByText('Note Encryption');
  fireEvent.click(screen.getByRole('button', { name: 'Key Pairs' }));
  await screen.findByPlaceholderText('Key pair name');
}

describe('Index page (Round 22 — 100% line coverage)', () => {
  let baseKp: StoredKeyPair;

  beforeAll(async () => {
    // One real RSA-4096 key pair, shared by the key-pair flows below.
    baseKp = await generateKeyPair('Base Key');
    // jsdom implements no object-URL plumbing; Index's export handler needs both.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock-url'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }, 20_000);

  beforeEach(async () => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    await resetDb();
  });

  it('renders the empty state and creates the first note from it', async () => {
    const { container } = render(<Index />);

    expect(await screen.findByRole('heading', { name: 'No note selected' })).toBeInTheDocument();
    expect(screen.getByText('No notes yet. Create one!'));
    expect(container.querySelector('.w-72')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create Note' }));

    await screen.findByPlaceholderText('Start writing... Type / for commands');
    expect(screen.getByRole('heading', { name: 'Untitled' })).toBeInTheDocument();
    expect(await db.notes.toArray()).toHaveLength(1);
  });

  it('wires the sidebar: select, pin, search, tag/category filters, delete, collapse, new note', async () => {
    await seed({ title: 'Home recipes', content: 'apple pie needle', tags: ['home'], category: 'Personal', createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });
    const workId = await seed({ title: 'Work chart', content: 'roadmap details', tags: ['work'], category: 'Projects', createdAt: minutesAgo(30), updatedAt: minutesAgo(30) });
    const scratchId = await seed({ title: 'Scratch', content: 'misc', tags: [], category: 'Projects', createdAt: minutesAgo(60), updatedAt: minutesAgo(60) });
    const { container } = render(<Index />);

    await screen.findByText('Home recipes');

    // Selecting a note makes it active: header title + editor with its content.
    fireEvent.click(noteRow(container, 'Scratch'));
    await screen.findByRole('heading', { name: 'Scratch' });
    expect(editorTextarea()).toHaveValue('misc');

    // Pin routes through handleTogglePin → saveNote({ pinned }).
    fireEvent.click(within(noteRow(container, 'Scratch')).getByTitle('Pin'));
    await waitFor(async () => {
      const scratch = await db.notes.get(scratchId);
      expect(scratch?.pinned).toBe(true);
    });
    expect(within(noteRow(container, 'Scratch')).getByTitle('Unpin')).toBeInTheDocument();

    // Search routes through useNotes' searchNotes path and drops the active
    // note out of the list, which reveals the "no note selected" state.
    fireEvent.change(screen.getByPlaceholderText('Search notes...'), { target: { value: 'needle' } });
    await waitFor(() => expect(within(sidebarRoot(container)).queryByText('Work chart')).toBeNull());
    expect(noteRow(container, 'Home recipes')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'No note selected' });

    fireEvent.change(screen.getByPlaceholderText('Search notes...'), { target: { value: '' } });
    await waitFor(() => expect(noteRow(container, 'Work chart')).toBeInTheDocument());
    await screen.findByRole('heading', { name: 'Scratch' });

    // Tag filter wiring: Index passes filterTag state straight into useNotes.
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'Tags' }));
    const workPill = await within(sidebarRoot(container)).findByRole('button', { name: 'work' });
    fireEvent.click(workPill);
    await waitFor(() => expect(within(sidebarRoot(container)).queryByText('Home recipes')).toBeNull());
    expect(noteRow(container, 'Work chart')).toBeInTheDocument();
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'work' }));
    await waitFor(() => expect(noteRow(container, 'Home recipes')).toBeInTheDocument());

    // Category filter, same wiring.
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'Categories' }));
    const personalPill = await within(sidebarRoot(container)).findByRole('button', { name: 'Personal' });
    fireEvent.click(personalPill);
    await waitFor(() => expect(within(sidebarRoot(container)).queryByText('Work chart')).toBeNull());
    expect(noteRow(container, 'Home recipes')).toBeInTheDocument();
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'Personal' }));
    await waitFor(() => expect(noteRow(container, 'Work chart')).toBeInTheDocument());

    // Deleting a non-active note keeps the selection alive.
    fireEvent.click(within(noteRow(container, 'Work chart')).getByTitle('Delete'));
    await waitFor(async () => {
      expect(await db.notes.get(workId)).toBeUndefined();
    });
    await waitFor(() => expect(within(sidebarRoot(container)).queryByText('Work chart')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Scratch' })).toBeInTheDocument();

    // Collapse/expand the sidebar via the header toggle.
    fireEvent.click(sidebarToggle(container));
    await waitFor(() => expect(container.querySelector('.w-72')).toBeNull());
    fireEvent.click(sidebarToggle(container));
    await waitFor(() => expect(container.querySelector('.w-72')).toBeTruthy());
    expect(within(sidebarRoot(container)).getByText(/Stored locally/)).toBeInTheDocument();

    // The sidebar's own new-note button goes through handleNewNote.
    fireEvent.click(screen.getByTitle('New note'));
    await waitFor(() => expect(within(sidebarRoot(container)).getByText('Untitled')).toBeInTheDocument());
    expect(editorTextarea()).toBeInTheDocument();
  });

  it('autosaves edits through the real editor and drives the meta-bar save callbacks', async () => {
    const draftId = await seed({ title: 'Draft', content: 'hello world' });
    const { container } = render(<Index />);

    await selectNote(container, 'Draft');
    expect(editorTextarea()).toHaveValue('hello world');

    // Typing runs NoteEditor's autosave → handleSave → saveNote → refresh.
    fireEvent.change(editorTextarea(), { target: { value: '# Fresh content\nmore text' } });
    await screen.findByRole('heading', { name: 'Fresh content' });
    await waitFor(async () => {
      const stored = await db.notes.get(draftId);
      expect(stored?.title).toBe('Fresh content');
      expect(stored?.content).toBe('# Fresh content\nmore text');
    });

    // Meta-bar category/tag callbacks also route through handleSave.
    fireEvent.click(screen.getByTestId('mock-save-category'));
    await waitFor(async () => {
      expect((await db.notes.get(draftId))?.category).toBe('Archived');
    });
    fireEvent.click(screen.getByTestId('mock-add-tag'));
    await waitFor(async () => {
      expect((await db.notes.get(draftId))?.tags).toEqual(['urgent']);
    });

    // The derived tags/categories feed the sidebar filter lists.
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'Tags' }));
    expect(await within(sidebarRoot(container)).findByRole('button', { name: 'urgent' })).toBeInTheDocument();
    fireEvent.click(within(sidebarRoot(container)).getByRole('button', { name: 'Categories' }));
    expect(await within(sidebarRoot(container)).findByRole('button', { name: 'Archived' })).toBeInTheDocument();
  });

  it('switches between edit mode and the lazily-loaded viewer', async () => {
    await seed({ title: 'Doc', content: 'body text' });
    const { container } = render(<Index />);

    await selectNote(container, 'Doc');
    expect(editorTextarea()).toHaveValue('body text');

    // View mode resolves the lazy NoteViewer chunk (mocked stand-up here).
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const viewer = await screen.findByTestId('mock-note-viewer');
    expect(viewer).toHaveTextContent('Doc|body text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(editorTextarea()).toHaveValue('body text');
  });

  it('calendar mode: open, select note in view/edit, both back buttons, new note', async () => {
    await seed({ title: 'Alpha note', content: 'alpha contents' });
    await seed({ title: 'Beta note', content: 'beta contents', createdAt: minutesAgo(60), updatedAt: minutesAgo(60) });
    render(<Index />);
    await screen.findByText('Alpha note');

    fireEvent.click(screen.getByTitle('Calendar view'));
    await screen.findByRole('button', { name: 'New Note' });

    // Clicking a note pill opens the day panel; View routes to view mode.
    fireEvent.click(screen.getAllByText('Alpha note')[0]);
    fireEvent.click(within(calendarEntryCard('Alpha note')).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByTestId('mock-note-viewer');
    expect(viewer).toHaveTextContent('Alpha note|alpha contents');

    // Edit routes back into the editor for the same note.
    fireEvent.click(screen.getByTitle('Calendar view'));
    await screen.findByRole('button', { name: 'New Note' });
    fireEvent.click(screen.getAllByText('Alpha note')[0]);
    fireEvent.click(within(calendarEntryCard('Alpha note')).getByRole('button', { name: 'Edit' }));
    await screen.findByPlaceholderText('Start writing... Type / for commands');
    expect(editorTextarea()).toHaveValue('alpha contents');

    // Both calendar-exit buttons return to the notes layout.
    fireEvent.click(screen.getByTitle('Calendar view'));
    await screen.findByRole('button', { name: 'New Note' });
    fireEvent.click(screen.getByTitle('Back to notes'));
    expect(editorTextarea()).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Calendar view'));
    await screen.findByRole('button', { name: 'New Note' });
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(editorTextarea()).toBeInTheDocument();

    // Calendar's New Note creates a note and lands in edit mode.
    fireEvent.click(screen.getByTitle('Calendar view'));
    await screen.findByRole('button', { name: 'New Note' });
    fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
    await screen.findByPlaceholderText('Start writing... Type / for commands');
    await screen.findByRole('heading', { name: 'Untitled' });
  });

  it('encrypts the active note with a password end-to-end', async () => {
    const secretId = await seed({ title: 'Secret plan', content: 'hidden treasure' });
    const { container } = render(<Index />);

    await selectNote(container, 'Secret plan');

    await encryptWithPasswordViaDialog('supersecret9');

    expect(container.querySelector('svg.lucide-lock')).toBeTruthy();
    expect(screen.getByTestId('mock-encrypt-toggle')).toHaveTextContent('Encrypted');
    const stored = await db.notes.get(secretId);
    expect(stored?.content).toBe('[encrypted]');
    expect(stored?.encrypted?.method).toBe('password');
    expect(stored?.encrypted?.ciphertext).toBeDefined();
  });

  it('locked note: unlock dialog, wrong-password error, successful decrypt', async () => {
    const diaryId = await seed({ title: 'Locked diary', content: 'secret contents' });
    const { container } = render(<Index />);

    await selectNote(container, 'Locked diary');
    await encryptWithPasswordViaDialog('supersecret9');

    // The locked screen's Unlock Note button opens the decrypt dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Note' }));
    expect(await screen.findByText(/Encrypted with/)).toBeInTheDocument();
    const passwordInput = screen.getByPlaceholderText('Enter password');

    // A wrong password surfaces the dialog error and never toasts success.
    fireEvent.change(passwordInput, { target: { value: 'wrongpass1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decrypt Note' }));
    await waitFor(() => expect(container.querySelector('.text-destructive')).toBeTruthy(), { timeout: 10_000 });
    expect(vi.mocked(toast.success)).not.toHaveBeenCalledWith('Note decrypted');
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();

    // The correct password decrypts, persists plaintext and reopens the editor.
    fireEvent.change(passwordInput, { target: { value: 'supersecret9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decrypt Note' }));
    await waitFor(
      () => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Note decrypted'),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(editorTextarea()).toHaveValue('secret contents'));
    expect(screen.queryByText('Note Encryption')).toBeNull();
    const stored = await db.notes.get(diaryId);
    expect(stored?.encrypted ?? null).toBeNull();
    expect(stored?.content).toBe('secret contents');
  });

  it('encrypted autosave caches plaintext in memory and never persists it', async () => {
    const guardedId = await seed({ title: 'Guarded note', content: 'original words' });
    const { container } = render(<Index />);

    await selectNote(container, 'Guarded note');
    await encryptWithPasswordViaDialog('supersecret9');

    // Content autosave on an encrypted note: plaintext goes to the in-memory
    // cache only; the DB keeps '[encrypted]' and just receives the title.
    fireEvent.change(screen.getByTestId('mock-meta-content'), { target: { value: 'secret edit' } });
    await waitFor(() => expect(editorTextarea()).toHaveValue('secret edit'));
    await waitFor(async () => {
      const stored = await db.notes.get(guardedId);
      expect(stored?.title).toBe('secret edit');
      expect(stored?.content).toBe('[encrypted]');
      expect(stored?.encrypted?.method).toBe('password');
    });

    // A content-only payload strips to no other changes → nothing is saved.
    fireEvent.click(screen.getByTestId('mock-save-content-only'));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    await waitFor(() =>
      expect(screen.getByTestId('mock-note-viewer')).toHaveTextContent('secret edit|content-only-payload'),
    );
    const after = await db.notes.get(guardedId);
    expect(after?.title).toBe('secret edit');
    expect(after?.content).toBe('[encrypted]');
  });

  it('encrypts and decrypts with a key pair', async () => {
    const keyedId = await seed({ title: 'Keyed note', content: 'asymmetric secret' });
    await saveKeyPair(baseKp);
    const { container } = render(<Index />);

    await selectNote(container, 'Keyed note');

    fireEvent.click(screen.getByTestId('mock-encrypt-toggle'));
    await screen.findByText('Note Encryption');
    fireEvent.click(screen.getByRole('button', { name: 'Key Pair' }));
    expect(await screen.findByText(`${baseKp.name} (${baseKp.fingerprint})`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Encrypt Note' }));
    await waitFor(
      () => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Note encrypted'),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Note is Encrypted' })));
    const stored = await db.notes.get(keyedId);
    expect(stored?.encrypted?.method).toBe('keypair');
    expect(stored?.encrypted?.keyFingerprint).toBe(baseKp.fingerprint);
    expect(stored?.encrypted?.wrappedKey).toBeDefined();

    // Key-pair decryption needs no password — the private key is stored locally.
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Note' }));
    expect(await screen.findByText(/decrypt using the matching private key/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Decrypt Note' }));
    await waitFor(
      () => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Note decrypted'),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(editorTextarea()).toHaveValue('asymmetric secret'));
    expect((await db.notes.get(keyedId))?.encrypted ?? null).toBeNull();
  });

  it('exports the stored key pair as JWK and PEM', async () => {
    await saveKeyPair(baseKp);
    await seed({ title: 'Export host', content: 'host body' });
    const { container } = render(<Index />);

    await selectNote(container, 'Export host');
    await openEncryptionKeysTab();
    expect(await screen.findByText('Base Key')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Export as JWK'));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Keys exported as JWK'));
    const jwkBlob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    const jwk = JSON.parse(await jwkBlob.text());
    expect(jwk.publicKey.kty).toBe('RSA');
    expect(jwk.privateKey.d).toBeDefined();

    fireEvent.click(screen.getByTitle('Export as PEM'));
    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Keys exported as PEM'));
    const pemBlob = vi.mocked(URL.createObjectURL).mock.calls[1][0] as Blob;
    const pem = await pemBlob.text();
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledTimes(2);
  });

  it('imports a key pair from pasted JWK JSON', async () => {
    await seed({ title: 'Import host', content: 'host body' });
    const { container } = render(<Index />);

    await selectNote(container, 'Import host');
    await openEncryptionKeysTab();
    fireEvent.click(screen.getByRole('button', { name: 'Import key pair' }));

    fireEvent.change(screen.getByPlaceholderText('Name for imported key'), { target: { value: 'Imported pair' } });
    fireEvent.change(screen.getByPlaceholderText(/Paste JWK JSON/), {
      target: { value: JSON.stringify({ publicKey: baseKp.publicKeyJwk, privateKey: baseKp.privateKeyJwk }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Key pair imported'));
    expect(screen.queryByPlaceholderText('Name for imported key')).toBeNull();
    expect(await screen.findByText('Imported pair')).toBeInTheDocument();
    const pairs = await db.keyPairs.toArray();
    expect(pairs.map((kp) => kp.fingerprint)).toContain(baseKp.fingerprint);
  });

  it('surfaces the invalid-format error for non-JWK paste', async () => {
    await seed({ title: 'Bad paste host', content: 'host body' });
    const { container } = render(<Index />);

    await selectNote(container, 'Bad paste host');
    await openEncryptionKeysTab();
    fireEvent.click(screen.getByRole('button', { name: 'Import key pair' }));
    fireEvent.change(screen.getByPlaceholderText('Name for imported key'), { target: { value: 'Broken' } });

    // Unparseable JSON → catch branch → the dialog shows the thrown message.
    fireEvent.change(screen.getByPlaceholderText(/Paste JWK JSON/), { target: { value: 'not-json-at-all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Invalid format/)).toBeInTheDocument();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalledWith('Key pair imported');

    // Parseable JSON without publicKey/privateKey falls through to the error.
    fireEvent.change(screen.getByPlaceholderText(/Paste JWK JSON/), { target: { value: '{"foo":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(/Invalid format/)).toBeInTheDocument();
  });
});