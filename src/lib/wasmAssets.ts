/**
 * Load vendored wasm bundle assets.
 *
 * Large wasm binaries are committed gzipped (see scripts/vendor-wasm.mjs) to
 * keep the repo and the GitHub Pages deployment within size limits. Each bundle
 * carries a vendor.json listing its loader module, its exported entry point and
 * which files are gzipped; this module reads that manifest and returns
 * decompressed bytes, so runners do not each re-implement the fetch.
 */

export interface VendorManifest {
  loader: string;
  api: string | null;
  gzip: string[];
  files: Record<string, { bytes: number; sha256: string }>;
}

/** The generated catalog of vendored bundles, written by build-wasm-index.mjs. */
export interface WasmIndex {
  schema: number;
  language: string;
  latest: string | null;
  bundles: { version: string; directory: string }[];
}

const indexCache = new Map<string, Promise<WasmIndex>>();

/**
 * Fetch the bundle catalog for a language. A static site cannot list a
 * directory, so the vendoring step writes public/<lang>-wasm/index.json; this
 * is what lets the code block offer whatever has actually been vendored without
 * a hardcoded version list drifting out of sync.
 */
export async function loadWasmIndex(language: string): Promise<WasmIndex> {
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}${language}-wasm/index.json`;
  let pending = indexCache.get(language);
  if (!pending) {
    pending = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Bundle catalog missing: HTTP ${res.status}`);
      return res.json() as Promise<WasmIndex>;
    });
    indexCache.set(language, pending);
  }
  return pending;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress gzip assets (DecompressionStream is unavailable).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadVendorManifest(dir: string): Promise<VendorManifest> {
  const res = await fetch(`${dir}vendor.json`);
  if (!res.ok) throw new Error(`Bundle manifest missing: HTTP ${res.status}`);
  return (await res.json()) as VendorManifest;
}

/** Fetch one bundle file, decompressing it only when the bytes really are gzip. */
export async function loadAsset(
  dir: string,
  name: string,
  manifest: VendorManifest,
): Promise<Uint8Array> {
  const gzipped = manifest.gzip.includes(name);
  const res = await fetch(`${dir}${name}${gzipped ? '.gz' : ''}`);
  if (!res.ok) throw new Error(`Could not load ${name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A dev/preview server (or a production host) may serve a .gz file with
  // `Content-Encoding: gzip`, so the browser decodes it before we see it.
  // Detect by the gzip magic bytes (0x1f 0x8b) rather than the manifest, so
  // both already-decoded and raw-gzip responses work.
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzip(bytes);
  }
  return bytes;
}
