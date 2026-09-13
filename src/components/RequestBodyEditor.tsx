import { useEffect, useRef, useState } from 'react';

/** Shiki grammar for a media type (falls back to txt). */
export function mediaTypeLang(mediaType: string): string {
  if (/json/i.test(mediaType)) return 'json';
  if (/xml/i.test(mediaType)) return 'xml';
  if (/yaml|yml/i.test(mediaType)) return 'yaml';
  return 'txt';
}

/**
 * Request-body editor surface: Shiki-highlighted markup sits under a
 * transparent textarea, so the user types over live syntax highlighting —
 * same trick as the Shiki playground.
 *
 * Layer alignment: Shiki's codeToHtml emits its own <pre>; rendering it into
 * a <div> (not another <pre>) avoids a `pre pre` cascade where .prose-notes
 * pre { p-4 my-3 } hits the INNER pre and shifts the highlight layer away
 * from the textarea (the misaligned-cursor + double-padding bug). Instead
 * the wrapper div owns padding/scroll and [&_pre]/[&_code] flatten Shiki's
 * own margins/backgrounds so only ONE padding (p-3) applies to both layers.
 */
export default function RequestBodyEditor({
  value,
  lang,
  onChange,
  testId,
}: {
  value: string;
  lang: string;
  onChange: (text: string) => void;
  testId: string;
}) {
  const [html, setHtml] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Plain text when empty keeps the min-height without a lone quote token.
    import('shiki').then(async ({ codeToHtml }) => {
      try {
        const result = await codeToHtml(value || ' ', { lang, theme: 'github-dark' });
        if (!cancelled) setHtml(result);
      } catch {
        const result = await codeToHtml(value || ' ', { lang: 'txt', theme: 'github-dark' });
        if (!cancelled) setHtml(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [value, lang]);

  // Keep the highlight layer's scroll synced with the textarea for long bodies.
  const syncScroll = () => {
    if (taRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = taRef.current.scrollTop;
      highlightRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  return (
    <div className="relative min-h-[76px]" data-testid={`body-editor-${testId.replace('body-input-', '')}`}>
      {/* Highlight layer — a div: never a <pre>, so prose `pre` rules can't
          reach the Shiki output and offset the layers. [&_pre]/[&_code] strip
          Shiki's own pre margins+padding so the wrapper's p-3 is the
          single source of padding for both layers. */}
      <div
        ref={highlightRef}
        aria-hidden="true"
        data-shiki-layer=""
        style={{
          backgroundColor: '#24292e',
          fontSize: '12px',
          lineHeight: '20px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
        className="!my-0 p-3 whitespace-pre-wrap break-words overflow-x-auto min-h-[76px] [&_pre]:!my-0 [&_pre]:!p-0 [&_pre]:!bg-transparent [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:!text-xs [&_code]:!bg-transparent [&_code]:!p-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        placeholder="// Request body — type here; syntax highlighting is live"
        data-testid={testId}
        style={{
          color: 'transparent',
          caretColor: '#e6edf3',
          backgroundColor: 'transparent',
          fontSize: '12px',
          lineHeight: '20px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
        className="absolute inset-0 w-full h-full resize-none !p-3 !my-0 outline-none whitespace-pre-wrap break-words placeholder:text-white/20 selection:bg-sky-500/30"
      />
    </div>
  );
}