/**
 * Build-time stub for src/lib/sync.ts — compiled in ONLY when
 * `VITE_NO_SYNC=1` (vite.config.ts aliases the module here; see
 * scripts/bundle-report.mjs for what this measures).
 *
 * Every export mirrors the real module's name and shape so consumers typecheck
 * unchanged, but the bodies are dependency-free: no fetches, no storage, no
 * engine. `runSync`/`runSyncIfConfigured` reject with `SyncError` so any UI
 * action that would have synced reports "Sync is disabled in this build"
 * instead of silently doing nothing.
 */

import type { Note } from '@/lib/db';
// Type-only import: the real syncSettings module is tiny, dependency-free and
// stays in the bundle via syncServers — this costs zero bytes.
import type { Tombstone } from '@/lib/syncSettings';

/** Mirrors the real engine's error type so `catch (e instanceof SyncError)` paths behave. */
export class SyncError extends Error {}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/** Exclusion lists advertised by a server in its discovery document. */
export interface ServerExclusions {
  excludedCategories: string[];
  excludedUids: string[];
}

const NO_EXCLUSIONS: ServerExclusions = { excludedCategories: [], excludedUids: [] };

/** JSON-ready note as it travels over the wire. Shape-only in the stub. */
export interface SyncPayload {
  uid: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  createdAt: string;
  updatedAt: string;
  editDates: string[];
  pinned: boolean;
}

/** Manifest entry describing a remote note without its body. */
export interface RemoteNoteMeta {
  uid: string;
  updatedAt: string;
  deleted?: boolean;
}

/** Serializable view of a local note the planner works on. */
export interface LocalNoteMeta {
  noteId: number;
  uid: string;
  title: string;
  updatedAt: string;
  category?: string;
}

export type SyncOp =
  | { kind: 'push'; uid: string; noteId: number }
  | { kind: 'pull'; uid: string; noteId: number | null }
  | { kind: 'delete-local'; uid: string; noteId: number }
  | { kind: 'delete-remote'; uid: string };

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  errors: string[];
  summary: string;
}

const DISABLED = 'Sync is disabled in this build (VITE_NO_SYNC)';

/** The one function the eager note list needs (sidebar "server-denied" badge). */
export function parseDiscoveryExclusions(data: unknown): ServerExclusions {
  const notes = (data as { notes?: unknown } | null)?.notes;
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return { ...NO_EXCLUSIONS };
  const toList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  return {
    excludedCategories: toList((notes as { excluded_categories?: unknown }).excluded_categories),
    excludedUids: toList((notes as { excluded_uids?: unknown }).excluded_uids),
  };
}

export async function fetchServerExclusions(): Promise<ServerExclusions> {
  return { ...NO_EXCLUSIONS };
}

/** Never syncs: rejects so the UI surfaces an explicit "disabled" message. */
export async function runSync(): Promise<SyncResult> {
  throw new SyncError(DISABLED);
}

/** Scheduler tick path: a no-op build has nothing configured to sync. */
export async function runSyncIfConfigured(): Promise<SyncResult | null> {
  return null;
}

export function getUidForNoteId(): string | null {
  return null;
}

export function assignUidForNoteId(): string {
  throw new SyncError(DISABLED);
}

export async function deleteNoteForUid(): Promise<boolean> {
  return false;
}

export function pruneUidMap(): void {}

export function buildSyncPayload(): SyncPayload {
  throw new SyncError(DISABLED);
}

export function payloadToNote(payload: Partial<SyncPayload>): Note {
  throw new SyncError(DISABLED);
}

export function planSync(): SyncOp[] {
  throw new SyncError(DISABLED);
}

export function parseManifest(data: unknown): RemoteNoteMeta[] {
  void data;
  throw new SyncError(DISABLED);
}