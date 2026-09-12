/**
 * OpenAPI/Swagger spec parsing for the SwaggerBlock renderer.
 *
 * Accepts JSON (starts with "{") or YAML (a common OpenAPI authoring format).
 * There is no YAML dependency in this app and the npm registry blocks new
 * installs, so YAML is parsed with a small, deliberately simple parser — the
 * same trade-off the repo makes for Mermaid and 3D-model frontmatter.
 *
 * Supported YAML subset (plenty for real-world specs):
 *   - nested mappings via indentation
 *   - block lists (`- item`) and inline flow lists (`[a, b]`)
 *   - flow mappings ({a: 1, b: 2})
 *   - quoted strings, numbers, booleans, null
 *   - | and > block scalars for descriptions (folded, keep it simple)
 */

export interface SwaggerSpec {
  openapi?: string;
  swagger?: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<
    string,
    Record<string, SwaggerOperation & { parameters?: SwaggerParameter[] }>
  >;
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    schemas?: Record<string, unknown>;
  };
  definitions?: Record<string, unknown>; // Swagger 2.0
}

export interface SwaggerOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: SwaggerParameter[];
  requestBody?: {
    description?: string;
    content?: Record<string, unknown>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
}

export interface SwaggerParameter {
  name: string;
  in?: string;
  description?: string;
  required?: boolean;
  schema?: unknown;
  type?: string; // Swagger 2.0
}

export class SpecParseError extends Error {}

// ─── JSON / YAML detection + entry point ────────────────────────────

