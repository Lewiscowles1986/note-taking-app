import { useState, useEffect, useMemo } from 'react';
import { Check, Copy, Play, Loader2, Info } from 'lucide-react';
import { toast } from 'sonner';
import { getRunner, hasRunner, getRunnerVersions, getDefaultVersion } from '@/lib/codeRunners';
import { parseCodeFrontmatter } from '@/lib/codeBlockFrontmatter';
import { registerJSRunner } from '@/lib/jsRunner';
import { registerPhpRunner } from '@/lib/phpRunner';
import { getAvailablePhpVersions, REQUIRED_PHP_VERSIONS } from '@/lib/phpRunner';
import { looksLikeHtml } from '@/lib/htmlOutput';

// Register the language runners when this code viewer chunk is loaded, so the
// runner modules (and their wasm/execution payloads) are only pulled in when a
// code block is actually rendered — not at app boot.
registerJSRunner();
registerPhpRunner();

// Dedupe the "required PHP version missing" alert across code blocks on a page.
const alertedMissing: string[] = [];

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
  const [availableVersions, setAvailableVersions] = useState<string[] | null>(null);

  const [version, setVersion] = useState<string | undefined>(() =>
    meta.version ?? getDefaultVersion(language),
  );

  // For PHP, 404-check each build and only offer the ones that are actually
  // present. Alert once if any of the required versions (5.6, 7.4, 8.4) are
  // missing; optional versions that 404 are just skipped.
  useEffect(() => {
    let cancelled = false;
    if (language === 'php') {
      getAvailablePhpVersions().then((avail) => {
        if (cancelled) return;
        setAvailableVersions(avail);
        const missing = REQUIRED_PHP_VERSIONS.filter((v) => !avail.includes(v));
        if (missing.length > 0 && !alertedMissing.includes(missing.join(','))) {
          alertedMissing.push(missing.join(','));
          toast.warning(`PHP ${missing.join(', ')} not available`);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [language]);

  // If the selected version isn't available (e.g. the default 8.4.25 404s),
  // fall back to the first available one.
  useEffect(() => {
    if (availableVersions && version && !availableVersions.includes(version)) {
      setVersion(availableVersions[0]);
    }
  }, [availableVersions, version]);

  const versions = useMemo(() => {
    const all = getRunnerVersions(language);
    if (language === 'php' && availableVersions) {
      return all?.filter((v) => availableVersions.includes(v));
    }
    return all;
  }, [language, availableVersions]);

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
      const result = await runner(code, { version });
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
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              <Info size={12} />
              Notes
            </button>
          )}
          {versions && versions.length > 0 && (
            <select
              value={version ?? ''}
              onChange={(e) => setVersion(e.target.value)}
              className="text-xs font-mono bg-[#1a1f24] text-white/70 border border-white/10 rounded px-1.5 py-0.5 outline-none focus:border-emerald-500/50"
              aria-label={`${language} version`}
            >
              {versions.map((v) => (
                <option key={v} value={v}>
                  PHP {v}
                </option>
              ))}
            </select>
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
        // Solid brand band — same background token as the sidebar "New note"
        // button (bg-primary), with dark ink text (#24292e, the block's
        // header/code background) for ~6:1 contrast. Symmetric 1px #ccc
        // hairlines on top and bottom frame the band without visual weight.
        <div className="px-4 py-2 text-xs bg-primary text-[#24292e] border-y border-[#ccc] whitespace-pre-wrap">
          {meta.notes}
        </div>
      )}
      {loading ? (
        // Inline background so `.prose-notes pre` (bg-muted) cannot override it
        // and leave light text on a light background during the shiki load.
        <pre
          style={{ backgroundColor: '#24292e' }}
          className="p-4 text-sm text-white/70 font-mono overflow-x-auto"
        >
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="shiki-wrapper text-sm [&_pre]:!p-4 [&_pre]:!m-0 [&_pre]:overflow-x-auto [&_code]:!text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {output && output.type === 'success' && looksLikeHtml(output.text) ? (
        // HTML output (e.g. PHP echo "<h1>…</h1>") renders in a sandboxed
        // iframe via srcdoc. allow-scripts lets embedded JS run, but the frame
        // is a unique origin so it can't touch the parent page.
        <iframe
          title="HTML output"
          sandbox="allow-scripts"
          srcDoc={output.text}
          className="w-full border-t border-white/10 bg-white"
          style={{ minHeight: '50svh' }}
        />
      ) : (
        output && (
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
        )
      )}
    </div>
  );
}
