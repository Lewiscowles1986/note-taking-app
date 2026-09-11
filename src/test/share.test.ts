import { describe, it, expect } from 'vitest';
import {
  encodeSharedNote,
  decodeSharedNote,
  buildShareUrl,
  sharedNoteFromSearchParams,
  SHARE_QUERY_PARAM,
} from '../lib/share';
import { encryptWithPassword, decryptWithPassword, type EncryptedPayload } from '../lib/crypto';
import type { Note } from '../lib/db';

function makeNote(partial: Partial<Note>): Note {
  return {
    id: 1,
    title: 'Test note',
    content: '# Hello\n\nWorld',
    tags: ['a', 'b'],
    category: 'General',
    attachments: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    editDates: ['2026-01-01'],
    pinned: false,
    encrypted: null,
    ...partial,
  };
}

describe('share codec (plaintext notes)', () => {
  it('round-trips title, content, tags and category', () => {
    const note = makeNote({ title: 'My recipe', content: '# Ingredients\n\n- flour', tags: ['cooking'], category: 'Life' });
    const decoded = decodeSharedNote(encodeSharedNote(note));
    expect(decoded.encrypted).toBe(false);
    expect(decoded.title).toBe('My recipe');
    expect(decoded.content).toBe('# Ingredients\n\n- flour');
    expect(decoded.tags).toEqual(['cooking']);
    expect(decoded.category).toBe('Life');
  });

  it('omits default category and empty tags from the envelope', () => {
    const note = makeNote({ category: 'General', tags: [] });
    const json = atob(encodeSharedNote(note).replace(/-/g, '+').replace(/_/g, '/'));
    expect(json).not.toContain('"g"');
    expect(json).not.toContain('"a"');
    const decoded = decodeSharedNote(encodeSharedNote(note));
    expect(decoded.category).toBe('General');
    expect(decoded.tags).toEqual([]);
  });

  it('handles unicode (emoji, CJK) content', () => {
    const note = makeNote({ content: 'héllo 世界 🎉', title: 'ümlaut ✓' });
    const decoded = decodeSharedNote(encodeSharedNote(note));
    expect(decoded.content).toBe('héllo 世界 🎉');
    expect(decoded.title).toBe('ümlaut ✓');
  });

  it('produces URL-safe output (no + / = characters)', () => {
    const encoded = encodeSharedNote(makeNote({}));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('rejects garbage input with a clear error', () => {
    expect(() => decodeSharedNote('!!!not-base64!!!')).toThrow();
    // Valid base64, invalid JSON
    const badJson = btoa('definitely not json').replace(/\+/g, '-').replace(/\//g, '_');
    expect(() => decodeSharedNote(badJson)).toThrow(/JSON/);
  });

  it('rejects unknown envelope versions', () => {
    const v99 = btoa(JSON.stringify({ v: 99, t: 'x', c: 'y' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(() => decodeSharedNote(v99)).toThrow(/version/);
  });

  it('rejects envelopes that carry both ciphertext and plaintext', () => {
    const both = btoa(
      JSON.stringify({ v: 1, t: 'x', c: 'plaintext!', e: { method: 'password', ciphertext: 'AA==', iv: 'AQ==', salt: 'Ag==' } }),
    ).replace(/\+/g, '-').replace(/\//g, '_');
    expect(() => decodeSharedNote(both)).toThrow(/version|malformed/);
  });
});

describe('share codec (encrypted notes)', () => {
  it('round-trips the EncryptedPayload without exposing plaintext', async () => {
    const plaintext = 'top secret recipe';
    const payload: EncryptedPayload = await encryptWithPassword(plaintext, 'hunter2hunter2');
    const note = makeNote({ content: '[encrypted]', encrypted: payload });

    const encoded = encodeSharedNote(note);
    // Plaintext must not appear anywhere in the encoded payload
    expect(encoded).not.toContain('secret');

    const decoded = decodeSharedNote(encoded);
    expect(decoded.encrypted).toBe(true);
    expect(decoded.payload).toEqual(payload);
    // Content field must NOT carry the placeholder or plaintext
    expect(decoded.content).toBe('');
  });

  it('decrypted shared payload matches the original plaintext', async () => {
    const plaintext = 'round trip me';
    const payload = await encryptWithPassword(plaintext, 'correct horse battery staple');
    const decoded = decodeSharedNote(encodeSharedNote(makeNote({ encrypted: payload, content: '[encrypted]' })));
    const decrypted = await decryptWithPassword(decoded.payload!, 'correct horse battery staple');
    expect(decrypted).toBe(plaintext);
  });

  it('rejects envelopes with a malformed encrypted payload', () => {
    const bad = btoa(JSON.stringify({ v: 1, t: 'x', e: { method: 'nope', ciphertext: 'AA==' } }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(() => decodeSharedNote(bad)).toThrow(/version|malformed/);
  });
});

describe('share URL building & parsing', () => {
  it('builds a URL containing the note param and parses it back', () => {
    const encoded = encodeSharedNote(makeNote({}));
    const url = new URL(buildShareUrl(encoded));
    expect(url.searchParams.has(SHARE_QUERY_PARAM)).toBe(true);
    const parsed = sharedNoteFromSearchParams(url.searchParams);
    expect(parsed?.title).toBe('Test note');
  });

  it('accepts the legacy ?data= param', () => {
    const encoded = encodeSharedNote(makeNote({}));
    const params = new URLSearchParams({ data: encoded });
    expect(sharedNoteFromSearchParams(params)?.title).toBe('Test note');
  });

  it('returns null when no share param is present', () => {
    expect(sharedNoteFromSearchParams(new URLSearchParams())).toBeNull();
  });

  it('keeps typical note links under the 2000-char soft limit', () => {
    const note = makeNote({ content: 'x'.repeat(1000) });
    const url = buildShareUrl(encodeSharedNote(note));
    // 1000 chars of markdown → ~1400 chars of base64 (4/3 inflation)
    expect(url.length).toBeLessThan(2000);
  });
});