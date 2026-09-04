import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import NoteEditor from '../components/NoteEditor';
import type { Note } from '../lib/db';
import { MAX_INLINE_SIZE } from '../lib/db';
import { processImage } from '@/lib/imageProcessor';

/**
 * NoteEditor owns every editing interaction: controlled textarea state,
 * slash-command menu wiring, image paste/attach (dynamic import of the image
 * processor) and markdown list continuations. Everything is reachable from
 * the outside through DOM events on the textarea / hidden file input, so the
 * tests drive the component with fireEvent and assert on the onSave payloads.
 *
 * Only the image processor is mocked (canvas decoding is impossible in jsdom).
 * SlashCommandMenu renders for real, so the editor ↔ menu integration is
 * exercised through its actual DOM: filter narrowing, item clicks and Escape.
 */
vi.mock('@/lib/imageProcessor', () => ({
  processImage: vi.fn(),
}));

/** Payload for a successful processImage call. */
const PROCESSED = {
  thumbnailDataUrl: 'data:image/jpeg;base64,thumbnail',
  originalDataUrl: 'data:image/png;base64,original',
  originalSize: 1234,
  thumbnailSize: 321,
  width: 800,
  height: 600,
};

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

/** Render the editor with a fresh onSave spy and grab the textarea. */
function renderEditor(note: Note = makeNote()) {
  const onSave = vi.fn();
  const view = render(<NoteEditor note={note} onSave={onSave} />);
  const textarea = screen.getByPlaceholderText(
    'Start writing... Type / for commands',
  ) as HTMLTextAreaElement;
  return { onSave, textarea, ...view };
}

/** Flush promise chains (dynamic import, FileReader) and the focus timeouts. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Fire a controlled change with the caret pinned to a specific offset. */
function type(textarea: HTMLTextAreaElement, value: string, pos = value.length) {
  fireEvent.change(textarea, { target: { value, selectionStart: pos, selectionEnd: pos } });
}

type PasteItem = { type: string; getAsFile: () => File | null };

/** A cancelable paste event carrying a plain-object clipboardData. */
function makePasteEvent(items: PasteItem[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { items } });
  return event;
}

/** Point the hidden file input at a synthetic file list and fire change. */
function chooseFiles(input: HTMLInputElement, files: File[] | null) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const menu = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.slash-menu');

beforeEach(() => {
  vi.mocked(processImage).mockReset();
});

