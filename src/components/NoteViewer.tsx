import React, { lazy, Suspense, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Note, NoteAttachment } from '@/lib/db';
import type { Components } from 'react-markdown';
import { getCalloutDef, calloutTypePattern } from '@/lib/callouts';

const CodeBlock = lazy(() => import('./CodeBlock'));
const MermaidBlock = lazy(() => import('./MermaidBlock'));

interface NoteViewerProps {
  note: Note;
  onSave?: (changes: Partial<Note>) => void;
}

function toAttachmentKey(value: string) {
  return decodeURIComponent(value).trim().toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderCallout(type: string, bodyLines: string[], components?: Components) {
  const def = getCalloutDef(type);
  if (!def) return null;
  const body = bodyLines.join('\n');
  const Icon = def.icon;
  return (
    <div className={`callout callout-${def.colorKey}`}>
      <div className="callout-header mb-1 flex items-center gap-2 font-semibold">
        <Icon size={16} />
        {def.label}
      </div>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
        urlTransform={(url) => (url.startsWith('attachment:') ? url : defaultUrlTransform(url))}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function transformCellContent(children: React.ReactNode): React.ReactNode {
  if (!React.Children.count(children)) return children;

  return React.Children.map(children, (child) => {
    if (typeof child !== 'string') return child;

    const pattern = /\[([ xX])\]|\(([ xX*])\)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    while ((match = pattern.exec(child)) !== null) {
      if (match.index > lastIndex) parts.push(child.slice(lastIndex, match.index));

      if (match[1] !== undefined) {
        const checked = match[1].toLowerCase() === 'x';
        parts.push(
          <input
            key={key++}
            type="checkbox"
            checked={checked}
            readOnly
            className="pointer-events-none mr-1 align-middle"
          />
        );
      } else if (match[2] !== undefined) {
        const checked = match[2] !== ' ';
        parts.push(
          <input
            key={key++}
            type="radio"
            checked={checked}
            readOnly
            className="pointer-events-none mr-1 align-middle"
          />
        );
      }

      lastIndex = match.index + match[0].length;
    }

    if (parts.length === 0) return child;
    if (lastIndex < child.length) parts.push(child.slice(lastIndex));
    return <>{parts}</>;
  });
}

function preprocessMergedTables(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (/^\|.*\|$/.test(lines[i].trim())) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i++;
      }

      const hasMerge = tableLines.some((line) => /\|\|/.test(line));
      if (!hasMerge || tableLines.length < 2) {
        result.push(...tableLines);
        continue;
      }

      const separatorIdx = tableLines.findIndex((l) => /^\|[\s:|-]+\|$/.test(l));
      if (separatorIdx === -1) {
        result.push(...tableLines);
        continue;
      }

      result.push('<table>');

      for (let r = 0; r < tableLines.length; r++) {
        if (r === separatorIdx) continue;
        const isHeader = r < separatorIdx;
        const tag = isHeader ? 'th' : 'td';
        const raw = tableLines[r];
        const cells: { content: string; colspan: number }[] = [];
        const inner = raw.slice(1, -1);
        const parts = inner.split('|');

        let ci = 0;
        while (ci < parts.length) {
          const content = parts[ci].trim();
          let colspan = 1;
          while (ci + colspan < parts.length && parts[ci + colspan].trim() === '') colspan++;
          cells.push({ content, colspan });
          ci += colspan;
        }

        const rowHtml = cells
          .map((c) => {
            const cs = c.colspan > 1 ? ` colspan="${c.colspan}"` : '';
            return `<${tag}${cs}>${c.content}</${tag}>`;
          })
          .join('');
        result.push(`<tr>${rowHtml}</tr>`);
      }

      result.push('</table>');
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveAttachmentReference(href: string | undefined, attachmentMap: Map<string, NoteAttachment>) {
  if (!href || !href.startsWith('attachment:')) return undefined;
  return attachmentMap.get(toAttachmentKey(href.slice('attachment:'.length)));
}

function resolveAttachmentHref(href: string | undefined, attachmentMap: Map<string, NoteAttachment>) {
  const attachment = resolveAttachmentReference(href, attachmentMap);
  if (attachment) return attachment.data;
  if (!href || href.startsWith('attachment:')) return '';
  return href;
}

export default function NoteViewer({ note, onSave }: NoteViewerProps) {
  const attachmentMap = useMemo(() => {
    const map = new Map<string, NoteAttachment>();
    for (const att of note.attachments) {
      map.set(toAttachmentKey(att.id), att);
      map.set(toAttachmentKey(att.name), att);
    }
    return map;
  }, [note.attachments]);

  const referencedAttachmentIds = useMemo(() => {
    const content = note.content.toLowerCase();
    return new Set(
      note.attachments
        .filter((attachment) => {
          const refs = [attachment.id, attachment.name, encodeURIComponent(attachment.name)].map((ref) => `attachment:${ref.toLowerCase()}`);
          return refs.some((ref) => content.includes(ref));
        })
        .map((attachment) => attachment.id)
    );
  }, [note.attachments, note.content]);

  const processedContent = preprocessMergedTables(note.content);
  const lines = processedContent.split('\n');
  const segments: { type: 'markdown' | 'callout'; content: string; calloutType?: string; bodyLines?: string[] }[] = [];
  let i = 0;
  const typeRegex = new RegExp(`^>\\s*\\[!(${calloutTypePattern()})\\]\\s*$`);

  while (i < lines.length) {
    const calloutMatch = lines[i].match(typeRegex);
    if (calloutMatch) {
      const cType = calloutMatch[1];
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        bodyLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      segments.push({ type: 'callout', content: '', calloutType: cType, bodyLines });
    } else {
      if (segments.length > 0 && segments[segments.length - 1].type === 'markdown') {
        segments[segments.length - 1].content += '\n' + lines[i];
      } else {
        segments.push({ type: 'markdown', content: lines[i] });
      }
      i++;
    }
  }

  const needsSyntaxHighlighter = note.hasCodeBlocks !== false;
  const needsMermaid = note.hasMermaid !== false;

  const components: Components = useMemo(() => ({
    img({ src, alt, ...props }) {
      const attachment = resolveAttachmentReference(src, attachmentMap);
      const resolved = resolveAttachmentHref(src, attachmentMap);
      const finalSrc = attachment?.thumbnail || resolved;

      if (!finalSrc) {
        return <span className="text-muted-foreground italic">[missing image]</span>;
      }

      return (
        <img
          src={finalSrc}
          alt={alt || ''}
          loading="lazy"
          className="max-w-full rounded-md border border-border"
          {...props}
        />
      );
    },
    a({ href, children, ...props }) {
      const resolved = resolveAttachmentHref(href, attachmentMap);
      const attachment = resolveAttachmentReference(href, attachmentMap);

      if (!resolved) {
        return <span className="text-muted-foreground italic">[missing attachment]</span>;
      }

      return (
        <a
          href={resolved}
          download={attachment?.name}
          target={resolved.startsWith('data:') ? undefined : '_blank'}
          rel={resolved.startsWith('data:') ? undefined : 'noreferrer'}
          {...props}
        >
          {children}
        </a>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    td({ children, ...props }) {
      return <td {...props}>{transformCellContent(children)}</td>;
    },
    th({ children, ...props }) {
      return <th {...props}>{transformCellContent(children)}</th>;
    },
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      const lang = match ? match[1] : '';

      if (lang === 'mermaid' && needsMermaid) {
        return (
          <Suspense fallback={<div className="my-3 h-24 animate-pulse rounded-sm bg-muted p-4" />}>
            <MermaidBlock code={String(children).trim()} />
          </Suspense>
        );
      }

      if (lang === 'bpmn') {
        return (
          <div className="my-3">
            <div className="mb-1 px-1 text-xs font-mono text-muted-foreground">BPMN</div>
            <pre className="overflow-x-auto rounded-sm bg-muted p-4">
              <code className={className} {...props}>{children}</code>
            </pre>
          </div>
        );
      }

      if (!className) {
        return <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono" {...props}>{children}</code>;
      }

      if (lang && needsSyntaxHighlighter) {
        return (
          <Suspense fallback={<pre className="my-3 overflow-x-auto rounded-sm bg-muted p-4"><code className={className} {...props}>{children}</code></pre>}>
            <CodeBlock code={String(children).trim()} language={lang} />
          </Suspense>
        );
      }

      return (
        <pre className="my-3 overflow-x-auto rounded-sm bg-muted p-4">
          <code className={className} {...props}>{children}</code>
        </pre>
      );
    },
  }), [needsSyntaxHighlighter, needsMermaid, attachmentMap]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="border-b border-border px-4 py-2">
        <span className="font-mono text-xs text-muted-foreground">Viewing</span>
      </div>
      <div className="prose-notes max-w-none p-6">
        {note.content.trim() ? (
          segments.map((seg, idx) =>
            seg.type === 'callout' ? (
              <React.Fragment key={idx}>{renderCallout(seg.calloutType!, seg.bodyLines!, components)}</React.Fragment>
            ) : (
              <ReactMarkdown
                key={idx}
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={components}
                urlTransform={(url) => (url.startsWith('attachment:') ? url : defaultUrlTransform(url))}
              >
                {seg.content}
              </ReactMarkdown>
            )
          )
        ) : (
          <p className="italic text-muted-foreground">Empty note</p>
        )}

        {note.attachments.length > 0 && (
          <section className="mt-8 border-t border-border pt-6 not-prose">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Attachments</h2>
            <div className="space-y-3">
              {note.attachments.map((attachment) => {
                const isImage = attachment.type.startsWith('image/');
                const previewSrc = attachment.thumbnail || attachment.data;
                const isReferenced = referencedAttachmentIds.has(attachment.id);

                return (
                  <div key={attachment.id} className="rounded-md border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {attachment.name}
                          {!isReferenced && <span className="ml-2 text-xs text-muted-foreground">(not embedded)</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {attachment.type || 'file'} · {formatFileSize(attachment.size)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <a
                          href={attachment.data}
                          download={attachment.name}
                          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                        >
                          Download
                        </a>
                        <a
                          href={attachment.data}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                        >
                          Open
                        </a>
                        {onSave && (
                          <button
                            onClick={() => {
                              const updated = note.attachments.filter((a) => a.id !== attachment.id);
                              const refs = [attachment.id, attachment.name, encodeURIComponent(attachment.name)]
                                .map((ref) => escapeRegExp(ref))
                                .join('|');
                              const cleanedContent = note.content
                                .replace(new RegExp(`!?\\[[^\\]]*\\]\\(attachment:(?:${refs})\\)\\n?`, 'gi'), '')
                                .replace(/\n{3,}/g, '\n\n');
                              onSave({ attachments: updated, content: cleanedContent });
                            }}
                            className="rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                    {isImage && previewSrc && (
                      <a
                        href={attachment.data}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 block overflow-hidden rounded-md border border-border"
                      >
                        <img
                          src={previewSrc}
                          alt={attachment.name}
                          loading="lazy"
                          className="max-h-80 w-full object-contain bg-muted"
                        />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
