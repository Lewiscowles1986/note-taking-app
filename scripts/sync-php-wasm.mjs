#!/usr/bin/env node
/**
 * Mirror the PHP wasm builds from a sibling php-wasm-builder checkout.
 *
 * The builder exports one directory per PHP line (`builds/auto/build-8.4.x/`)
 * and the patch version lives inside the wasm, not the directory name. This
 * script keeps that shape: public/php-wasm/build-8.4.x/ mirrors the builder's
 * output, so a patch release replaces the bundle in place instead of adding a
 * second directory for the same line.
 *
 * Versions come from the build itself (the `X-Powered-By: PHP/<version>`
 * string compiled into every SAPI), cross-checked against the builder's
 * docker-bake.hcl when it pins that series. Nothing is guessed and nothing is
 * fetched: the manifest this writes is the entire list of supported versions.
 *
 * Usage:
 *   node scripts/sync-php-wasm.mjs [--builder <path>] [--dry-run]
 *                                  [--no-prune] [--default <version>]
 *
 * The builder must be a clone of github.com/Lewiscowles1986/php-wasm-builder;
 * the script refuses anything else rather than vendoring a stranger's wasm.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public', 'php-wasm');
const MANIFEST_PATH = join(REPO_ROOT, 'src', 'lib', 'phpWasm.manifest.json');
const VENDOR_SCRIPT = join(REPO_ROOT, 'scripts', 'vendor-wasm.mjs');

const BUILDER_OWNER = 'lewiscowles1986';
const BUILDER_REPO = 'php-wasm-builder';
const BUILDER_URL = `https://github.com/Lewiscowles1986/${BUILDER_REPO}.git`;

/**
 * Bundles the builder cannot produce: its Dockerfile targets PHP 8.x only.
 * They are kept and listed, never regenerated.
 */
const LEGACY_DIRECTORIES = ['build-5.4.x', 'build-7.4.x'];

/** Files the runner never loads; vendoring them would double the repo cost. */
const DROP_FILES = ['php-cli.mjs', 'php-cli.wasm'];

function usage() {
  return [
    'usage: node scripts/sync-php-wasm.mjs [options]',
    '',
    '  --builder <path>      php-wasm-builder checkout (default: ../php-wasm-builder)',
    '  --dry-run             report what would change without writing anything',
    '  --no-prune            keep bundle directories the builder does not produce',
    '  --default <version>   override the default version (default: newest bundle)',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    builder: resolve(REPO_ROOT, '..', BUILDER_REPO),
    dryRun: false,
    prune: true,
    defaultVersion: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--builder') {
      options.builder = resolve(REPO_ROOT, argv[++i] ?? '');
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-prune') {
      options.prune = false;
    } else if (arg === '--default') {
      options.defaultVersion = argv[++i] ?? null;
    } else {
      console.error(`sync-php-wasm: unknown argument: ${arg}\n\n${usage()}`);
      process.exit(2);
    }
  }
  return options;
}

function fail(message) {
  console.error(`sync-php-wasm: ${message}`);
  process.exit(1);
}

/** Numeric-ish comparison so 8.6.0 sorts after 8.5.13 and 5.4.45 before 7.4.33. */
function compareVersions(a, b) {
  const key = (v) => v.split(/[-+]/)[0].split('.').map((p) => parseInt(p, 10) || 0);
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function seriesOf(version) {
  return version.split('.').slice(0, 2).join('.');
}

/** `build-8.4.x` for PHP 8.4.28 — the builder's own directory shape. */
function directoryFor(version) {
  return `build-${seriesOf(version)}.x`;
}

/**
 * Reject a checkout that is not the project's builder. Matching on the remote
 * URL catches both an unrelated clone and a builder that was pointed at a
 * different fork, before any of its bytes reach public/.
 */
function assertBuilderRemote(builder) {
  let remotes;
  try {
    remotes = execFileSync('git', ['-C', builder, 'remote', '-v'], { encoding: 'utf8' });
  } catch {
    fail(
      `${builder} is not a git checkout of ${BUILDER_URL}.\n` +
        `Clone it with:\n\n  git clone ${BUILDER_URL} "${builder}"`,
    );
  }

  const urlPattern = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$)/i;
  const matches = remotes
    .split('\n')
    .map((line) => urlPattern.exec(line))
    .filter(Boolean);

  const isOurs = matches.some(
    ([, owner, repo]) =>
      owner.toLowerCase() === BUILDER_OWNER && repo.toLowerCase() === BUILDER_REPO,
  );

  if (!isOurs) {
    const found = matches.length ? matches.map(([url]) => `  ${url}`).join('\n') : '  (none)';
    fail(
      `${builder} does not point at ${BUILDER_URL}.\n` +
        `Remotes found:\n${found}\n\n` +
        `Point it at the right repository, or clone it alongside this repo:\n\n` +
        `  git clone ${BUILDER_URL} "${builder}"`,
    );
  }
}

