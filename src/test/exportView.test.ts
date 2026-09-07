// Tests for src/lib/exportView.ts — the on-demand, off-screen note renderer
// that backs the rich HTML / PDF / ZIP exports.
//
// Unlike export.test.ts, this file imports the REAL module (no mock): it mounts
// the actual `NoteViewer` in jsdom and captures the rendered markup, proving the
// render → capture pipeline works end to end.

import { describe, expect, it } from 'vitest';
import { renderNoteViewToHtml } from '@/lib/exportView';
import type { Note } from '@/lib/db';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    title: 'Export me',
    content: '# Hello\n\nSome **bold** text.',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    editDates: ['2024-01-01'],
    pinned: false,
    ...overrides,
  };
}

describe('renderNoteViewToHtml', () => {
  it('renders a plain note into a self-contained HTML document', async () => {
    const html = await renderNoteViewToHtml(makeNote());

    expect(html).not.toBeNull();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Export me</title>');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('note-export-root');
  });

  it('cleans up the off-screen container after capture', async () => {
    await renderNoteViewToHtml(makeNote());
    // The hidden render container must be removed from the document.
    const leftovers = Array.from(document.body.querySelectorAll('div[aria-hidden=true]'));
    expect(leftovers).toHaveLength(0);
  });

  it('returns null gracefully when no note is given a content node', async () => {
    // NoteViewer always renders a .prose-notes node (even an "Empty note"
    // placeholder), so the call should not throw for an empty note.
    const html = await renderNoteViewToHtml(makeNote({ content: '' }));
    expect(html).not.toBeNull();
    expect(html).toContain('Empty note');
  });
});
