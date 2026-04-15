import { useState, useEffect, useMemo } from 'react';
import { Check, Copy, Play, Loader2, Info } from 'lucide-react';
import { getRunner, hasRunner } from '@/lib/codeRunners';
import { parseCodeFrontmatter } from '@/lib/codeBlockFrontmatter';

interface CodeBlockProps {
  code: string;
  language: string;
}

export default function CodeBlock({ code: rawCode, language }: CodeBlockProps) {
  const { meta, code } = useMemo(() => parseCodeFrontmatter(rawCode), [rawCode]);

  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showNotes, setShowNotes] = useState(false);

  const hasMeta = !!(meta.compatible?.length || meta.incompatible?.length || meta.notes);
  const canRun = hasRunner(language);

  useEffect(() => {
    let cancelled = false;

    import('shiki').then(async ({ codeToHtml }) => {
      try {
        const result = await codeToHtml(code, {
          lang: language,
          theme: 'github-dark',
        });
        if (!cancelled) {
          setHtml(result);
          setLoading(false);
        }
      } catch {
        const result = await codeToHtml(code, {
          lang: 'text',
          theme: 'github-dark',
        });
        if (!cancelled) {
          setHtml(result);
          setLoading(false);
        }
      }
    });

    return () => { cancelled = true; };
  }, [code, language]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRun = async () => {
    const runner = getRunner(language);
    if (!runner) return;

    setRunning(true);
    setOutput(null);

    try {
      const result = await runner(code);
      setOutput({ type: 'success', text: result || '(no output)' });
    } catch (err) {
      setOutput({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="relative my-3 overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/50">{language}</span>
          {meta.compatible?.map((v) => (
            <span key={`c-${v}`} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-emerald-900/60 text-emerald-300">
              ✓ {v}
            </span>
          ))}
          {meta.incompatible?.map((v) => (
            <span key={`i-${v}`} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-red-900/60 text-red-300">
              ✗ {v}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {meta.notes && (
            <button
              onClick={() => setShowNotes(!showNotes)}
              className="flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-400 transition-colors"
            >
              <Info size={12} />
              Notes
            </button>
          )}
          {canRun && (
            <button
              onClick={handleRun}
              disabled={running}
              className="flex items-center gap-1 text-xs text-emerald-400/70 hover:text-emerald-400 transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {running ? 'Running…' : 'Run'}
            </button>
          )}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-white/40 hover:text-white/80 transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {showNotes && meta.notes && (
        <div className="px-4 py-2 text-xs bg-amber-950/40 text-amber-200/80 border-b border-white/10 whitespace-pre-wrap">
          {meta.notes}
        </div>
      )}
      {loading ? (
        <pre className="bg-[#24292e] p-4 text-sm text-white/70 font-mono overflow-x-auto">
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="shiki-wrapper text-sm [&_pre]:!p-4 [&_pre]:!m-0 [&_pre]:overflow-x-auto [&_code]:!text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {output && (
        <div
          className={`px-4 py-3 text-xs font-mono whitespace-pre-wrap border-t border-white/10 ${
            output.type === 'error'
              ? 'bg-red-950/50 text-red-300'
              : 'bg-[#1a1f24] text-green-300'
          }`}
        >
          <span className="text-white/30 select-none">{output.type === 'error' ? '✗ ' : '▸ '}</span>
          {output.text}
        </div>
      )}
    </div>
  );
}