/** PHP_VERSION pins from docker-bake.hcl, keyed by target output series. */
function readBakeVersions(builder) {
  const bakePath = join(builder, 'docker-bake.hcl');
  const versions = new Map();
  if (!existsSync(bakePath)) return versions;

  const bake = readFileSync(bakePath, 'utf8');
  const targetPattern = /target\s+"[^"]+"\s*\{([\s\S]*?)\n\}/g;
  for (const [, body] of bake.matchAll(targetPattern)) {
    const output = /dest\s*=\s*\.?\/?builds\/auto\/build-([0-9]+\.[0-9]+)\.x/.exec(body);
    const version = /PHP_VERSION\s*=\s*"([^"]+)"/.exec(body);
    if (output && version) versions.set(output[1], version[1]);
  }
  return versions;
}

/**
 * Read the PHP version out of the compiled wasm. Every SAPI reports it in its
 * default headers, so the marker is part of the binary rather than metadata
 * that could drift from it.
 */
function detectVersion(bundleDir) {
  const wasmPath = join(bundleDir, 'php-web.wasm');
  if (!existsSync(wasmPath)) return null;
  const marker = /X-Powered-By: PHP\/(\d+\.\d+\.\d+)/.exec(readFileSync(wasmPath).toString('latin1'));
  return marker ? marker[1] : null;
}

