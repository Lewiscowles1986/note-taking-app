import { useEffect, useRef, useState } from 'react';
import BpmnViewer from 'bpmn-js/lib/Viewer';
import { Workflow, Code2, Copy, Check, Loader2 } from 'lucide-react';
import { layoutProcess } from 'bpmn-auto-layout';

interface BpmnBlockProps {
  code: string;
}

/** Pretty-print XML so the code view is readable instead of one long line. */
function formatXml(xml: string): string {
  const lines = xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const out: string[] = [];
  let indent = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^<\//.test(trimmed)) indent = Math.max(0, indent - 1);
    out.push('  '.repeat(indent) + trimmed);
    if (/^<[^/?!][^>]*[^/]>$/.test(trimmed) && !/^<\?/.test(trimmed)) indent++;
  }
  return out.join('\n');
}

export default function BpmnBlock({ code }: BpmnBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<BpmnViewer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [highlighted, setHighlighted] = useState('');
  const [copied, setCopied] = useState(false);
  const formatted = formatXml(code);

  useEffect(() => {
    let cancelled = false;
    // Highlight the XML directly — no nested CodeBlock, so there is only one
    // header. Falls back to plain text if the xml grammar is unavailable.
    import('shiki').then(async ({ codeToHtml }) => {
      try {
        const html = await codeToHtml(formatted, { lang: 'xml', theme: 'github-dark' });
        if (!cancelled) setHighlighted(html);
      } catch {
        const html = await codeToHtml(formatted, { lang: 'text', theme: 'github-dark' });
        if (!cancelled) setHighlighted(html);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [formatted]);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Read-only viewer: renders the diagram cleanly without the editing
    // palette, toolbar, or "Powered by bpmn.io" watermark.
    const viewer = new BpmnViewer({ container });
    viewerRef.current = viewer;

    // Hand-written BPMN often omits the Diagram Interchange (DI) section that
    // bpmn-js needs to position shapes. Auto-layout generates DI when missing,
    // so the diagram renders instead of showing "no diagram to display".
    const prepare = code.includes('<bpmndi:')
      ? Promise.resolve(code)
      : layoutProcess(code);

    prepare
      .then((xml) => viewer.importXML(xml))
      .then(() => {
        if (cancelled) return;
        setError('');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [code, activeTab]);

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/50">bpmn</span>
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
              onClick={() => {
                navigator.clipboard.writeText(formatted);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-white/40 hover:text-white/80 transition-colors"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="bg-destructive/10 text-destructive p-3 text-sm font-mono">
          BPMN error: {error}
        </div>
      ) : activeTab === 'code' ? (
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
            <code>{formatted}</code>
          </pre>
        )
      ) : (
        <div className="relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Loading diagram…
            </div>
          )}
          <div ref={containerRef} className="h-[420px] w-full" />
        </div>
      )}
    </div>
  );
}
