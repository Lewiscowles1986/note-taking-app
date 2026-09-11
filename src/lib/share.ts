/**
 * Share a note via a self-contained URL query-string argument.
 *
 * The note is serialised to a compact JSON envelope, UTF-8 encoded and
 * base64url-encoded into a `?note=` (or legacy `?data=`) query parameter. The
 * receiving side decodes the envelope with `decodeSharedNote` and imports it as
 * a local note — no server, no account, no central coordination of any kind.
 *
 * Encrypted notes carry their `EncryptedPayload` (ciphertext, IV, salt /
 * wrapped key) verbatim: the plaintext never enters the URL. The recipient
 * still needs the password or private key to unlock the note.
 *
 * Security notes:
 * - For UNencrypted notes the markdown itself travels in the URL. Anyone who
 *   obtains the link can read it (and intermediaries see it in their logs).
 *   The UI must make this trade-off explicit before a link is generated.
 * - URLs should be treated as ephemeral channels; long URLs (>~2000 chars for
 *   maximum compatibility) may be truncated by some messengers.
 */

import type { Note } from './db';
import type { EncryptedPayload } from './crypto';

/** Current envelope version. Bump when the shape changes. */
const SHARE_VERSION = 1;

/** Query parameter carrying the base64url envelope. */
export const SHARE_QUERY_PARAM = 'note';

/** Soft cap for the generated link length (messenger/QR friendliness). */
export const SHARE_URL_SOFT_LIMIT = 2000;

/** Wire format: `v` version, `t` title, `g` category, `a` tags, then content or encrypted payload. */
interface SharedNoteEnvelopeV1 {
  v: 1;
  /** Note title */
  t: string;
  /** Category (omitted when 'General') */
  g?: string;
  /** Tags (omitted when empty) */
  a?: string[];
  /** Plaintext markdown — present only for unencrypted notes */
  c?: string;
  /** Encrypted payload — present only for encrypted notes (ciphertext only) */
  e?: EncryptedPayload;
}

/** The decoded contents of a share link. */
export interface SharedNote {
  /** True when the envelope carries an EncryptedPayload instead of plaintext. */
  encrypted: boolean;
  title: string;
  category: string;
  tags: string[];
  /** Plaintext markdown (only when `encrypted === false`). */
  content: string | null;
  /** Ciphertext payload (only when `encrypted === true`). */
  payload: EncryptedPayload | null;
  /** Byte length of the encoded envelope before base64 inflation. */
  byteLength: number;
}

// ─── base64url (RFC 4648 §5) helpers ────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// ─── encode / decode ────────────────────────────────────────────

/**
 * Build the share envelope for a note.
 *
 * For an encrypted note the plaintext is never read — only `note.encrypted`
 * (ciphertext + metadata) is embedded, mirroring the export behaviour. Callers
 * must pass the *encrypted* note row (content placeholder irrelevant here).
 */
export function encodeSharedNote(note: Note): string {
  const envelope: SharedNoteEnvelopeV1 = {
    v: SHARE_VERSION,
    t: note.title,
  };
  if (note.category && note.category !== 'General') envelope.g = note.category;
  if (note.tags.length) envelope.a = note.tags;

  if (note.encrypted) {
    // Hard rule (same as exports): never read `content` of an encrypted note
    // — it is either the "[encrypted]" placeholder or, if a caller passed
    // decrypted content by mistake, that would be a plaintext leak.
    envelope.e = note.encrypted;
  } else {
    envelope.c = note.content;
  }

  const json = JSON.stringify(envelope);
  return bytesToBase64Url(utf8.encode(json));
}

/**
 * Inverse of `encodeSharedNote`. Throws on malformed input (bad base64, bad
 * JSON, unknown version) so callers can show an error instead of importing
 * garbage.
 */
export function decodeSharedNote(encoded: string): SharedNote {
  const raw = base64UrlToBytes(encoded.trim());
  let envelope: unknown;
  try {
    envelope = JSON.parse(utf8Decode.decode(raw));
  } catch {
    throw new Error('Invalid share link: payload is not valid JSON');
  }

  if (!isEnvelopeV1(envelope)) {
    throw new Error('Unsupported share-link version or malformed payload');
  }

  const encrypted = envelope.e !== undefined;
  return {
    encrypted,
    title: typeof envelope.t === 'string' && envelope.t ? envelope.t : 'Shared note',
    category: envelope.g ?? 'General',
    tags: Array.isArray(envelope.a) ? envelope.a.filter((t) => typeof t === 'string') : [],
    content: typeof envelope.c === 'string' ? envelope.c : '',
    payload: envelope.e ?? null,
    byteLength: raw.length,
  };
}

function isEnvelopeV1(value: unknown): value is SharedNoteEnvelopeV1 {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== SHARE_VERSION) return false;
  if (typeof v.t !== 'string') return false;
  if (v.g !== undefined && typeof v.g !== 'string') return false;
  if (v.a !== undefined && !Array.isArray(v.a)) return false;
  if (v.c !== undefined && typeof v.c !== 'string') return false;
  if (v.e !== undefined) {
    const e = v.e as Record<string, unknown>;
    if (
      typeof e !== 'object' ||
      e === null ||
      (e.method !== 'password' && e.method !== 'keypair') ||
      typeof e.ciphertext !== 'string' ||
      typeof e.iv !== 'string'
    ) {
      return false;
    }
  }
  // Encrypted envelopes must not also carry plaintext.
  if (v.e !== undefined && v.c !== undefined) return false;
  return true;
}

/** Build the full share URL for the encoded envelope. */
export function buildShareUrl(encoded: string): string {
  const base = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams();
  params.set(SHARE_QUERY_PARAM, encoded);
  return `${base}?${params.toString()}`;
}

/** Extract + decode a shared note from a URL query string (or raw param). */
export function sharedNoteFromSearchParams(searchParams: URLSearchParams): SharedNote | null {
  const encoded = searchParams.get(SHARE_QUERY_PARAM) ?? searchParams.get('data');
  if (!encoded) return null;
  return decodeSharedNote(encoded);
}