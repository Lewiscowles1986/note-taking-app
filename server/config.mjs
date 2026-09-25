// Configuration for the Note Haven reference sync server.
//
// Precedence: built-in defaults < environment overrides (PORT, HOST,
// NOTEHAVEN_DATA_DIR, NOTEHAVEN_ISSUER, NOTEHAVEN_EXCLUDED_CATEGORIES,
// NOTEHAVEN_EXCLUDED_NOTES) < CLI flags (parsed in index.mjs and
// passed in as `args`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExclusions } from './exclusions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  port: 8080,
  host: 'localhost',
  dataDir: path.join(here, 'data'),
  issuer: '',
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 30 * 24 * 3600,
  sessionTtlSeconds: 7 * 24 * 3600,
  authorizationCodeTtlSeconds: 600,
  maxBodyBytes: 1024 * 1024,
  corsMaxAgeSeconds: 86400,
});

export function envOverrides(env = process.env) {
  const overrides = {};
  if (env.PORT) {
    const p = Number.parseInt(env.PORT, 10);
    if (Number.isInteger(p) && p > 0) overrides.port = p;
  }
  if (env.HOST) overrides.host = env.HOST;
  if (env.NOTEHAVEN_DATA_DIR) overrides.dataDir = path.resolve(env.NOTEHAVEN_DATA_DIR);
  if (env.NOTEHAVEN_ISSUER) overrides.issuer = String(env.NOTEHAVEN_ISSUER).replace(/\/+$/, '');
  // Server-side exclusion policy (deny lists). Empty/absent → nothing denied.
  const exclusions = parseExclusions(env);
  if (exclusions.excludedCategories.length || exclusions.excludedUids.length) {
    overrides.exclusions = exclusions;
  }
  return overrides;
}

export function resolveIssuer(host, port, explicitIssuer = '') {
  if (explicitIssuer) return explicitIssuer;
  return `http://${host}:${port}`;
}

export function buildConfig({ args = {}, env = process.env } = {}) {
  const merged = { ...DEFAULTS, ...envOverrides(env), ...args };
  // Exclusion policy always exists on the config object (empty = nothing
  // denied) so route handlers never need an undefined check.
  merged.exclusions = {
    excludedCategories: [],
    excludedUids: [],
    ...merged.exclusions,
  };
  merged.issuer = resolveIssuer(merged.host, merged.port, merged.issuer);
  return merged;
}