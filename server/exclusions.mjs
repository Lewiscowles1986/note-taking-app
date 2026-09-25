// Exclusion policy for the sync server — the sysadmin's deny list.
//
// Two environment variables configure server-side exclusions:
//   NOTEHAVEN_EXCLUDED_CATEGORIES  comma-separated category names
//   NOTEHAVEN_EXCLUDED_NOTES       comma-separated note uids
//
// Matching is EXACT and case-sensitive (a category is whatever string the
// client puts in the note payload's `category` field — there is no canonical
// casing to normalize against). Entries are trimmed of surrounding whitespace;
// empty entries (stray commas, empty values) are dropped. Absent/empty env
// vars mean "nothing is excluded" — the server never invents policy.
//
// These lists are ADVERTISED in the discovery document (notes.excluded_*)
// so clients can show why a note will not sync, and ENFORCED on the API:
// PUT for an excluded category/uid → 403; the manifest never lists excluded
// uids (their existence is not even leaked). DELETE is exempt — exclusions
// govern content sync, not lifecycle bookkeeping.

/**
 * Parse a comma-separated env value into a list of non-empty trimmed strings.
 * Order is preserved (stable, presentation order in discovery); duplicates
 * are removed. `undefined`/empty → [].
 */
export function parseListEnv(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [...new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )];
}

export function parseExclusions(env = process.env) {
  return {
    excludedCategories: parseListEnv(env.NOTEHAVEN_EXCLUDED_CATEGORIES),
    excludedUids: parseListEnv(env.NOTEHAVEN_EXCLUDED_NOTES),
  };
}

/** True when a note payload's category is denied by server policy. */
export function isCategoryExcluded(exclusions, category) {
  return typeof category === 'string' && exclusions.excludedCategories.includes(category);
}

/** True when a uid is denied by server policy. */
export function isUidExcluded(exclusions, uid) {
  return typeof uid === 'string' && exclusions.excludedUids.includes(uid);
}

/**
 * Discovery fragment advertising the exclusion policy. Empty when nothing is
 * excluded — the discovery document stays byte-identical to the pre-exclusion
 * shape on servers that do not opt in.
 */
export function exclusionDiscoveryFields(exclusions) {
  if (exclusions.excludedCategories.length === 0 && exclusions.excludedUids.length === 0) {
    return {};
  }
  return {
    notes: {
      excluded_categories: exclusions.excludedCategories,
      excluded_uids: exclusions.excludedUids,
    },
  };
}