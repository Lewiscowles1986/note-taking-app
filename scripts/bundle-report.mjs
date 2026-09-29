#!/usr/bin/env node
/**
 * bundle-report.mjs — side-by-side bundle comparison from build sourcemaps.
 *
 * Usage:
 *   node scripts/bundle-report.mjs <baselineDir> <variantDir> [--full]
 *   (npm run bundle:compare wires this up: dist vs dist-nosync)
 *
 * How it works:
 *   1. Walks each build's assets/*.js + .map files.
 *   2. For every chunk, parses the sourcemap's `sources` array and attributes
 *      each source's byte share (proportional to its generated length) to the
 *      OWNING package: the first `node_modules/<pkg>` segment of the source
 *      path, or "app" for first-party modules.
 *   3. Aggregates per package and diffs the two builds, sorted by absolute
 *      saving (what you remove by shipping no sync).
 *
 * The numbers are ESTIMATES — sourcemap sources partition a chunk's bytes
 * proportionally, not exactly. Direction and magnitude are reliable; the last
 * digit is not. Gzip is not measured.
 *
 * Report-only: exits 0 unless a directory is missing (usage error).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const [baselineDir, variantDir] = process.argv.slice(2);
if (!baselineDir || !variantDir) {
  console.error('usage: node scripts/bundle-report.mjs <baselineDir> <variantDir>');
  process.exit(1);
}
for (const dir of [baselineDir, variantDir]) {
  if (!existsSync(dir)) {
    console.error(`missing build directory: ${dir} (build it first)`);
    process.exit(1);
  }
}

const PKG_RE = /node_modules\/((?:@[^/]+\/)?[^/]+)/;

/** owner package for a source path: npm package name, or "app" for src/. */
function ownerOf(source) {
  if (source.startsWith('\0')) return 'vite:plugins'; // virtual modules
  const m = source.match(PKG_RE);
  if (m) return m[1];
  if (source.includes('/src/')) return 'app';
  return 'other';
}

/** Walk a directory collecting relative paths of *.js (excluding .map). */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Attribute one chunk: returns { total, Map<owner, bytes> }. Weights come
 * from the sourcemap's sourcesContent lengths when available (an ESTIMATE of
 * each source's generated share — minification shifts it), else an even
 * split across sources.
 */
function attribute(chunkPath) {
  const js = readFileSync(chunkPath);
  const mapPath = `${chunkPath}.map`;
  const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
  if (!map || !Array.isArray(map.sources) || map.sources.length === 0) {
    return { total: js.length, shares: new Map([['unattributed', js.length]]) };
  }

  const n = map.sources.length;
  const shares = new Map();
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const weights = map.sources.map((_, i) => {
    const c = contents[i];
    return typeof c === 'string' && c.length > 0 ? c.length : 1;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const bytes = Math.round((js.length * weights[i]) / totalWeight);
    const owner = ownerOf(map.sources[i]);
    shares.set(owner, (shares.get(owner) ?? 0) + bytes);
  }
  return { total: js.length, shares };
}

/** Aggregate a build dir → { total, perOwner: Map } */
function analyse(dir) {
  const chunks = walk(dir);
  const perOwner = new Map();
  let total = 0;
  for (const chunk of chunks) {
    const { total: size, shares } = attribute(chunk);
    total += size;
    for (const [owner, bytes] of shares) perOwner.set(owner, (perOwner.get(owner) ?? 0) + bytes);
  }
  return { total, perOwner, chunkCount: chunks.length };
}

const fmt = (n) => n.toLocaleString('en-GB');

const a = analyse(baselineDir);
const b = analyse(variantDir);

const owners = new Set([...a.perOwner.keys(), ...b.perOwner.keys()]);
const rows = [...owners]
  .map((owner) => ({
    owner,
    baseline: a.perOwner.get(owner) ?? 0,
    variant: b.perOwner.get(owner) ?? 0,
  }))
  .map((r) => ({ ...r, delta: r.baseline - r.variant }))
  .sort((x, y) => y.delta - x.delta || y.baseline - x.baseline);

console.log('Bundle comparison — sourcemap attribution (estimates, uncompressed)');
console.log(`baseline: ${baselineDir} (${a.chunkCount} chunks, ${fmt(a.total)} B)`);
console.log(`variant:  ${variantDir} (${b.chunkCount} chunks, ${fmt(b.total)} B)`);
console.log('');
console.log('| owner (npm pkg / app) | baseline B | no-sync B | delta B (saved) |');
console.log('|---|---:|---:|---:|');
for (const r of rows.slice(0, 40)) {
  console.log(
    `| ${r.owner} | ${fmt(r.baseline)} | ${fmt(r.variant)} | ${r.delta > 0 ? '-' : '+'}${fmt(Math.abs(r.delta))} |`,
  );
}
if (rows.length > 40) console.log(`| … ${rows.length - 40} more rows | … | … | … |`);

const appBaseline = a.perOwner.get('app') ?? 0;
const appVariant = b.perOwner.get('app') ?? 0;
console.log('');
console.log(
  `First-party ("app") total: ${fmt(appBaseline)} B -> ${fmt(appVariant)} B  (delta ${fmt(appBaseline - appVariant)} B)`,
);
console.log('');
console.log(`Largest chunks in ${baselineDir}:`);
const sized = walk(baselineDir)
  .map((p) => ({ p: relative(baselineDir, p), size: statSync(p).size }))
  .sort((x, y) => y.size - x.size)
  .slice(0, 8);
for (const s of sized) console.log(`  ${fmt(s.size)}  ${s.p}`);