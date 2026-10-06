#!/usr/bin/env node
/**
 * Generate the bundle catalog the runner lists versions from.
 *
 * A static site cannot list a directory, so this scans each public/<language>-wasm
 * build-* directory for its build manifest and writes public/<language>-wasm/index.json.
 * Add a bundle, re-run this, and it appears in the code block's version selector with
 * no TypeScript change — which is what keeps the list from drifting out of sync
 * with what is actually vendored.
 *
 * Usage:
 *   node scripts/build-wasm-index.mjs ruby
 *   node scripts/build-wasm-index.mjs python elixir
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const langs = process.argv.slice(2);
if (langs.length === 0) {
  console.error('usage: build-wasm-index.mjs <language> [language...]');
  process.exit(2);
}

/** Compare version labels such as 1.10.4, 3.15.0rc2 and 1.8.7-p374. */
function compareVersions(a, b) {
  const key = (v) => v.split(/[-+]/)[0].split('.').map((p) => parseInt(p, 10) || 0);
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read the version from whichever key the builder's manifest uses. */
function versionOf(manifest, fallback) {
  return manifest.ruby_version ?? manifest.elixir ?? manifest.version ?? manifest.source_version ?? fallback;
}

let failed = false;
for (const lang of langs) {
  const dir = join(process.cwd(), 'public', `${lang}-wasm`);
  if (!existsSync(dir)) {
    console.error(`${lang}: no such directory: ${dir}`);
    failed = true;
    continue;
  }

  const bundles = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('build-')) continue;
    const bundleDir = entry.slice('build-'.length);
    const manifestPath = join(dir, entry, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const id = typeof manifest.id === 'string' && manifest.id.startsWith('browser-')
      ? manifest.id.slice('browser-'.length)
      : bundleDir;
    bundles.push({ version: versionOf(manifest, bundleDir), directory: id });
  }

  bundles.sort((a, b) => compareVersions(a.version, b.version) || a.directory.localeCompare(b.directory));
  const latest = bundles[bundles.length - 1]?.version ?? null;
  writeFileSync(
    join(dir, 'index.json'),
    `${JSON.stringify({ schema: 1, language: lang, latest, bundles }, null, 2)}\n`,
  );
  console.log(`${lang}: ${bundles.length} bundles, latest ${latest}`);
}

process.exit(failed ? 1 : 0);
