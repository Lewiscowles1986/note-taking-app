import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Note } from '../lib/db';
import NoteMetaBar from '../components/NoteMetaBar';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Test note',
    content: 'hello world',
    tags: [],
    category: 'Inbox',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    editDates: [],
    pinned: false,
    ...overrides,
  };
}

/** Tag chips are the only spans that directly own a button (the × remover). */
const chipCount = (container: HTMLElement) =>
  container.querySelectorAll('span > button').length;

/** The Plus button next to the tag input exists only while `newTag` is non-empty. */
const plusButton = (): HTMLButtonElement | null => {
  const input = screen.getByPlaceholderText('Add tag');
  return (input.nextElementSibling as HTMLButtonElement | null) ?? null;
};

/** Each tag chip's remove (×) button, scoped to that chip. */
const removeButtonFor = (tag: string): HTMLButtonElement => {
  const chip = screen.getByText(tag).closest('span') as HTMLElement;
  return within(chip).getByRole('button') as HTMLButtonElement;
};

describe('NoteMetaBar component', () => {
  it('renders category, tag chips and the unencrypted indicator for a plain note', () => {
    const { container } = render(
      <NoteMetaBar
        note={makeNote({ tags: ['alpha', 'beta'] })}
        allCategories={['Inbox', 'Work']}
        onSave={vi.fn()}
      />,
    );

    // View mode: the category is a button that opens the editor on click.
    // (The always-present "Add tag" input is the only textbox in view mode.)
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
    expect(container.querySelector('input[list]')).toBeNull();

    expect(chipCount(container)).toBe(2);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();

    // No Plus button while the new-tag input is empty.
    expect(plusButton()).toBeNull();

    // Unencrypted note shows the unlock variant.
    const encrypt = screen.getByTitle('Encrypt this note');
    expect(encrypt.textContent).toBe('Encrypt');
    expect(screen.queryByTitle('Encrypted — click to manage')).toBeNull();
  });

  it('renders the encrypted indicator and fires onEncryptClick when toggled', () => {
    const onEncryptClick = vi.fn();
    render(
      <NoteMetaBar
        note={makeNote({
          tags: ['alpha'],
          encrypted: { method: 'password', ciphertext: 'Y2lwaGVy', iv: 'aXZfMTIz', salt: 'c2FsdA==' },
        })}
        allCategories={[]}
        onSave={vi.fn()}
        onEncryptClick={onEncryptClick}
      />,
    );

    const button = screen.getByTitle('Encrypted — click to manage');
    expect(button.textContent).toBe('Encrypted');
    expect(screen.queryByTitle('Encrypt this note')).toBeNull();

    expect(onEncryptClick).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onEncryptClick).toHaveBeenCalledTimes(1);
  });

  it('adds a new tag on Enter and clears the input', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar
        note={makeNote({ tags: ['alpha'] })}
        allCategories={[]}
        onSave={onSave}
      />,
    );
    const input = screen.getByPlaceholderText('Add tag');

    fireEvent.change(input, { target: { value: 'urgent' } });
    expect(plusButton()).not.toBeNull();

    // A non-Enter keypress must not trigger the save.
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ tags: ['alpha', 'urgent'] });

    // Input resets, so the Plus button disappears again.
    expect((input as HTMLInputElement).value).toBe('');
    expect(plusButton()).toBeNull();
  });

  it('adds a new tag via the Plus button click', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar note={makeNote({ tags: [] })} allCategories={[]} onSave={onSave} />,
    );
    const input = screen.getByPlaceholderText('Add tag');

    fireEvent.change(input, { target: { value: 'deep-work' } });
    fireEvent.click(plusButton() as HTMLButtonElement);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ tags: ['deep-work'] });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('ignores a duplicate tag but still clears the input', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar
        note={makeNote({ tags: ['alpha', 'beta'] })}
        allCategories={[]}
        onSave={onSave}
      />,
    );
    const input = screen.getByPlaceholderText('Add tag');

    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSave).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('ignores a whitespace-only tag but still clears the input', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar note={makeNote({ tags: ['alpha'] })} allCategories={[]} onSave={onSave} />,
    );
    const input = screen.getByPlaceholderText('Add tag');

    // Whitespace is truthy, so the Plus button renders, but the trimmed tag is empty.
    fireEvent.change(input, { target: { value: '   ' } });
    expect(plusButton()).not.toBeNull();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('removes a tag via its chip button and reports the remaining tags', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar
        note={makeNote({ tags: ['alpha', 'beta', 'gamma'] })}
        allCategories={[]}
        onSave={onSave}
      />,
    );

    fireEvent.click(removeButtonFor('beta'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ tags: ['alpha', 'gamma'] });

    // Note props are unchanged, so the chip list still shows the original tags.
    expect(chipCount(document.body as HTMLElement)).toBe(3);
  });

  it('edits the category, saves the trimmed value on Enter and returns to view mode', () => {
    const onSave = vi.fn();
    const { container } = render(
      <NoteMetaBar
        note={makeNote({ category: 'Inbox', tags: ['alpha'] })}
        allCategories={['Inbox', 'Work', 'Archive']}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));

    // Edit mode: input seeded with the current category plus a datalist of options.
    const input = screen.getByDisplayValue('Inbox') as HTMLInputElement;
    const options = container.querySelectorAll('datalist#categories option');
    expect(options).toHaveLength(3);
    expect(Array.from(options).map((o) => (o as HTMLOptionElement).value)).toEqual([
      'Inbox',
      'Work',
      'Archive',
    ]);

    // The category view button is replaced by the editor.
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();

    // Non-Enter keys must not save.
    fireEvent.change(input, { target: { value: '  Work  ' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ category: 'Work' });

    // Back to view mode, still showing the (unchanged) note prop.
    expect(screen.queryByDisplayValue('  Work  ')).toBeNull();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
  });

  it('falls back to the General category when the edit input is blanked and blurred', () => {
    const onSave = vi.fn();
    render(
      <NoteMetaBar
        note={makeNote({ category: 'Inbox', tags: ['alpha'] })}
        allCategories={['Inbox']}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    const input = screen.getByDisplayValue('Inbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ category: 'General' });
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
  });

  it('renders no tag chips when the note has no tags', () => {
    const { container } = render(
      <NoteMetaBar note={makeNote({ tags: [] })} allCategories={[]} onSave={vi.fn()} />,
    );

    expect(chipCount(container)).toBe(0);
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeTruthy();
  });
});