describe('NoteEditor component', () => {
  describe('note prop synchronisation', () => {
    it('resets local content when a different note is opened', () => {
      const onSave = vi.fn();
      const view = render(
        <NoteEditor note={makeNote({ content: 'first draft', title: 'First' })} onSave={onSave} />,
      );
      const textarea = screen.getByPlaceholderText(
        'Start writing... Type / for commands',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('first draft');

      view.rerender(
        <NoteEditor
          note={makeNote({ id: 2, content: 'second draft', title: 'Second' })}
          onSave={onSave}
        />,
      );
      expect(textarea.value).toBe('second draft');
      // Switching notes is a display change — the editor must not save.
      expect(onSave).not.toHaveBeenCalled();
    });

    it('keeps in-progress edits when the same note re-renders with stale props', () => {
      const { onSave, textarea, rerender } = renderEditor(makeNote({ content: 'old' }));
      type(textarea, 'fresh edits');
      // Parent re-render with the same id (but stale content) must not clobber.
      rerender(<NoteEditor note={makeNote({ content: 'stale' })} onSave={onSave} />);
      expect(textarea.value).toBe('fresh edits');
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('content editing and title derivation', () => {
    it('derives the title from a leading heading', () => {
      const { onSave, textarea } = renderEditor();
      type(textarea, '# Real Title\nbody');
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: '# Real Title\nbody',
          title: 'Real Title',
          hasCodeBlocks: false,
          hasMermaid: false,
          hasGeoJson: false,
          hasModel3D: false,
        }),
      );
    });

    it('derives the title from the first plain line and falls back to Untitled', () => {
      const { onSave, textarea } = renderEditor();
      type(textarea, 'plain first line');
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'plain first line' }),
      );
      // An empty document has no first line at all.
      type(textarea, '');
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '', title: 'Untitled' }),
      );
    });

    it('truncates long titles and treats a bare heading marker as Untitled', () => {
      const { onSave, textarea } = renderEditor();
      type(textarea, `#${'x'.repeat(90)}`);
      const call = onSave.mock.calls[0][0];
      expect(call.title).toHaveLength(80);
      expect(call.title.startsWith('x')).toBe(true);
      // "# " strips to an empty title, which also falls back to Untitled.
      type(textarea, '# ');
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Untitled' }));
    });
  });

  describe('slash command menu', () => {
    it('opens above the caret line when "/" is typed', () => {
      const { onSave, container, textarea } = renderEditor();
      type(textarea, '/');

      const menuEl = menu(container);
      expect(menuEl).not.toBeNull();
      // jsdom element rects are 0px tall, so the clamp bottoms out at -280.
      expect(menuEl?.style.top).toBe('-280px');
      expect(menuEl?.style.left).toBe('16px');
      expect(screen.getByText('Heading 1')).toBeInTheDocument();
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ content: '/' }));
    });

    it('narrows the command list while the caret line still starts with "/"', () => {
      const { container, textarea } = renderEditor();
      type(textarea, '/he');
      expect(menu(container)).not.toBeNull();
      expect(screen.getByText('Heading 1')).toBeInTheDocument();
      expect(screen.queryByText('Bullet List')).not.toBeInTheDocument();
    });

    it('inserts the selected command and closes the menu', async () => {
      const { onSave, container, textarea } = renderEditor();
      type(textarea, '/');
      fireEvent.click(screen.getByText('Heading 1'));
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: '# ' }));
      expect(menu(container)).toBeNull();
      await flush();
      // The caret lands right after the inserted snippet.
      expect(textarea.selectionStart).toBe(2);
    });

    it('keeps the text after the slash token when a newline follows it', async () => {
      const { onSave, container, textarea } = renderEditor();
      // Caret parked at the end of the "/" line; the rest of the note survives.
      type(textarea, '/\nrest of the note', 1);
      expect(menu(container)).not.toBeNull();
      fireEvent.click(screen.getByText('Heading 1'));
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '# \nrest of the note' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(2);
    });

    it('closes the menu on Escape without saving', () => {
      const { onSave, container, textarea } = renderEditor();
      type(textarea, '/');
      expect(menu(container)).not.toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(menu(container)).toBeNull();
      // Only the initial "/" change was saved; Escape itself saves nothing.
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('closes the menu as soon as the caret line no longer starts with "/"', () => {
      const { container, textarea } = renderEditor();
      type(textarea, '/');
      expect(menu(container)).not.toBeNull();
      type(textarea, 'plain text');
      expect(menu(container)).toBeNull();
    });

    it('lets the open menu handle Enter instead of list continuation', async () => {
      const { onSave, container, textarea } = renderEditor();
      type(textarea, '/');
      expect(menu(container)).not.toBeNull();
      // The menu's document-level keydown selects the active command…
      expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false);
      await flush();
      expect(textarea.selectionStart).toBe(2);
      // …so the editor receives the insertion, not a list continuation.
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: '# ' }));
    });
  });

  describe('image paste', () => {
    it('stores a thumbnail attachment and inserts an attachment reference', async () => {
      vi.mocked(processImage).mockResolvedValue(PROCESSED);
      const { onSave, textarea } = renderEditor(makeNote({ content: 'x' }));
      textarea.setSelectionRange(1, 1);
      const file = new File(['pixels'], 'clip.png', { type: 'image/png' });
      // A leading text item proves the loop keeps scanning for image items.
      expect(
        fireEvent(textarea, makePasteEvent([
          { type: 'text/plain', getAsFile: () => null },
          { type: 'image/png', getAsFile: () => file },
        ])),
      ).toBe(false); // default paste behaviour was prevented
      await flush();

      expect(processImage).toHaveBeenCalledWith(file);
      const call = onSave.mock.calls[0][0];
      const att = call.attachments[0];
      expect(att).toEqual({
        id: expect.any(String),
        name: expect.stringMatching(/^pasted image-\d+\.png$/),
        type: 'image/png',
        data: PROCESSED.originalDataUrl,
        size: PROCESSED.originalSize,
        thumbnail: PROCESSED.thumbnailDataUrl,
      });
      // Content stores only the lightweight reference — never the data URL.
      expect(call.content).toBe(`x![pasted image](attachment:${att.id})`);
      expect(call.content).not.toContain('base64');
      expect(call.title).toBe(call.content);
      expect(textarea.selectionStart).toBe(1 + `![pasted image](attachment:${att.id})`.length);
    });

    it('falls back to a placeholder when image processing fails', async () => {
      vi.mocked(processImage).mockRejectedValue(new Error('decode failed'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { onSave, textarea } = renderEditor(makeNote({ content: 'x' }));
      textarea.setSelectionRange(1, 1);
      const file = new File(['pixels'], 'clip.png', { type: 'image/png' });
      fireEvent(textarea, makePasteEvent([{ type: 'image/png', getAsFile: () => file }]));
      await flush();

      expect(errSpy).toHaveBeenCalledWith('Image processing failed:', expect.any(Error));
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: 'x![pasted image](failed-to-process)' }),
      );
      errSpy.mockRestore();
    });

    it('ignores pastes that carry no image item', () => {
      const { onSave, textarea } = renderEditor();
      expect(
        fireEvent(textarea, makePasteEvent([{ type: 'text/plain', getAsFile: () => null }])),
      ).toBe(true); // left unprevented for the default text paste
      expect(processImage).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('stops without processing when the image item carries no file', () => {
      const { onSave, textarea } = renderEditor();
      expect(
        fireEvent(textarea, makePasteEvent([{ type: 'image/png', getAsFile: () => null }])),
      ).toBe(false);
      expect(processImage).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('file attachments', () => {
    it('opens the hidden file input from the paperclip button', () => {
      const clickSpy = vi
        .spyOn(HTMLInputElement.prototype, 'click')
        .mockImplementation(() => {});
      renderEditor();
      fireEvent.click(screen.getByTitle('Attach file'));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
    });

    it('attaches an image file through the image processor', async () => {
      vi.mocked(processImage).mockResolvedValue(PROCESSED);
      const { onSave, container, textarea } = renderEditor(makeNote({ content: 'x' }));
      textarea.setSelectionRange(1, 1);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      chooseFiles(input, [new File(['pixels'], 'photo.png', { type: 'image/png' })]);
      await flush();

      expect(processImage).toHaveBeenCalledTimes(1);
      const call = onSave.mock.calls[0][0];
      const att = call.attachments[0];
      expect(att.name).toMatch(/^photo\.png-\d+\.png$/);
      expect(att.type).toBe('image/png');
      expect(att.data).toBe(PROCESSED.originalDataUrl);
      expect(att.thumbnail).toBe(PROCESSED.thumbnailDataUrl);
      expect(call.content).toBe(`x![photo.png](attachment:${att.id})`);
      // The input is cleared so picking the same file again still fires.
      expect(input.value).toBe('');
    });

    it('inlines small non-image files as data URLs', async () => {
      const { onSave, container } = renderEditor();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
      chooseFiles(input, [file]);
      await flush();

      expect(processImage).not.toHaveBeenCalled();
      // toHaveBeenCalledWith (not LastCalledWith) + waitFor: handleFileAttach
      // fires two saves (content insert, then attachments) and the FileReader
      // resolve time varies under coverage instrumentation — order and exact
      // timing must not matter.
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith({
          attachments: [
            {
              id: expect.any(String),
              name: 'notes.txt',
              type: 'text/plain',
              data: expect.stringContaining('data:text/plain;base64,'),
              size: 5,
            },
          ],
        }),
      );
    });

    it('asks for an external URL for large files and keeps it when provided', async () => {
      const promptSpy = vi
        .spyOn(window, 'prompt')
        .mockReturnValue('https://cdn.example.com/big.zip');
      const { onSave, container } = renderEditor(makeNote({ content: '' }));
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      chooseFiles(input, [new File([new Uint8Array(MAX_INLINE_SIZE + 1)], 'big.zip', { type: 'application/zip' })]);
      await flush();

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][0]).toContain('"big.zip" is too large (2.0MB)');
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: '[📎 big.zip](https://cdn.example.com/big.zip)',
        }),
      );
      promptSpy.mockRestore();
    });

    it('inserts nothing for a large file when the prompt is cancelled', async () => {
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
      const { onSave, container } = renderEditor();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      chooseFiles(input, [new File([new Uint8Array(MAX_INLINE_SIZE + 1)], 'big.zip', { type: 'application/zip' })]);
      await flush();

      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(processImage).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });

    it('does nothing when the file input has no files', () => {
      const { onSave, container } = renderEditor();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      chooseFiles(input, null);
      expect(processImage).not.toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe('keyboard handling', () => {
    it('inserts two-space indentation at the caret on Tab', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: 'abc' }));
      textarea.setSelectionRange(1, 1);
      expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'a  bc' }));
      await flush();
      expect(textarea.selectionStart).toBe(3);
    });

    it('indents every selected line on Tab', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: 'one\ntwo' }));
      textarea.setSelectionRange(0, 7);
      fireEvent.keyDown(textarea, { key: 'Tab' });
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '  one\n  two' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(0);
      expect(textarea.selectionEnd).toBe(11);
    });

    it('outdents spaces and tabs from every selected line on Shift+Tab', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '  one\n\ttwo' }));
      textarea.setSelectionRange(0, 10);
      fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'one\ntwo' }));
      await flush();
      expect(textarea.selectionStart).toBe(0);
      expect(textarea.selectionEnd).toBe(7); // 'one\ntwo'.length
    });

    it('continues unordered lists on Enter', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '- item' }));
      textarea.setSelectionRange(6, 6);
      expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false);
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '- item\n- ' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(9);
    });

    it('clears a bare unordered marker on Enter', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '- ' }));
      textarea.setSelectionRange(2, 2);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '', title: 'Untitled' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(0);
    });

    it('continues ordered lists with the next number on Enter', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '9. item' }));
      textarea.setSelectionRange(7, 7);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '9. item\n10. ' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(12);
    });

    it('clears a bare ordered marker on Enter', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '1. ' }));
      textarea.setSelectionRange(3, 3);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }));
      await flush();
      expect(textarea.selectionStart).toBe(0);
    });

    it('continues checkbox lists with a fresh unchecked box on Enter', async () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: '- [x] done' }));
      textarea.setSelectionRange(10, 10);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: '- [x] done\n- [ ] ' }),
      );
      await flush();
      expect(textarea.selectionStart).toBe(17);
    });

    it('clears bare checked and unchecked checkbox markers on Enter', async () => {
      const unchecked = renderEditor(makeNote({ content: '- [ ] ' }));
      unchecked.textarea.setSelectionRange(6, 6);
      fireEvent.keyDown(unchecked.textarea, { key: 'Enter' });
      expect(unchecked.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }));
      // Unmount before the second render so screen queries stay unambiguous.
      unchecked.unmount();

      const checked = renderEditor(makeNote({ content: '- [x] ' }));
      checked.textarea.setSelectionRange(6, 6);
      fireEvent.keyDown(checked.textarea, { key: 'Enter' });
      expect(checked.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }));
    });

    it('leaves plain text alone on Enter', () => {
      const { onSave, textarea } = renderEditor(makeNote({ content: 'plain text' }));
      textarea.setSelectionRange(10, 10);
      expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(true);
      expect(onSave).not.toHaveBeenCalled();
    });
  });
});