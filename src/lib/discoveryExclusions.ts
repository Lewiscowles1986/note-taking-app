/**
 * Discovery-document exclusion parsing — a LEAF module on purpose.
 *
 * Index.tsx needs exactly one function (parseDiscoveryExclusions) to flag
 * notes whose category the server refuses to store. Importing that from the
 * sync engine (src/lib/sync.ts) used to drag the whole engine — planner,
 * payload builder, orchestrator, authToken/OIDC seam — into the EAGER chunk,
 * because bundlers eliminate code at module granularity, not per function.
 *
 * Keep this file dependency-free: it must be safe to import from anywhere
 * (eager or lazy) without pulling the engine along.
 */

/** Exclusion lists advertised by a server in its discovery document. */
export interface ServerExclusions {
  excludedCategories: string[];
  excludedUids: string[];
}

const NO_EXCLUSIONS: ServerExclusions = { excludedCategories: [], excludedUids: [] };

/** Shared empty shape (sync.ts reuses it for its best-effort fetch fallback). */
export { NO_EXCLUSIONS };

/**
 * Extract `notes.excluded_categories` / `notes.excluded_uids` from a discovery
 * document. Tolerates absent/invalid shapes (older servers, wrong types) by
 * returning empty lists — the server still enforces its own policy on PUT.
 */
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