export function looksLikeJson(text: string): boolean {
  return /^\s*\{/.test(text);
}

export function parseSpec(text: string): SwaggerSpec {
  const trimmed = text.trim();
  if (!trimmed) throw new SpecParseError('Empty spec');

  if (looksLikeJson(trimmed)) {
    try {
      return parseSpecObject(JSON.parse(trimmed));
    } catch (err) {
      throw new SpecParseError(
        `Invalid JSON spec: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const parsed = parseSimpleYaml(trimmed);
  return parseSpecObject(parsed);
}

/** Validate/normalize a parsed object into a SwaggerSpec. */
export function parseSpecObject(obj: unknown): SwaggerSpec {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SpecParseError('Spec must be an object');
  }
  const spec = obj as SwaggerSpec;
  if (!spec.info || typeof spec.info !== 'object') {
    throw new SpecParseError('Missing required "info" object');
  }
  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new SpecParseError('Missing required "paths" object');
  }
  return spec;
}

// ─── Minimal YAML parser ────────────────────────────────────────────

interface YamlLine {
  indent: number;
  content: string;
  /** True for `- item` lines; content has the item text. */
  isListItem: boolean;
}

function stripComment(line: string): string {
  // Remove trailing comments, but not inside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function splitYamlLines(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const rawLine of text.split('\n')) {
    const noComment = stripComment(rawLine);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    const content = noComment.trim();
    const isListItem = /^-(\s|$)/.test(content);
    out.push({
      indent,
      content: isListItem ? content.replace(/^-\s*/, '') : content,
      isListItem,
    });
  }
  return out;
}

function parseFlowValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map((part) => parseFlowValue(part));
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const part of splitTopLevel(inner, ',')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = parseFlowValue(part.slice(0, idx).trim());
      obj[String(key)] = parseFlowValue(part.slice(idx + 1).trim());
    }
    return obj;
  }
  return parseScalar(trimmed);
}

/** Split on a delimiter, ignoring delimiters inside quotes or brackets. */
function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depthSquare = 0;
  let depthCurly = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '[') depthSquare++;
      else if (ch === ']') depthSquare = Math.max(0, depthSquare - 1);
      else if (ch === '{') depthCurly++;
      else if (ch === '}') depthCurly = Math.max(0, depthCurly - 1);
    }
    if (ch === delimiter && !inSingle && !inDouble && depthSquare === 0 && depthCurly === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() || parts.length > 0) parts.push(current);
  return parts;
}

export function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') {
    return null;
  }
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d*\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse a YAML document into plain JS objects. Handles the subset described
 * in the module docblock. Throws SpecParseError on obviously malformed input.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = splitYamlLines(text);
  // parseYamlBlock returns [value, nextIndex] — take the value.
  const [value] = parseYamlBlock(lines, 0, 0);
  if (
    value instanceof Map ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new SpecParseError('YAML spec must start with a mapping');
  }
  return value as Record<string, unknown>;
}

/**
 * Parse consecutive lines starting at `index` that all have indent >=
 * `minIndent` into a value. Returns [value, nextIndex]. Lines with indent <
 * minIndent end the block.
 */
function parseYamlBlock(
  lines: YamlLine[],
  index: number,
  minIndent: number
): [unknown, number] {
  if (index >= lines.length) return [null, index];

  const first = lines[index];
  const indent = first.indent;

  if (indent < minIndent) return [null, index];

  // A block of list items
  if (first.isListItem) {
    const list: unknown[] = [];
    let i = index;
    while (i < lines.length && lines[i].indent === indent && lines[i].isListItem) {
      const item = lines[i];
      // `- key: value` (mapping inside a list item) → collect following lines
      // at deeper indent as the rest of that mapping.
      const inlineMatch = item.content.match(/^([^:{}[\]]+):\s*(.*)$/);
      if (inlineMatch && !inlineMatch[2].startsWith('|') && !inlineMatch[2].startsWith('>')) {
        const obj: Record<string, unknown> = {};
        obj[inlineMatch[1].trim()] = parseFlowValue(inlineMatch[2]);
        i++;
        const [nested, next] = parseYamlBlock(lines, i, indent + 1);
        i = next;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          Object.assign(obj, nested);
        }
        list.push(obj);
      } else {
        // Scalar item, flow value, or a nested block (| / >)
        const text = item.content;
        if (text.startsWith('|') || text.startsWith('>')) {
          const [scalar, next] = parseBlockScalar(lines, i, indent, text);
          list.push(scalar);
          i = next;
        } else if (/^[{[]/.test(text)) {
          list.push(parseFlowValue(text));
          i++;
        } else {
          list.push(parseScalar(text));
          i++;
        }
      }
    }
    return [list, i];
  }

  // A block of mapping entries
  const map: Record<string, unknown> = {};
  let i = index;
  while (i < lines.length && lines[i].indent === indent && !lines[i].isListItem) {
    const line = lines[i];
    const kv = splitKey(line.content);
    if (!kv) throw new SpecParseError(`Cannot parse YAML line: ${line.content}`);
    const [, key, rest] = kv;

    if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
      const [scalar, next] = parseBlockScalar(lines, i, indent, rest);
      map[key] = scalar;
      i = next;
      continue;
    }

    if (rest === '') {
      // Value is a nested block (mapping or list) at deeper indent, or null.
      const [nested, next] = parseYamlBlock(lines, i + 1, indent + 1);
      map[key] = nested;
      i = next;
      continue;
    }

    map[key] = parseFlowValue(rest);
    i++;
  }
  return [map, i];
}

/** Split `key: value` returning [full, key, rest]. Null if not a mapping entry. */
function splitKey(content: string): [string, string, string] | null {
  // Keys are simple (word chars, dashes, dots). Ignore flow contexts.
  const match = content.match(/^("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:\s*([\s\S]*)$/);
  if (!match) return null;
  const key = match[1].replace(/^["']|["']$/g, '').trim();
  if (!key) return null;
  return [match[0], key, match[2].trim()];
}

/**
 * Parse a `|` or `>` block scalar: all following lines with indent greater
 * than the key's indent. `marker` is the scalar indicator from the key's
 * value position ('|' or '>' possibly with chomping suffix). Returns
 * [text, nextIndex].
 */
function parseBlockScalar(
  lines: YamlLine[],
  keyIndex: number,
  keyIndent: number,
  marker: string
): [string, number] {
  const folded = marker.startsWith('>');
  const parts: string[] = [];
  let i = keyIndex + 1;
  while (i < lines.length && lines[i].indent > keyIndent) {
    parts.push(lines[i].content);
    i++;
  }
  const text = folded ? parts.join(' ') : parts.join('\n');
  return [text, i];
}