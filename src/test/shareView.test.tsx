import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Note } from '../lib/db';
import type { EncryptedPayload } from '../lib/crypto';
import { db, getAllNotes } from '../lib/db';
import { encryptWithPassword } from '../lib/crypto';
import { encodeSharedNote } from '../lib/share';
import ShareDialog from '../components/ShareDialog';
import ShareView from '../pages/ShareView';

/** jsdom's navigator.clipboard is a getter-only stub; replace it wholesale. */
function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Test note',
    content: '# Hello\n\nWorld',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    editDates: [],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

/** Wipe the fake-indexeddb database between tests. */
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

describe('ShareDialog', () => {
  it('requires an explicit click before revealing a plaintext link, then builds and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<ShareDialog note={makeNote()} onClose={vi.fn()} />);

    // Warning shown, no link yet
    expect(screen.getByText(/unencrypted/i)).toBeTruthy();
    expect(screen.queryByText('Share link')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }));

    const textarea = (await screen.findByDisplayValue(/note=/i)) as HTMLTextAreaElement;
    expect(textarea.value).toContain('?note=');
    expect(textarea.value.startsWith(`${location.origin}${location.pathname}`)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(textarea.value);
    expect(await screen.findByText('Copied!')).toBeTruthy();
  });

  it('builds the link immediately for an encrypted note (ciphertext only)', () => {
    const note = makeNote({ content: '[encrypted]', encrypted: {
      method: 'password', ciphertext: 'Y2lwaGVy', iv: 'aXZfMTIz', salt: 'c2FsdA==',
    } as EncryptedPayload });
    render(<ShareDialog note={note} onClose={vi.fn()} />);

    expect(screen.getByText(/carries only the ciphertext/i)).toBeTruthy();
    const textarea = screen.getByDisplayValue(/note=/i) as HTMLTextAreaElement;
    expect(textarea.value).not.toContain('Hello');
    expect(textarea.value).toContain('note=');
  });

  it('warns about long URLs exceeding the soft limit', () => {
    const note = makeNote({ content: 'x'.repeat(10_000) });
    render(<ShareDialog note={note} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create share link' }));
    expect(screen.getByText(/may truncate long URLs/i)).toBeTruthy();
  });
});

describe('ShareView', () => {
  function renderShare(encoded: string) {
    return render(
      <MemoryRouter initialEntries={[`/share?note=${encodeURIComponent(encoded)}`]}>
        <Routes>
          <Route path="/share" element={<ShareView />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('shows an error card for malformed share data', () => {
    renderShare('%%%not-base64%%%');
    expect(screen.getByText('Invalid share link')).toBeTruthy();
    // The generic error card is rendered; exact message is codec-dependent.
    expect(screen.getByText(/go to my notes/i)).toBeTruthy();
  });

  it('previews the content but does not write to the DB until save is clicked', async () => {
    renderShare(encodeSharedNote(makeNote({ content: '# Shared\n\nhello', title: 'Shared one' })));

    expect(await screen.findByText('Shared one')).toBeTruthy();
    expect(screen.getByText(/plain text/i)).toBeTruthy();

    // Nothing saved yet.
    expect(await getAllNotes()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /save to my notes/i }));
    // ShareView navigates to /?open=<id> after saving; assert the DB row.
    await waitFor(async () => expect(await getAllNotes()).toHaveLength(1));

    const saved = await getAllNotes();
    expect(saved[0].title).toBe('Shared one');
    expect(saved[0].content).toBe('# Shared\n\nhello');
    expect(saved[0].encrypted ?? null).toBeNull();
  });

  it('saves an encrypted link as an encrypted note (ciphertext only, still locked)', async () => {
    const payload = await encryptWithPassword('secret body', 'pw123456789');
    renderShare(encodeSharedNote(makeNote({ content: '[encrypted]', encrypted: payload, title: 'Locked gift' })));

    expect(await screen.findByText(/carries only ciphertext/i)).toBeTruthy();
    // Optional decrypt-to-preview offered for password notes
    expect(screen.getByPlaceholderText(/password/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /save encrypted note/i }));
    // ShareView navigates home after saving; assert the DB row instead of the toast.
    await waitFor(async () => expect(await getAllNotes()).toHaveLength(1));

    const saved = await getAllNotes();
    expect(saved[0].content).toBe('[encrypted]');
    expect(saved[0].encrypted).toEqual(payload);
  });

  it('decrypt-to-preview with the right password reveals content in memory only', async () => {
    const payload = await encryptWithPassword('visible body', 'pw123456789');
    renderShare(encodeSharedNote(makeNote({ content: '[encrypted]', encrypted: payload, title: 'Locked gift' })));

    await screen.findByText(/carries only ciphertext/i);
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'pw123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    // The decrypted plaintext is rendered into the preview…
    expect(await screen.findByText(/visible body/i)).toBeTruthy();
    // …but nothing is saved.
    expect(await getAllNotes()).toHaveLength(0);
  });
});