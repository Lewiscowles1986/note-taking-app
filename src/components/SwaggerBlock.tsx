import { useEffect, useMemo, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import {
  Check,
  Copy,
  Code2,
  Globe,
  Info,
  Loader2,
  Network,
  PenLine,
  RotateCcw,
  Save,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { mediaTypeLang } from './RequestBodyEditor';
import { bodyFormFor, toWireBody, type BodyFormComponent } from './bodyForms/registry';
import {
  SpecParseError,
  defaultRequestBody,
  mediaTypeLabel,
  parseSpec,
  requestBodyExamples,
  type SwaggerOperation,
  type SwaggerParameter,
  type SwaggerSpec,
} from '@/lib/swaggerSpec';
import {
  applyBasePath,
  hostToServerUrl,
  parseSwaggerFrontmatter,
} from '@/lib/swaggerFrontmatter';

interface SwaggerBlockProps {
  code: string;
}

type Method = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options';

const METHOD_ORDER: Method[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const METHOD_CLASSES: Record<Method, string> = {
  get: 'bg-sky-900/70 text-sky-300 border-sky-700',
  post: 'bg-emerald-900/70 text-emerald-300 border-emerald-700',
  put: 'bg-amber-900/70 text-amber-300 border-amber-700',
  delete: 'bg-red-900/70 text-red-300 border-red-700',
  patch: 'bg-purple-900/70 text-purple-300 border-purple-700',
  head: 'bg-slate-900/70 text-slate-300 border-slate-700',
  options: 'bg-slate-900/70 text-slate-300 border-slate-700',
};

interface OperationRow {
  method: Method;
  path: string;
  operation: SwaggerOperation & { parameters?: SwaggerParameter[] };
  tag: string;
}

/** Methods present on a path item, in canonical display order. */
function methodsOf(item: Record<string, unknown>): Method[] {
  return METHOD_ORDER.filter((m) => item[m] && typeof item[m] === 'object');
}

/** Group path items into (tagName → operations) preserving spec order. */
function groupOperations(spec: SwaggerSpec): Map<string, OperationRow[]> {
  const groups = new Map<string, OperationRow[]>();
  const push = (tag: string, row: OperationRow) => {
    const existing = groups.get(tag);
    if (existing) existing.push(row);
    else groups.set(tag, [row]);
  };

  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    // Path-level parameters apply to every operation on the path.
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of methodsOf(item as Record<string, unknown>)) {
      const op = (item as Record<string, unknown>)[method] as SwaggerOperation;
      const tags = Array.isArray(op.tags) && op.tags.length > 0 ? op.tags : ['default'];
      for (const tag of tags) {
        push(tag, {
          method,
          path,
          operation: { ...op, parameters: [...pathParams, ...(op.parameters || [])] },
          tag,
        });
      }
    }
  }
  return groups;
}

/**
 * Resolve the effective server list. Frontmatter servers override the spec's
 * own list entirely (the point of the frontmatter is to repoint a spec at a
 * local/mock environment); host+basePath from Swagger 2.0 frontmatter is
 * folded into a synthetic URL. The spec's servers are kept as fallback
 * choices only when frontmatter provided none.
 */
function resolveServers(
  specServers: Array<{ url: string; description?: string }>,
  fmServers: string[] | undefined,
  basePath: string | undefined
): Array<{ url: string; description?: string }> {
  if (fmServers && fmServers.length > 0) {
    return fmServers.map((url) => ({ url: applyBasePath(url, basePath) }));
  }
  if (specServers.length > 0) {
    return specServers.map((s) => ({ ...s, url: applyBasePath(s.url, basePath) }));
  }
  return [{ url: '' }];
}

export default function SwaggerBlock({ code: rawCode }: SwaggerBlockProps) {
  const { meta, specText } = useMemo(() => parseSwaggerFrontmatter(rawCode), [rawCode]);

  const parsed = useMemo(() => {
    try {
      const spec = parseSpec(specText);
      return { spec, error: null as string | null };
    } catch (err) {
      const message =
        err instanceof SpecParseError
          ? err.message
          : `Cannot parse spec: ${err instanceof Error ? err.message : String(err)}`;
      return { spec: null as SwaggerSpec | null, error: message };
    }
  }, [specText]);

  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showNotes, setShowNotes] = useState(false);
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [serverIdx, setServerIdx] = useState(0);
  const [execState, setExecState] = useState<
    { key: string; status: 'loading' | 'done' | 'error'; text: string } | null
  >(null);
  /** Per-operation request bodies: opKey → { mediaType, texts per media type }. */
  const [bodyDrafts, setBodyDrafts] = useState<
    Record<string, { mediaType: string; texts: Record<string, string> }>
  >({});
  /** User-saved example bodies: `${opKey}::${mediaType}` → list. */
  const [savedExamples, setSavedExamples] = useState<
    Record<string, { name: string; value: string }[]>
  >({});
  /** Editable parameter values: `${opKey}::${param.in}::${param.name}` → string. */
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const spec = parsed.spec;
  const groups = useMemo(() => (spec ? groupOperations(spec) : new Map<string, OperationRow[]>()), [spec]);

  const servers = useMemo(
    () =>
      resolveServers(
        spec?.servers || [],
        meta.servers,
        meta.basePath
      ),
    [spec, meta.servers, meta.basePath]
  );
  const hostServer = useMemo(() => hostToServerUrl(meta), [meta]);

  const hasSwagger2 = !!(spec?.swagger && !spec.openapi);

  // Track connectivity so Try-it-out can react to going offline
  // (navigator.onLine + online/offline events, like the reference pattern).
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(specText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /** Execute the request against the selected server (Try it out). */
  const handleTryIt = async (
    key: string,
    method: Method,
    path: string,
    params: SwaggerParameter[],
    body?: { mediaType: string; text: string }
  ) => {
    const base = servers[serverIdx]?.url || hostServer || '';
    if (!base) {
      setExecState({ key, status: 'error', text: 'No server configured' });
      return;
    }
    if (!navigator.onLine) {
      setExecState({
        key,
        status: 'error',
        text: 'Offline — reconnect to send requests',
      });
      return;
    }

    setExecState({ key, status: 'loading', text: '' });

    // Substitute path parameters ({id} → value). Unfilled required path
    // params keep their {placeholder} so the failure is visible in the URL.
    let resolvedPath = path;
    const missingRequired: string[] = [];
    for (const param of params) {
      const raw = paramValues[`${key}::${param.in}::${param.name}`];
      const value = raw !== undefined && raw !== '' ? raw : defaultValueFor(param);
      if (param.in === 'path') {
        resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(value));
      }
      if (param.required && !value) missingRequired.push(param.name);
    }
    if (missingRequired.length > 0) {
      setExecState({
        key,
        status: 'error',
        text: `Missing required parameter(s): ${missingRequired.join(', ')}`,
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(base + resolvedPath);
    } catch {
      setExecState({ key, status: 'error', text: `Invalid URL: ${base}${resolvedPath}` });
      return;
    }

    for (const param of params) {
      if (param.in !== 'query') continue;
      const typed = paramValues[`${key}::${param.in}::${param.name}`];
      // Explicit user input wins; otherwise fall back to the schema example.
      const raw = typed !== undefined && typed !== '' ? typed : defaultValueFor(param);
      if (raw !== undefined && raw !== '') {
        url.searchParams.set(param.name, raw);
      }
    }

    // Non-empty trimmed body is sent with its content type; blank bodies are
    // treated as "no request body". File-form bodies arrive as data URLs and
    // are decoded to raw bytes here so the wire format matches a real upload.
    const trimmedBody = body?.text.trim() ?? '';
    const hasBody = trimmedBody.length > 0;
    const wireBody = hasBody ? await toWireBody(trimmedBody, body!.mediaType) : undefined;
    if (hasBody && wireBody === undefined) {
      setExecState({ key, status: 'error', text: 'Could not decode request body' });
      return;
    }

    const headers: Record<string, string> = {};
    if (hasBody && body) {
      // multipart/form-data is the exception: the browser must generate the
      // Content-Type with its own boundary, so never set it manually.
      if (!/multipart\//i.test(body.mediaType)) {
        headers['Content-Type'] = body.mediaType;
      }
    }
    for (const param of params) {
      if (param.in !== 'header') continue;
      const value = paramValues[`${key}::${param.in}::${param.name}`];
      if (value) headers[param.name] = value;
    }

    try {
      const response = await fetch(url.toString(), {
        method: method.toUpperCase(),
        headers,
        body: wireBody,
      });
      const body_ = await response.text();
      const statusLine = `HTTP ${response.status} ${response.statusText}`;
      let pretty = body_;
      try {
        pretty = JSON.stringify(JSON.parse(body_), null, 2);
      } catch {
        // Not JSON — show raw text (truncated).
        pretty = body_.slice(0, 2000);
      }
      setExecState({ key, status: 'done', text: `${url.toString()}\n${statusLine}\n\n${pretty || '(empty body)'}` });
    } catch (err) {
      // "Failed to fetch" in a browser is almost always CORS: the server
      // rejected the preflight (or blocked the response). Name it explicitly
      // so users don't mistake it for a body/URL problem.
      const raw = err instanceof Error ? err.message : String(err);
      const text = /failed to fetch/i.test(raw)
        ? `Request blocked — the server did not allow this cross-origin call (CORS).\nURL: ${url.toString()}\n\nThe browser never received a response; check that ${new URL(url.toString()).origin} sends Access-Control-Allow-Origin for this origin.`
        : raw;
      setExecState({
        key,
        status: 'error',
        text,
      });
    }
  };

  return (
    // Dark panel background on the container itself: .prose-notes pre injects a
    // my-3 margin around the Spec tab's <pre>, and without a background here
    // the light page color shows through as a white box between the header and
    // the code. It also gives the empty state and error banner a dark backdrop
    // for their light-on-dark text.
    <div className="my-3 overflow-hidden rounded-md border border-border bg-[#1a1f24]">
      {/* Header bar — same chrome as Bpmn/GeoJson blocks */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/50">openapi</span>
          {spec?.info?.version && (
            <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-sky-900/60 text-sky-300">
              v{spec.info.version}
            </span>
          )}
          <span
            data-testid="swagger-online-badge"
            className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded ${
              online ? 'bg-emerald-900/60 text-emerald-300' : 'bg-red-900/60 text-red-300'
            }`}
          >
            {online ? <Wifi size={10} /> : <WifiOff size={10} />}
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {meta.notes && (
            <button
              onClick={() => setShowNotes(!showNotes)}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
              data-testid="swagger-notes-toggle"
            >
              <Info size={12} />
              Notes
            </button>
          )}
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'preview'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/60 hover:text-white/95'
            }`}
          >
            <Network size={12} />
            API Preview
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
            Spec
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

      {showNotes && meta.notes && (
        // Same amber treatment as CodeBlock's notes panel: solid bg-primary
        // band with dark ink text, toggled from the header.
        <div
          className="px-4 py-2 text-xs bg-primary text-[#24292e] border-b border-[#ccc] whitespace-pre-wrap"
          data-testid="swagger-notes-panel"
        >
          {meta.notes}
        </div>
      )}

      {parsed.error ? (
        // Matches CodeBlock's run-error panel — readable on the dark container
        // (text-destructive is tuned for the light prose background).
        <div className="bg-red-950/50 text-red-300 p-3 text-sm font-mono">
          OpenAPI error: {parsed.error}
        </div>
      ) : activeTab === 'code' ? (
        <pre
          style={{ backgroundColor: '#24292e' }}
          className="!my-0 p-4 text-xs text-white/80 font-mono overflow-x-auto max-h-96"
        >
          <code>{specText.trim()}</code>
        </pre>
      ) : (
        <div className="bg-[#1a1f24] text-white/85">
          {/* Title */}
          {spec?.info?.title && (
            <div className="px-4 pt-3">
              <div className="text-sm font-semibold text-white">{spec.info.title}</div>
              {spec.info.description && (
                <div className="mt-1 text-xs text-white/60">{spec.info.description}</div>
              )}
            </div>
          )}

          {/* Server selector — frontmatter overrides land here */}
          <div className="flex items-center gap-2 px-4 pt-3" data-testid="swagger-servers">
            <Server size={12} className="text-white/40" />
            <select
              value={serverIdx}
              onChange={(e) => setServerIdx(Number(e.target.value))}
              className="bg-[#24292e] border border-white/15 rounded px-2 py-1 text-xs font-mono text-white/80"
            >
              {servers.map((s, idx) => (
                <option key={`${s.url}-${idx}`} value={idx}>
                  {s.url || '(no server)'}
                  {s.description ? ` — ${s.description}` : ''}
                </option>
              ))}
            </select>
            {meta.servers && meta.servers.length > 0 && (
              <span className="text-[10px] text-white/40" title="Servers overridden by frontmatter">
                overridden
              </span>
            )}
          </div>

          {hasSwagger2 && (
            <div className="px-4 pt-2 text-[10px] text-amber-300/70">
              Swagger 2.0 spec — rendered as OpenAPI subset
            </div>
          )}

          {/* Tag groups → operations */}
          {[...groups.entries()].map(([tag, rows]) => (
            <div key={tag} className="mt-3">
              <div className="flex items-center gap-2 px-4 py-1 bg-white/5">
                <Globe size={12} className="text-white/40" />
                <span className="text-xs font-semibold uppercase tracking-wide text-white/70">
                  {tag}
                </span>
              </div>
              {rows.map((row) => {
                const key = `${row.method}:${row.path}`;
                const isOpen = expanded.has(key);
                return (
                  <div key={key} className="border-t border-white/10">
                    <button
                      onClick={() => toggleExpanded(key)}
                      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/5 transition-colors"
                      data-testid={`op-${key}`}
                    >
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded border ${METHOD_CLASSES[row.method]}`}
                      >
                        {row.method}
                      </span>
                      <span className="font-mono text-xs text-white/85">{row.path}</span>
                      <span className="text-xs text-white/50 truncate">
                        {row.operation.summary || row.operation.operationId || ''}
                      </span>
                      {row.operation.deprecated && (
                        <span className="px-1 py-0.5 text-[10px] rounded bg-amber-900/60 text-amber-300">
                          deprecated
                        </span>
                      )}
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-3 text-xs">
                        {row.operation.description && (
                          <p className="text-white/60 mb-2 whitespace-pre-wrap">
                            {row.operation.description}
                          </p>
                        )}

                        {row.operation.parameters && row.operation.parameters.length > 0 && (
                          // Inline styles: `.prose-notes th/td` would otherwise paint
                          // light `bg-muted` + white text inside this dark panel.
                          <table className="w-full text-left font-mono mb-2" data-testid="op-params">
                            <thead>
                              <tr style={{ color: 'rgba(255,255,255,0.4)' }}>
                                <th className="pr-3 py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>Name</th>
                                <th className="pr-3 py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>In</th>
                                <th className="pr-3 py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>Value</th>
                                <th className="py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>Description</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.operation.parameters.map((p) => {
                                const paramKey = `${key}::${p.in}::${p.name}`;
                                const value = paramValues[paramKey] ?? defaultValueFor(p);
                                return (
                                  <tr key={`${p.in}-${p.name}`} className="border-t border-white/5">
                                    <td className="pr-3 py-1 text-white/85" style={{ background: 'transparent', border: 'none' }}>
                                      {p.name}
                                      {p.required && <span className="text-red-400"> *</span>}
                                    </td>
                                    <td className="pr-3 py-1 text-white/50" style={{ background: 'transparent', border: 'none' }}>{p.in}</td>
                                    <td className="pr-3 py-1" style={{ background: 'transparent', border: 'none' }}>
                                      <input
                                        type={paramInputType(p)}
                                        value={value}
                                        onChange={(e) =>
                                          setParamValues((prev) => ({ ...prev, [paramKey]: e.target.value }))
                                        }
                                        placeholder={p.in === 'path' ? `{${p.name}}` : ''}
                                        data-testid={`param-${p.in}-${p.name}`}
                                        className="w-28 bg-[#24292e] border border-white/15 rounded px-1.5 py-0.5 text-[11px] font-mono text-white/90 focus:outline-none focus:border-emerald-500/60"
                                      />
                                    </td>
                                    <td className="py-1 text-white/50" style={{ background: 'transparent', border: 'none' }}>
                                      {typeOfParam(p) !== 'string' && <span className="mr-1 text-sky-300/70">{typeOfParam(p)}</span>}
                                      {p.description || ''}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}

                        {row.operation.requestBody?.content && (() => {
                          const content = row.operation.requestBody.content;
                          const mediaTypes = Object.keys(content);
                          const draft =
                            bodyDrafts[key] ||
                            (() => {
                              const mt = mediaTypes[0];
                              const examples = requestBodyExamples(mt, content);
                              return { mediaType: mt, texts: { [mt]: examples[0]?.value ?? '' } };
                            })();
                          const currentText = draft.texts[draft.mediaType] ?? '';
                          const examples = requestBodyExamples(draft.mediaType, content);
                          const savedKey = `${key}::${draft.mediaType}`;
                          const saved = savedExamples[savedKey] || [];

                          const setDraft = (patch: Partial<typeof draft>) =>
                            setBodyDrafts((prev) => ({ ...prev, [key]: { ...draft, ...patch } }));
                          const setText = (text: string) =>
                            setBodyDrafts((prev) => ({
                              ...prev,
                              [key]: { ...draft, texts: { ...draft.texts, [draft.mediaType]: text } },
                            }));

                          return (
                            <div className="mb-2" data-testid="op-request-body">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="flex items-center gap-1 text-white/40">
                                  <PenLine size={11} />
                                  Body editor
                                </span>
                                {mediaTypes.length > 1 ? (
                                  <select
                                    value={draft.mediaType}
                                    onChange={(e) => {
                                      const mt = e.target.value;
                                      const nextExamples = requestBodyExamples(mt, content);
                                      setDraft({
                                        mediaType: mt,
                                        texts: {
                                          ...draft.texts,
                                          [mt]: draft.texts[mt] ?? nextExamples[0]?.value ?? '',
                                        },
                                      });
                                    }}
                                    className="bg-[#24292e] border border-white/15 rounded px-1.5 py-0.5 text-[10px] font-mono text-white/80"
                                    data-testid={`body-media-${key}`}
                                  >
                                    {mediaTypes.map((mt) => (
                                      <option key={mt} value={mt}>
                                        {mediaTypeLabel(mt)} — {mt}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="text-[10px] font-mono text-white/40">{draft.mediaType}</span>
                                )}

                                {(examples.length > 0 || saved.length > 0) && (
                                  <select
                                    value=""
                                    onChange={(e) => {
                                      const selected = e.target.value;
                                      // Saved options carry a "★ " prefix in their value.
                                      const example = selected.startsWith('★ ')
                                        ? saved.find((x) => `★ ${x.name}` === selected)
                                        : examples.find((x) => x.name === selected);
                                      if (example) setText(example.value);
                                    }}
                                    className="bg-[#24292e] border border-white/15 rounded px-1.5 py-0.5 text-[10px] font-mono text-sky-300"
                                    data-testid={`body-example-${key}`}
                                  >
                                    <option value="">Load example…</option>
                                    {examples.map((ex) => (
                                      <option key={ex.name} value={ex.name}>
                                        {ex.name}
                                      </option>
                                    ))}
                                    {saved.map((ex) => (
                                      <option key={`★ ${ex.name}`} value={`★ ${ex.name}`}>
                                        ★ {ex.name}
                                      </option>
                                    ))}
                                  </select>
                                )}

                                {currentText.trim() && (
                                  <button
                                    onClick={() => {
                                      const name = `Saved ${saved.length + 1}`;
                                      setSavedExamples((prev) => ({
                                        ...prev,
                                        [savedKey]: [...(prev[savedKey] || []), { name, value: currentText }],
                                      }));
                                    }}
                                    className="flex items-center gap-1 text-[10px] font-mono text-white/50 hover:text-white/90 transition-colors"
                                    data-testid={`body-save-${key}`}
                                  >
                                    <Save size={11} />
                                    Save as example
                                  </button>
                                )}
                                <button
                                  onClick={() => setText(examples[0]?.value ?? '')}
                                  className="flex items-center gap-1 text-[10px] font-mono text-white/40 hover:text-white/80 transition-colors"
                                  data-testid={`body-reset-${key}`}
                                >
                                  <RotateCcw size={11} />
                                  Reset
                                </button>
                              </div>
                              <div className="relative rounded border border-white/10 overflow-hidden focus-within:border-emerald-500/60">
                                <LazyBodyForm
                                  mediaType={draft.mediaType}
                                  value={currentText}
                                  onChange={setText}
                                  testId={`body-input-${key}`}
                                />
                              </div>
                            </div>
                          );
                        })()}

                        {row.operation.responses && (
                          <div className="mb-2" data-testid="op-responses">
                            {Object.entries(row.operation.responses).map(([code, resp]) => (
                              <div key={code} className="flex items-baseline gap-2">
                                <span
                                  className={`font-mono ${
                                    code.startsWith('2')
                                      ? 'text-emerald-400'
                                      : code.startsWith('4') || code.startsWith('5')
                                        ? 'text-red-400'
                                        : 'text-white/50'
                                  }`}
                                >
                                  {code}
                                </span>
                                <span className="text-white/50">{resp.description || ''}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        <button
                          onClick={() =>
                            handleTryIt(
                              key,
                              row.method,
                              row.path,
                              row.operation.parameters || [],
                              row.operation.requestBody?.content
                                ? bodyDrafts[key] && bodyDrafts[key].texts[bodyDrafts[key].mediaType] !== undefined
                                  ? { mediaType: bodyDrafts[key].mediaType, text: bodyDrafts[key].texts[bodyDrafts[key].mediaType] }
                                  : {
                                      mediaType: Object.keys(row.operation.requestBody.content)[0],
                                      text: defaultRequestBody(Object.keys(row.operation.requestBody.content)[0], row.operation.requestBody.content),
                                    }
                                : undefined
                            )
                          }
                          disabled={execState?.key === key && execState.status === 'loading'}
                          className="mt-1 flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-emerald-700/80 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                          data-testid={`try-${key}`}
                        >
                          {execState?.key === key && execState.status === 'loading' ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : null}
                          Try it out
                        </button>

                        {execState?.key === key && execState.status !== 'loading' && (
                          <div
                            data-testid={`tryit-output-${key}`}
                            className={`mt-2 p-2 rounded font-mono whitespace-pre-wrap overflow-x-auto max-h-64 ${
                              execState.status === 'error'
                                ? 'bg-red-950/50 text-red-300'
                                : 'bg-black/30 text-emerald-300'
                            }`}
                          >
                            {execState.text}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {groups.size === 0 && (
            <div className="px-4 py-6 text-xs text-white/40">No operations in spec.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Display type for a parameter (OpenAPI 3 schema or Swagger 2.0 type). */
function typeOfParam(p: SwaggerParameter): string {
  if (p.type) return p.type;
  if (p.schema && typeof p.schema === 'object') {
    const s = p.schema as { type?: string; $ref?: string; format?: string };
    if (s.$ref) return s.$ref.split('/').pop() || s.$ref;
    if (s.type) return s.format ? `${s.type} (${s.format})` : s.type;
  }
  return 'string';
}

/**
 * Lazy body-form host: resolves the editor component for a media type via
 * bodyFormFor() and dynamic-imports it (JSON editor, text editor, or file
 * picker each live in their own chunk). The key forces a clean remount when
 * the form kind changes so editor state never leaks across forms.
 */
/**
 * Lazy body-form host: resolves the editor component for a media type via
 * bodyFormFor() and React.lazy-imports it (JSON editor, text editor, or file
 * picker each live in their own chunk). The lazy component is memoized per
 * form kind; the key forces a clean remount when the kind changes so editor
 * state never leaks across forms.
 */
const LazyJsonBodyForm = lazy(() => import('./bodyForms/JsonBodyForm'));
const LazyTextBodyForm = lazy(() => import('./bodyForms/TextBodyForm'));
const LazyFileBodyForm = lazy(() => import('./bodyForms/FileBodyForm'));

const LazyMultipartBodyForm = lazy(() => import('./bodyForms/MultipartBodyForm'));

const BODY_FORMS: Record<string, React.LazyExoticComponent<BodyFormComponent>> = {
  json: LazyJsonBodyForm,
  multipart: LazyMultipartBodyForm,
  file: LazyFileBodyForm,
  text: LazyTextBodyForm,
};

function LazyBodyForm({
  mediaType,
  value,
  onChange,
  testId,
}: {
  mediaType: string;
  value: string;
  onChange: (t: string) => void;
  testId: string;
}) {
  const kind = /json/i.test(mediaType)
    ? 'json'
    : /multipart\//i.test(mediaType)
      ? 'multipart'
      : /octet-stream|image\/|audio\/|video\/|pdf|zip|gzip|protobuf|msgpack/i.test(mediaType)
        ? 'file'
        : 'text';

  const Form = BODY_FORMS[kind];
  return (
    <Suspense
      fallback={
        <div className="p-3 rounded bg-[#24292e] min-h-[76px] flex items-center gap-2 text-xs text-white/40">
          <Loader2 size={12} className="animate-spin" />
          Loading body editor…
        </div>
      }
    >
      <Form key={kind} value={value} mediaType={mediaType} lang={mediaTypeLang(mediaType)} testId={testId} onChange={onChange} />
    </Suspense>
  );
}

/**
 * Seed value for a parameter input: the schema example when the spec
 * supplies one, else the empty string (the user types their own).
 */
function defaultValueFor(param: SwaggerParameter): string {
  if (param.schema && typeof param.schema === 'object') {
    const example = (param.schema as { example?: unknown }).example;
    if (example !== undefined) return String(example);
  }
  if (param.type === 'boolean') return 'true';
  return '';
}

/** Input type for a parameter's schema type (bool → checkbox-ish select). */
function paramInputType(param: SwaggerParameter): 'number' | 'text' {
  const t = param.type || ((param.schema as { type?: string } | undefined)?.type ?? '');
  return t === 'integer' || t === 'number' ? 'number' : 'text';
}
