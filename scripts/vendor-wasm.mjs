#!/usr/bin/env node
/**
 * Vendor a wasm bundle from a sibling builder into public/<lang>-wasm/.
 *
 * Copies the runtime files a runner needs, gzips anything over a threshold
 * (browsers decompress it with DecompressionStream, saving ~3x on the wire and
 * in the repo), and writes vendor.json describing what was written so the
 * runner and the bundle-integrity tests agree on file names, gzip flags and
 * raw digests.
 *
 * Usage:
 *   node scripts/vendor-wasm.mjs --from <bundleDir> --to <outDir> \
 *     --loader runtime.mjs --api createVM --drop inspection.json,smoke.json,probes.json,README
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GZIP_THRESHOLD = 512 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const from = arg('from');
const to = arg('to');
const loader = arg('loader');
if (!from || !to || !loader) {
  console.error('usage: vendor-wasm.mjs --from <bundle> --to <out> --loader <file.mjs> [--drop a,b] [--api name]');
  process.exit(2);
}
const drop = new Set((arg('drop', '') || '').split(',').filter(Boolean));
const keep = new Set((arg('keep', '') || '').split(',').filter(Boolean));
const api = arg('api', null);
const version = arg('version', null);

if (!existsSync(from)) {
  console.error(`vendor-wasm: no such bundle: ${from}`);
  process.exit(2);
}

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });

const entries = readdirSync(from);
const files = {};
const gz = [];

for (const name of entries) {
  if (drop.has(name)) continue;
  const src = join(from, name);
  const stat = statSync(src);
  if (stat.isDirectory()) {
    // Licences and similar subdirectories are copied verbatim.
    cpSync(src, join(to, name), { recursive: true });
    continue;
  }
  const raw = readFileSync(src);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  files[name] = { bytes: raw.length, sha256 };
  const alreadyCompressed = name.endsWith('.gz') || (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b);
  if (raw.length > GZIP_THRESHOLD && !alreadyCompressed && !keep.has(name)) {
    writeFileSync(join(to, `${name}.gz`), gzipSync(raw, { level: 9 }));
    gz.push(name);
  } else {
    writeFileSync(join(to, name), raw);
  }
}

writeFileSync(
  join(to, 'vendor.json'),
  `${JSON.stringify({ version, loader, api, gzip: gz.sort(), files }, null, 2)}\n`,
);

console.log(`${to}: ${Object.keys(files).length} files, ${gz.length} gzipped`);
for (const name of gz) console.log(`  gz ${name}`);
