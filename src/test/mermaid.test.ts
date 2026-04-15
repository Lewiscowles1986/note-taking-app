import { describe, it, expect } from 'vitest';

// Replicate the parser to test in isolation
function parseFrontmatter(code: string): { config: Record<string, unknown>; diagram: string } {
  const fmRegex = /^([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = code.match(fmRegex);
  if (!match) return { config: {}, diagram: code };

  const yamlBlock = match[1];
  const diagram = match[2];
  const config: Record<string, unknown> = {};

  try {
    const lines = yamlBlock.split('\n');
    const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: config, indent: -1 }];

    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.search(/\S/);
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1].obj;
      if (rawValue === '' || rawValue === '|') {
        const child: Record<string, unknown> = {};
        parent[key] = child;
        stack.push({ obj: child, indent });
      } else {
        parent[key] = parseScalar(rawValue);
      }
    }
  } catch {
    return { config: {}, diagram: code };
  }
  return { config, diagram };
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

describe('mermaid frontmatter parsing', () => {
  it('returns diagram as-is when no frontmatter (no --- separator)', () => {
    const code = 'graph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config).toEqual({});
    expect(result.diagram).toBe(code);
  });

  it('extracts config before --- separator', () => {
    const code = 'theme: dark\n---\ngraph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config).toEqual({ theme: 'dark' });
    expect(result.diagram).toBe('graph TD\n  A --> B');
  });

  it('extracts nested config', () => {
    const code = 'theme: dark\nflowchart:\n  curve: basis\n---\ngraph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config).toEqual({
      theme: 'dark',
      flowchart: { curve: 'basis' },
    });
    expect(result.diagram).toBe('graph TD\n  A --> B');
  });

  it('parses boolean and number scalars', () => {
    const code = 'htmlLabels: true\nfontSize: 14\n---\ngraph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config.htmlLabels).toBe(true);
    expect(result.config.fontSize).toBe(14);
  });

  it('handles quoted strings', () => {
    const code = 'title: "Hello World"\n---\ngraph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config.title).toBe('Hello World');
  });

  it('ignores comment lines', () => {
    const code = '# comment\ntheme: dark\n---\ngraph TD\n  A --> B';
    const result = parseFrontmatter(code);
    expect(result.config).toEqual({ theme: 'dark' });
  });

  it('preserves full diagram after ---', () => {
    const diagram = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi';
    const code = `theme: forest\n---\n${diagram}`;
    const result = parseFrontmatter(code);
    expect(result.diagram).toBe(diagram);
  });
});
