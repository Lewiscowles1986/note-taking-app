import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Workflow, Code2, Copy, Check } from 'lucide-react';

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
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [highlighted, setHighlighted] = useState('');
  const [copied, setCopied] = useState(false);

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

  // Highlight the mermaid source for the code view. Falls back to plain text
  // if the mermaid grammar is unavailable in the bundled shiki languages.
  useEffect(() => {
    let cancelled = false;
    import('shiki').then(async ({ codeToHtml }) => {
      try {
        const html = await codeToHtml(code, { lang: 'mermaid', theme: 'github-dark' });
        if (!cancelled) setHighlighted(html);
      } catch {
        const html = await codeToHtml(code, { lang: 'text', theme: 'github-dark' });
        if (!cancelled) setHighlighted(html);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-3 rounded-sm text-sm font-mono">
        Mermaid error: {error}
      </div>
    );
  }

  return (
    <div className="mermaid-diagram my-3 overflow-hidden rounded-md border border-border">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/50">mermaid</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'preview'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/60 hover:text-white/95'
            }`}
          >
            <Workflow size={12} />
            Diagram Preview
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'code'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/60 hover:text-white/95'
            }`}
          >
            <Code2 size={12} />
            Code
          </button>
          {activeTab === 'code' && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-white/40 hover:text-white/80 transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      </div>

      {activeTab === 'code' ? (
        highlighted ? (
          <div
            className="shiki-wrapper text-sm [&_pre]:!my-0 [&_pre]:!rounded-none [&_pre]:!border-0 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:!p-4 [&_code]:!text-sm"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          // Loading fallback with inline background so `.prose-notes pre`
          // (bg-muted) cannot leave light text on a light background.
          <pre
            style={{ backgroundColor: '#24292e' }}
            className="p-4 text-sm text-white/70 font-mono overflow-x-auto max-h-96"
          >
            <code>{code}</code>
          </pre>
        )
      ) : (
        <div
          ref={ref}
          className="flex justify-center p-3"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