function vendorBundle({ from, to, version, dryRun }) {
  const args = [
    VENDOR_SCRIPT,
    '--from',
    from,
    '--to',
    to,
    '--loader',
    'php-web.mjs',
    '--api',
    'default',
    '--version',
    version,
    '--drop',
    DROP_FILES.join(','),
  ];
  if (dryRun) return;
  execFileSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { builder, dryRun } = options;

  if (!existsSync(builder)) {
    fail(
      `no php-wasm-builder checkout at ${builder}.\n\n` +
        `Clone it next to this repository:\n\n  git clone ${BUILDER_URL} "${builder}"\n\n` +
        `then run builds with:\n\n  cd "${builder}" && docker buildx bake`,
    );
  }
  assertBuilderRemote(builder);

  const buildsRoot = join(builder, 'builds');
  if (!existsSync(buildsRoot)) {
    fail(
      `no builds/ directory in ${builder}.\n\n` +
        `Build the matrix first:\n\n  cd "${builder}" && docker buildx bake`,
    );
  }

  const bakeVersions = readBakeVersions(builder);
  const buildDirs = [];
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name.startsWith('build-')) {
        if (existsSync(join(full, 'php-web.wasm'))) buildDirs.push(full);
      } else if (entry.isDirectory() && depth > 0) {
        walk(full, depth - 1);
      }
    }
  };
  walk(buildsRoot, 2);

  if (buildDirs.length === 0) {
    fail(
      `no build-* directories with php-web.wasm under ${buildsRoot}.\n\n` +
        `Build the matrix first:\n\n  cd "${builder}" && docker buildx bake`,
    );
  }

  const bundles = [];
  for (const dir of buildDirs.sort()) {
    const detected = detectVersion(dir);
    const series = /build-([0-9]+\.[0-9]+)\.x$/.exec(dir)?.[1];
    const pinned = series ? bakeVersions.get(series) : undefined;

    if (detected && pinned && detected !== pinned) {
      fail(
        `${dir} contains PHP ${detected} but docker-bake.hcl pins ${pinned}.\n` +
          `The checkout is out of sync with its build output — rebuild, or update the bake file.`,
      );
    }
    const version = detected ?? pinned;
    if (!version) {
      fail(
        `could not determine the PHP version of ${dir}: no X-Powered-By marker and no bake pin.\n` +
          `Check that php-web.wasm is a complete build.`,
      );
    }
    bundles.push({ from: dir, version, directory: directoryFor(version) });
  }

  const seen = new Map();
  for (const bundle of bundles) {
    if (seen.has(bundle.directory)) {
      fail(
        `${seen.get(bundle.directory)} and ${bundle.from} are both PHP ${bundle.directory} ` +
          `(${seen.get(bundle.directory)} vs ${bundle.version}). The matrix builds one patch per line.`,
      );
    }
    seen.set(bundle.directory, bundle.version);
  }

  // Validate the requested default before writing anything, so a typo cannot
  // leave a half-updated tree behind.
  const legacyVersions = LEGACY_DIRECTORIES.flatMap((directory) => {
    const vendorPath = join(PUBLIC_DIR, directory, 'vendor.json');
    if (!existsSync(vendorPath)) return [];
    const { version } = JSON.parse(readFileSync(vendorPath, 'utf8'));
    return version ? [version] : [];
  });
  if (
    options.defaultVersion &&
    ![...bundles.map((b) => b.version), ...legacyVersions].includes(options.defaultVersion)
  ) {
    fail(
      `--default ${options.defaultVersion} is not one of the vendored versions: ` +
        [...bundles.map((b) => b.version), ...legacyVersions].join(', '),
    );
  }

  for (const bundle of bundles) {
    const to = join(PUBLIC_DIR, bundle.directory);
    console.log(`${dryRun ? '[dry-run] ' : ''}${bundle.directory} <- PHP ${bundle.version}`);
    vendorBundle({ from: bundle.from, to, version: bundle.version, dryRun });
  }

  const keep = new Set([...bundles.map((b) => b.directory), ...LEGACY_DIRECTORIES]);
  if (existsSync(PUBLIC_DIR)) {
    for (const entry of readdirSync(PUBLIC_DIR)) {
      if (!entry.startsWith('build-') || keep.has(entry)) continue;
      const path = join(PUBLIC_DIR, entry);
      if (!statSync(path).isDirectory()) continue;
      if (!options.prune) {
        console.log(`keeping ${entry} (pruning disabled)`);
        continue;
      }
      console.log(`${dryRun ? '[dry-run] ' : ''}removing ${entry}`);
      if (!dryRun) rmSync(path, { recursive: true, force: true });
    }
  }

  const manifestBundles = [];
  for (const directory of keep) {
    const dir = join(PUBLIC_DIR, directory);
    const vendorPath = join(dir, 'vendor.json');
    if (!existsSync(vendorPath)) {
      if (LEGACY_DIRECTORIES.includes(directory)) {
        console.warn(`sync-php-wasm: legacy bundle ${directory} is missing; it is not listed`);
        continue;
      }
      fail(`expected ${vendorPath} after vendoring; nothing was written for ${directory}`);
    }
    const vendor = JSON.parse(readFileSync(vendorPath, 'utf8'));
    const version =
      vendor.version ?? bundles.find((b) => b.directory === directory)?.version ?? null;
    if (!version) fail(`${vendorPath} has no version; re-vendor ${directory}`);
    manifestBundles.push({
      version,
      directory,
      source: LEGACY_DIRECTORIES.includes(directory) ? 'legacy' : BUILDER_REPO,
    });
  }
  manifestBundles.sort(
    (a, b) => compareVersions(a.version, b.version) || a.directory.localeCompare(b.directory),
  );

  const defaultVersion =
    options.defaultVersion ?? manifestBundles[manifestBundles.length - 1]?.version ?? null;
  const manifest = {
    schema: 1,
    language: 'php',
    default: defaultVersion,
    bundles: manifestBundles,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (dryRun) {
    console.log(`\n[dry-run] ${MANIFEST_PATH} would list ${manifestBundles.length} bundles, default ${defaultVersion}`);
    return;
  }
  writeFileSync(MANIFEST_PATH, json);
  console.log(`\n${MANIFEST_PATH}: ${manifestBundles.length} bundles, default ${defaultVersion}`);
}

main();
