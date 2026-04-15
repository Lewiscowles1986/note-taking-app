import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
});

let mermaidCounter = 0;

/**
 * Parses optional YAML-like frontmatter from a mermaid code block.
 * Mermaid supports:
 *   ---
 *   title: My Diagram
 *   config:
 *     theme: dark
 *     flowchart:
 *       curve: basis
 *   ---
 *   graph TD
 *     A --> B
 *
 * We extract the frontmatter, apply config overrides, and pass
 * the remaining diagram code to mermaid.render().
 */
function parseFrontmatter(code: string): { config: Record<string, unknown>; diagram: string } {
  // Mermaid frontmatter: config lines at the top, terminated by first ---
  // No opening --- needed (like markdown frontmatter where --- ends the block).
  const fmRegex = /^([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = code.match(fmRegex);

  if (!match) {
    return { config: {}, diagram: code };
  }

  const yamlBlock = match[1];
  const diagram = match[2];

  // Simple YAML-like parser for mermaid frontmatter
  // Handles: key: value, nested objects via indentation
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

      // Pop stack to find correct parent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].obj;

      if (rawValue === '' || rawValue === '|') {
        // Nested object
        const child: Record<string, unknown> = {};
        parent[key] = child;
        stack.push({ obj: child, indent });
      } else {
        // Scalar value — try to parse as JSON-like value
        parent[key] = parseScalar(rawValue);
      }
    }
  } catch {
    // If parsing fails, just pass the full code to mermaid
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
  // Strip surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export default function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const id = `mermaid-${++mermaidCounter}`;
    const { config, diagram } = parseFrontmatter(code);

    // Apply per-diagram config — frontmatter keys ARE the config (not nested under config:)
    if (Object.keys(config).length > 0) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        ...config,
      });
    }

    mermaid
      .render(id, diagram)
      .then((result) => {
        setSvg(result.svg);
        setError('');
      })
      .catch((err) => {
        setError(String(err));
        setSvg('');
      })
      .finally(() => {
        // Reset to defaults after rendering so other diagrams aren't affected
        if (Object.keys(config).length > 0) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'neutral',
            securityLevel: 'loose',
          });
        }
      });
  }, [code]);

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-3 rounded-sm text-sm font-mono">
        Mermaid error: {error}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="my-3 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
