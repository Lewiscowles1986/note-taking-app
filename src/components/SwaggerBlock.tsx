import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Code2,
  Globe,
  Loader2,
  Network,
  Server,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  SpecParseError,
  parseSpec,
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
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [serverIdx, setServerIdx] = useState(0);
  const [execState, setExecState] = useState<
    { key: string; status: 'loading' | 'done' | 'error'; text: string } | null
  >(null);

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
    params: SwaggerParameter[]
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

    let url: URL;
    try {
      url = new URL(base + path);
    } catch {
      setExecState({ key, status: 'error', text: `Invalid URL: ${base}${path}` });
      return;
    }

    for (const param of params) {
      if (param.in === 'query' && param.schema && typeof (param.schema as { example?: unknown }).example !== 'undefined') {
        url.searchParams.set(param.name, String((param.schema as { example?: unknown }).example));
      }
    }

    try {
      const response = await fetch(url.toString(), { method: method.toUpperCase() });
      const body = await response.text();
      const statusLine = `HTTP ${response.status} ${response.statusText}`;
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Not JSON — show raw text (truncated).
        pretty = body.slice(0, 2000);
      }
      setExecState({ key, status: 'done', text: `${statusLine}\n\n${pretty || '(empty body)'}` });
    } catch (err) {
      setExecState({
        key,
        status: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border">
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

      {meta.notes && (
        <div className="px-4 py-2 text-xs bg-primary text-[#24292e] border-b border-[#ccc] whitespace-pre-wrap">
          {meta.notes}
        </div>
      )}

      {parsed.error ? (
        <div className="bg-destructive/10 text-destructive p-3 text-sm font-mono">
          OpenAPI error: {parsed.error}
        </div>
      ) : activeTab === 'code' ? (
        <pre
          style={{ backgroundColor: '#24292e' }}
          className="p-4 text-xs text-white/80 font-mono overflow-x-auto max-h-96"
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
                                <th className="pr-3 py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>Type</th>
                                <th className="py-1 font-normal" style={{ background: 'transparent', border: 'none' }}>Description</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.operation.parameters.map((p) => (
                                <tr key={`${p.in}-${p.name}`} className="border-t border-white/5">
                                  <td className="pr-3 py-1 text-white/85" style={{ background: 'transparent', border: 'none' }}>
                                    {p.name}
                                    {p.required && <span className="text-red-400"> *</span>}
                                  </td>
                                  <td className="pr-3 py-1 text-white/50" style={{ background: 'transparent', border: 'none' }}>{p.in}</td>
                                  <td className="pr-3 py-1 text-sky-300" style={{ background: 'transparent', border: 'none' }}>
                                    {typeOfParam(p)}
                                  </td>
                                  <td className="py-1 text-white/50" style={{ background: 'transparent', border: 'none' }}>{p.description || ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {row.operation.requestBody?.content && (
                          <div className="mb-2 text-white/60" data-testid="op-request-body">
                            <span className="text-white/40">Request body:</span>{' '}
                            {Object.keys(row.operation.requestBody.content).join(', ')}
                          </div>
                        )}

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
                            handleTryIt(key, row.method, row.path, row.operation.parameters || [])
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