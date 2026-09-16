/**
 * Frontmatter parsing for Swagger/OpenAPI code blocks.
 *
 * Follows the same "deliberately simple, YAML-like" conventions as
 * src/lib/codeBlockFrontmatter.ts: the header starts on the first line and
 * ends at the first line that is exactly "---" (no closing marker required).
 * Everything after that line is the spec itself (JSON or YAML).
 *
 * Supported keys (case-insensitive):
 *   servers:   list of URL strings — overrides the spec's own `servers` list
 *              (inline `servers: https://a, https://b` or block `- https://a`)
 *   server:    alias for `servers` (singular), same forms
 *   host:      string — combined into a synthetic `http(s)://<host>` server
 *   basePath:  string — appended to each resolved server URL (also appended
 *              to spec servers; Swagger 2.0 specs express paths this way)
 *   notes:     free-form text shown in an amber panel, like CodeBlock notes
 *
 * The header is NOT part of the spec: it is stripped before spec parsing.
 */

export interface SwaggerFrontmatter {
  /** Server URLs from frontmatter — override the spec's servers entirely. */
  servers?: string[];
  /** Swagger 2.0 style path prefix, appended to every server URL. */
  basePath?: string;
  /** Swagger 2.0 style host — converted into a server URL. */
  host?: string;
  /** Free-form notes rendered in a collapsible amber panel. */
  notes?: string;
}

export interface ParsedSwaggerBlock {
  meta: SwaggerFrontmatter;
  /** The spec text with frontmatter stripped. */
  specText: string;
}

interface KeyState {
  meta: SwaggerFrontmatter;
  /** 'servers' | 'notes' | null — key currently collecting block items. */
  currentKey: string | null;
  notesLines: string[];
}

/**
 * Normalize a server URL candidate: trim whitespace, strip trailing slashes,
 * drop empty/invalid entries. Returns null for values that are not usable.
 */
export function normalizeServerUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null;
  return trimmed;
}

/**
 * Apply a Swagger 2.0 basePath prefix to a server URL. The basePath never
 * replaces a path that is already present in the URL, and it is never
 * appended twice.
 */
export function applyBasePath(serverUrl: string, basePath: string | undefined): string {
  if (!basePath) return serverUrl;
  const path = basePath.startsWith('/') ? basePath : `/${basePath}`;
  const clean = path.replace(/\/+$/, '');
  if (!clean || clean === '/') return serverUrl;
  // Already starts with the base path → don't append again.
  try {
    const url = new URL(serverUrl);
    if (url.pathname === clean || url.pathname.startsWith(`${clean}/`)) {
      return serverUrl;
    }
  } catch {
    if (serverUrl.includes(clean)) return serverUrl;
  }
  return `${serverUrl}${clean}`;
}

/**
 * Combine frontmatter host + basePath into a server URL. Returns null when
 * there is no usable host.
 */
export function hostToServerUrl(meta: SwaggerFrontmatter): string | null {
  if (!meta.host) return null;
  const host = meta.host.trim().replace(/\/+$/, '');
  if (!host) return null;
  const scheme = /^https?:\/\//.test(host) ? '' : 'http://';
  return applyBasePath(`${scheme}${host}`, meta.basePath);
}

function setKey(state: KeyState, key: string, inlineVal: string) {
  if (key === 'servers' || key === 'server') {
    state.currentKey = 'servers';
    if (!state.meta.servers) state.meta.servers = [];
    // Inline comma-separated list — otherwise block items follow.
    if (inlineVal) {
      for (const part of inlineVal.split(',')) {
        const url = normalizeServerUrl(part);
        if (url) state.meta.servers.push(url);
      }
      state.currentKey = null;
    }
  } else if (key === 'host') {
    state.meta.host = inlineVal;
    state.currentKey = null;
  } else if (key === 'basepath' || key === 'base_path' || key === 'base-url' || key === 'baseurl') {
    // Strip quotes so `basePath: "/api/v1"` parses cleanly.
    state.meta.basePath = inlineVal.replace(/^['"]|['"]$/g, '');
    state.currentKey = null;
  } else if (key === 'notes') {
    state.currentKey = 'notes';
    if (inlineVal) state.notesLines.push(inlineVal);
  } else {
    state.currentKey = null;
  }
}

/**
 * Parse a swagger code block's content: optional YAML-like frontmatter header
 * followed by the spec text.
 *
 * Two header styles are accepted, matching how people actually write these:
 *   1. Delimited — an optional opening `---` line, header keys, then a closing
 *      `---` line. The spec starts after the closing marker.
 *   2. Bare — header keys on the first lines, terminated by the FIRST `---`
 *      line (the repo's CodeBlock convention; no closing marker needed).
 *
 * An opening `---` with no closing one is just a stray marker: header is
 * empty and the whole rest is spec.
 */
export function parseSwaggerFrontmatter(raw: string): ParsedSwaggerBlock {
  const lines = raw.split('\n');

  // Case 1: starts with an opening `---` → find the CLOSING marker.
  if (lines[0]?.trim() === '---') {
    const closeIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (closeIdx < 0) {
      // Opening marker only — treat everything after it as the spec.
      return { meta: {}, specText: lines.slice(1).join('\n') };
    }
    const { meta } = parseSwaggerFrontmatter(
      [
        ...lines.slice(1, closeIdx),
        '---',
        ...lines.slice(closeIdx + 1),
      ].join('\n')
    );
    return { meta, specText: lines.slice(closeIdx + 1).join('\n') };
  }

  // Case 2: bare header terminated by the first `---` line.
  const delimIdx = lines.findIndex((l) => l.trim() === '---');

  if (delimIdx < 0) {
    return { meta: {}, specText: raw };
  }

  const headerLines = lines.slice(0, delimIdx);
  const specText = lines.slice(delimIdx + 1).join('\n');

  const state: KeyState = { meta: {}, currentKey: null, notesLines: [] };

  for (const line of headerLines) {
    const keyMatch = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (keyMatch) {
      setKey(state, keyMatch[1].toLowerCase(), keyMatch[2].trim());
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && state.currentKey === 'servers') {
      const url = normalizeServerUrl(listMatch[1]);
      if (url) {
        if (!state.meta.servers) state.meta.servers = [];
        state.meta.servers.push(url);
      }
      continue;
    }

    if (state.currentKey === 'notes') {
      state.notesLines.push(line.trimStart());
      continue;
    }
  }

  if (state.notesLines.length > 0) {
    state.meta.notes = state.notesLines.join('\n').trim();
  }

  return { meta: state.meta, specText };
}