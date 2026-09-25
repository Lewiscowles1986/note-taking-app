import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Loader2,
  LogIn,
  LogOut,
  Server,
  Trash2,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Lock, X } from 'lucide-react';
import {
  loadSyncSettings,
  saveSyncSettings,
  clearSyncSettings,
  type StoredSyncSettings,
  type SyncScope,
} from '@/lib/syncSettings';
import { parseDiscoveryExclusions, type ServerExclusions } from '@/lib/sync';
import { refreshAutoSyncScheduler } from '@/lib/autoSyncScheduler';
import { runSync, SyncError } from '@/lib/sync';
import { runInFlight } from '@/lib/inFlight';
import { resolveAuthToken } from '@/lib/authToken';
import {
  loadOidcConfig,
  loadOidcSession,
  saveOidcConfig,
  clearOidcSession,
  type OidcClientConfig,
  type OidcSession,
} from '@/lib/oidcStorage';
import { getAllCategories } from '@/lib/db';
import SyncNotifications from '@/components/SyncNotifications';
import { toast } from 'sonner';

interface SettingsPageProps {
  onBack: () => void;
  /** Fires after a successful sync so the caller can refresh its note list. */
  onSynced?: () => void;
}

/**
 * Full-screen sync settings page (same layout pattern as the calendar view).
 *
 * Account: OIDC (Authorization Code + PKCE) sign-in against the configured
 * server — the preferred path. The manual bearer token moves into an
 * "Advanced" collapsible for servers without OIDC.
 *
 * What to sync: all notes, or only chosen categories (out-of-scope notes are
 * never pushed/pulled and their remote deletions are ignored).
 *
 * Server connection: base URL + auto-sync cadence. "Sync now" runs the
 * two-way merge through the global in-flight registry so it shows in the
 * indicator, is cancellable, and conflicts with concurrent syncs instead of
 * racing them.
 */
export default function SettingsPage({ onBack, onSynced }: SettingsPageProps) {
  const [stored, setStored] = useState<StoredSyncSettings>(() => loadSyncSettings());
  const [serverUrl, setServerUrl] = useState(stored.serverUrl);
  const [authToken, setAuthToken] = useState(stored.authToken);
  const [autoSync, setAutoSync] = useState(stored.autoSync);
  const [intervalInput, setIntervalInput] = useState(String(stored.intervalMinutes));
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // OIDC: client config + current session (signed-in identity).
  const [oidcConfig, setOidcConfig] = useState<OidcClientConfig>(() => loadOidcConfig());
  const [oidcIssuerInput, setOidcIssuerInput] = useState(() => loadOidcConfig().issuer);
  const [oidcClientIdInput, setOidcClientIdInput] = useState(() => loadOidcConfig().clientId);
  const [session, setSession] = useState<OidcSession | null>(() => loadOidcSession());
  const [signingIn, setSigningIn] = useState(false);

  // Sync scope.
  const [syncScope, setSyncScope] = useState<SyncScope>(stored.syncScope);
  const [syncedCategories, setSyncedCategories] = useState<string[]>(stored.syncedCategories);
  const [dbCategories, setDbCategories] = useState<string[]>([]);
  // Client-side exclusions (deny lists, per device).
  const [excludedCategories, setExcludedCategories] = useState<string[]>(stored.excludedCategories);
  // Server-side policy, read from the discovery document (read-only here).
  const [serverExclusions, setServerExclusions] = useState<ServerExclusions>({
    excludedCategories: [],
    excludedUids: [],
  });

  const dirty =
    serverUrl !== stored.serverUrl ||
    authToken !== stored.authToken ||
    autoSync !== stored.autoSync ||
    intervalInput !== String(stored.intervalMinutes) ||
    syncScope !== stored.syncScope ||
    JSON.stringify(syncedCategories) !== JSON.stringify(stored.syncedCategories) ||
    JSON.stringify(excludedCategories) !== JSON.stringify(stored.excludedCategories);

  const parsedInterval = useMemo(() => {
    const n = Number(intervalInput);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : null;
  }, [intervalInput]);

  const currentConfig: StoredSyncSettings = useMemo(
    () => ({
      serverUrl: serverUrl.trim().replace(/\/+$/, ''),
      authToken,
      autoSync,
      intervalMinutes: parsedInterval ?? stored.intervalMinutes,
      syncScope,
      syncedCategories,
      excludedCategories,
      excludedNoteIds: stored.excludedNoteIds,
      lastSync: stored.lastSync,
    }),
    [
      serverUrl,
      authToken,
      autoSync,
      parsedInterval,
      stored.intervalMinutes,
      stored.excludedNoteIds,
      stored.lastSync,
      syncScope,
      syncedCategories,
      excludedCategories,
    ],
  );

  // Category list for the scope picker: distinct categories from the database
  // plus any stored selections that no longer exist locally (shown with a
  // "(gone)" hint, still removable).
  useEffect(() => {
    let cancelled = false;
    getAllCategories()
      .then((cats) => {
        if (!cancelled) setDbCategories(cats);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const selectableCategories = useMemo(() => {
    const gone = syncedCategories.filter((c) => !dbCategories.includes(c));
    return Array.from(new Set([...dbCategories, ...gone])).sort((a, b) => a.localeCompare(b));
  }, [dbCategories, syncedCategories]);

  // Categories this server refuses to store (from discovery notes.excluded_*).
  const serverDeniedCategories = useMemo(
    () => new Set(serverExclusions.excludedCategories),
    [serverExclusions],
  );

  // Server policy: fetch the discovery document when a server is configured.
  // setState happens only inside the async continuation (never synchronously
  // in the effect body), and a cleared server URL resets the policy to none.
  useEffect(() => {
    let cancelled = false;
    const base = stored.serverUrl;
    const policy = base
      ? fetch(`${base}/.well-known/openid-configuration`)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      : Promise.resolve(null);
    policy.then((doc) => {
      if (cancelled) return;
      setServerExclusions(doc ? parseDiscoveryExclusions(doc) : { excludedCategories: [], excludedUids: [] });
    });
    return () => {
      cancelled = true;
    };
  }, [stored.serverUrl]);

  /** Persist current fields (also used before a sync so the engine sees them). */
  const persist = (extra?: Partial<StoredSyncSettings>) => {
    const next = { ...currentConfig, ...extra };
    saveSyncSettings(next);
    // App-level scheduler follows auto-sync config changes.
    refreshAutoSyncScheduler();
    setStored(next);
  };

  const save = () => {
    persist();
    saveOidcConfig({
      issuer: oidcIssuerInput.trim().replace(/\/+$/, '') || oidcConfig.issuer,
      clientId: oidcClientIdInput.trim() || oidcConfig.clientId,
      scope: oidcConfig.scope,
    });
    setOidcConfig(loadOidcConfig());
    toast.success('Sync settings saved');
  };

  const handleSync = async () => {
    // Unsaved field edits apply before the run — otherwise the engine would
    // sync against a stale configuration.
    persist();
    setSyncing(true);
    try {
      const result = await runInFlight({ label: 'Syncing with server', group: 'sync' }, async () =>
        runSync(),
      );
      if (result.ok) {
        toast.success(`Sync complete — ${result.summary}`);
      } else {
        toast.warning(`Sync finished with problems — ${result.summary}`, {
          description: result.errors.join('\n'),
        });
      }
      onSynced?.();
    } catch (err) {
      if (!(err instanceof Error && err.name === 'CancelledError')) {
        toast.error(err instanceof Error ? err.message : 'Sync failed');
      }
    } finally {
      setSyncing(false);
      setStored(loadSyncSettings());
      setSession(loadOidcSession());
    }
  };

  const handleTest = async () => {
    if (!currentConfig.serverUrl) {
      toast.error('Enter a server URL first');
      return;
    }
    persist();
    setTesting(true);
    try {
      const base = currentConfig.serverUrl;
      // Same resolution as the sync engine: OIDC session token when signed
      // in, else the manual bearer token.
      const token = await resolveAuthToken(currentConfig.authToken);
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${base}/api/notes`, { method: 'GET', headers });
      if (!response.ok) {
        toast.error(`Server responded ${response.status}`);
      } else {
        const text = await response.text();
        let notes: unknown = null;
        try {
          notes = text ? (JSON.parse(text) as unknown) : null;
        } catch {
          toast.error('Server responded with invalid JSON');
          return;
        }
        const list = Array.isArray(notes)
          ? notes
          : ((notes as { notes?: unknown })?.notes as unknown[] | undefined);
        if (!Array.isArray(list)) {
          toast.error('Reached the server, but the response is not a notes manifest');
          return;
        }
        toast.success(`Connection OK — ${list.length} note${list.length !== 1 ? 's' : ''} on server`);
      }
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setTesting(false);
    }
  };

  const handleForget = () => {
    clearSyncSettings();
    clearOidcSession();
    refreshAutoSyncScheduler();
    setStored(loadSyncSettings());
    setSession(loadOidcSession());
    setServerUrl('');
    setAuthToken('');
    setAutoSync(false);
    setIntervalInput('15');
    setSyncScope('all');
    setSyncedCategories([]);
    toast.success('Server connection forgotten');
  };

  // ─── OIDC sign-in / sign-out ─────────────────────────────────────────────

  const handleSignIn = async (prompt?: 'login') => {
    // Persist the (possibly edited) issuer/client id first — login() reads
    // the stored config.
    saveOidcConfig({
      issuer: oidcIssuerInput.trim().replace(/\/+$/, ''),
      clientId: oidcClientIdInput.trim() || oidcConfig.clientId,
      scope: oidcConfig.scope,
    });
    // The sync server doubles as the OIDC issuer for the reference setup.
    // Persist the auto-fill immediately: login() navigates away before any
    // other save could run, and the post-callback remount reads storage.
    if (!serverUrl.trim()) {
      const issuer = oidcIssuerInput.trim().replace(/\/+$/, '');
      setServerUrl(issuer);
      saveSyncSettings({ ...currentConfig, serverUrl: issuer });
    }
    setSigningIn(true);
    try {
      // Lazy import keeps the crypto/JWKS machinery out of the settings
      // chunk until a sign-in is actually requested.
      const { login } = await import('@/lib/oidcAuth');
      // prompt=login forces the IdP to show its login form even when its
      // SSO session cookie is alive — that is how a second identity gets
      // nominated without clearing anything.
      await login({ returnTo: '/?settings=1', ...(prompt ? { prompt } : {}) });
      // Navigation away happens inside login(); reaching this line means the
      // redirect did not start.
      toast.error('Could not start sign-in — check the issuer URL');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      const { logout } = await import('@/lib/oidcAuth');
      await logout();
      toast.success('Signed out');
    } catch {
      toast.error('Sign-out failed — tokens cleared locally anyway');
      clearOidcSession();
    }
    setSession(loadOidcSession());
  };

  const signedInName =
    session?.claims?.preferred_username ??
    session?.claims?.name ??
    session?.claims?.email ??
    session?.claims?.sub ??
    '';

  const lastSyncLine = stored.lastSync
    ? `${new Date(stored.lastSync.at).toLocaleString()} — ${stored.lastSync.summary}`
    : 'Never synced';

  return (
    <div className="flex h-dvh bg-background overflow-hidden">
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Header — mirrors the calendar header layout */}
        <div className="flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)_+_0.5rem)] pr-[calc(env(safe-area-inset-right,0px)_+_1rem)] border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="p-2.5 min-w-11 min-h-11 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors sm:min-w-min sm:min-h-min sm:p-1.5"
              title="Back to notes"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-medium text-foreground">Settings</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Queued keep-or-delete prompts — inline with the header actions. */}
            <SyncNotifications />
            <button
              onClick={() => {
                save();
                onBack();
              }}
              disabled={!dirty}
              className="flex items-center gap-1.5 px-3 py-2.5 min-h-11 whitespace-nowrap rounded text-xs font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 sm:py-1 sm:min-h-0"
            >
              <Check size={12} />
              Done
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
            {/* Account / sign-in */}
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <UserRound size={16} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Account</h2>
              </div>
              {session ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
                  <div className="min-w-0">
                    <p
                      className="text-sm font-medium text-foreground truncate"
                      data-testid="oidc-signed-in-as"
                    >
                      {signedInName || 'Signed in'}
                    </p>
                    {session.claims.email && session.claims.email !== signedInName && (
                      <p className="text-xs text-muted-foreground truncate">{session.claims.email}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleSignOut()}
                    data-testid="oidc-sign-out"
                  >
                    <LogOut size={14} className="mr-1.5" />
                    Sign out
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Sign in to your sync server with OpenID Connect (Authorization Code + PKCE).
                    Your password never touches this app — the server issues the tokens.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="oidc-issuer">Sign-in server (issuer)</Label>
                      <Input
                        id="oidc-issuer"
                        type="url"
                        inputMode="url"
                        placeholder="http://localhost:8080"
                        value={oidcIssuerInput}
                        onChange={(e) => setOidcIssuerInput(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="oidc-client-id">Client ID</Label>
                      <Input
                        id="oidc-client-id"
                        placeholder="note-haven-pkce"
                        value={oidcClientIdInput}
                        onChange={(e) => setOidcClientIdInput(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleSignIn()}
                      disabled={signingIn}
                      data-testid="oidc-sign-in"
                    >
                      {signingIn ? (
                        <Loader2 size={14} className="animate-spin mr-1.5" />
                      ) : (
                        <LogIn size={14} className="mr-1.5" />
                      )}
                      Sign in with Note Haven server
                    </Button>
                    {/* OIDC prompt=login: the IdP re-authenticates even with a
                        live SSO session, so a second identity can be nominated
                        without clearing cookies or restarting the browser. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleSignIn('login')}
                      disabled={signingIn}
                      data-testid="oidc-sign-in-different"
                    >
                      <UserRound size={14} className="mr-1.5" />
                      Use a different account
                    </Button>
                  </div>
                </div>
              )}
            </section>

            {/* Connection */}
            <section className="space-y-4 border-t pt-6">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Sync server</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Notes sync with a REST JSON server over{' '}
                <code className="bg-muted px-1 rounded">/api/notes</code> — see{' '}
                {/* Pinned to the exact revision this build came from (set at
                    build time via VITE_DEPLOYED_REF; 'main' fallback in dev)
                    so the docs always describe the deployed software. */}
                <a
                  href={`https://github.com/lewiscowles/note-taking-app/blob/${__DEPLOYED_REF__}/docs/sync.md`}
                  className="underline hover:text-foreground"
                  target="_blank"
                  rel="noreferrer"
                >
                  the sync protocol docs
                </a>{' '}
                for a reference server.
              </p>

              <div className="space-y-2">
                <Label htmlFor="sync-server-url">Server URL</Label>
                <Input
                  id="sync-server-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://sync.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {/* Advanced: manual bearer token fallback for non-OIDC servers */}
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    data-testid="sync-advanced-toggle"
                  >
                    {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Advanced: manual access token
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 pt-2">
                  <p className="text-xs text-muted-foreground">
                    For servers without sign-in. Ignored while you are signed in above — the
                    sign-in token takes precedence.
                  </p>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="sync-token">Access token (optional)</Label>
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {showToken ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <Input
                      id="sync-token"
                      type={showToken ? 'text' : 'password'}
                      placeholder="Bearer token"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleTest}
                  disabled={testing}
                >
                  {testing ? (
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                  ) : (
                    <Cloud size={14} className="mr-1.5" />
                  )}
                  Test connection
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={save} disabled={!dirty}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleForget}
                  disabled={!stored.serverUrl}
                >
                  <Trash2 size={14} className="mr-1.5" />
                  Forget server
                </Button>
              </div>
            </section>

            {/* What to sync (scope) */}
            <section className="space-y-3 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">What to sync</h3>
              <RadioGroup
                value={syncScope}
                onValueChange={(v) => setSyncScope(v === 'categories' ? 'categories' : 'all')}
                className="gap-3"
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="all" id="scope-all" data-testid="sync-scope-all" />
                  <div>
                    <Label htmlFor="scope-all" className="font-normal">
                      All notes
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Every note on this device syncs, in both directions.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem
                    value="categories"
                    id="scope-categories"
                    data-testid="sync-scope-categories"
                  />
                  <div>
                    <Label htmlFor="scope-categories" className="font-normal">
                      Selected categories only
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Notes outside the chosen categories stay on this device and are never
                      pulled in. If the server deletes one of them, you are not asked about it.
                    </p>
                  </div>
                </div>
              </RadioGroup>
              {syncScope === 'categories' && (
                <div className="rounded-md border px-3 py-2.5 space-y-1.5" data-testid="sync-scope-picker">
                  {selectableCategories.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No categories found — create a note first. With nothing selected, nothing
                      syncs.
                    </p>
                  )}
                  {selectableCategories.map((category) => {
                    const gone = !dbCategories.includes(category);
                    const checked = syncedCategories.includes(category);
                    const serverDenied = serverDeniedCategories.has(category);
                    // Server deny blocks ADDING a category to the allow-list,
                    // never REMOVING it: the checkbox stays enabled so a
                    // stale pre-existing entry can always be unchecked, and
                    // the onCheckedChange guard below is what refuses the
                    // check direction (a disabled checkbox could never fire
                    // the removal).
                    return (
                      <label
                        key={category}
                        className={`flex items-center gap-2 text-sm text-foreground ${serverDenied ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                        title={serverDenied ? 'Denied by server policy' : undefined}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => {
                            // Deny only the ADD direction (v === true) on a
                            // server-denied category; unchecking (removal)
                            // must always be possible.
                            if (serverDenied && v === true) return;
                            setSyncedCategories((prev) =>
                              v === true
                                ? Array.from(new Set([...prev, category]))
                                : prev.filter((c) => c !== category),
                            );
                          }}
                          data-testid={`sync-scope-cat-${category}`}
                        />
                        <span className="flex items-center gap-1">
                          {category}
                          {gone && <span className="text-xs text-muted-foreground"> (gone)</span>}
                          {serverDenied && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                              data-testid={`sync-server-denied-${category}`}
                              title="Denied by server policy — this category never syncs"
                            >
                              <Lock size={10} aria-hidden />
                              Denied by server policy
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Client-side exclusions (deny wins over everything above). */}
              <div className="rounded-md border px-3 py-2.5 space-y-2" data-testid="sync-exclusions">
                <div>
                  <p className="text-sm font-medium text-foreground">Excluded from sync</p>
                  <p className="text-xs text-muted-foreground">
                    Notes in these categories stay on this device and are never pushed or pulled —
                    even if the category is selected above. Deny always wins.
                  </p>
                </div>
                {excludedCategories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {excludedCategories.map((category) => (
                      <span
                        key={category}
                        className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-foreground"
                        data-testid={`sync-excluded-chip-${category}`}
                      >
                        {category}
                        <button
                          type="button"
                          aria-label={`Stop excluding ${category}`}
                          className="rounded-full p-0.5 hover:bg-foreground/10"
                          onClick={() => setExcludedCategories((prev) => prev.filter((c) => c !== category))}
                        >
                          <X size={10} aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {(() => {
                  const remaining = dbCategories.filter(
                    (c) => !excludedCategories.includes(c) && !serverDeniedCategories.has(c),
                  );
                  if (remaining.length === 0) return null;
                  return (
                    <select
                      className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
                      value=""
                      aria-label="Add a category to exclude from sync"
                      data-testid="sync-excluded-add"
                      onChange={(e) => {
                        const category = e.target.value;
                        if (!category) return;
                        setExcludedCategories((prev) => Array.from(new Set([...prev, category])));
                      }}
                    >
                      <option value="">Exclude a category…</option>
                      {remaining.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  );
                })()}
                {serverExclusions.excludedCategories.length > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="sync-server-exclusions-note">
                    <Lock size={10} className="inline mr-1 -mt-0.5" aria-hidden />
                    Server policy also excludes: {serverExclusions.excludedCategories.join(', ')}
                  </p>
                )}
              </div>
            </section>

            {/* Sync now + status */}
            <section className="space-y-3 border-t pt-6">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Two-way sync</h3>
                  <p className="text-xs text-muted-foreground">
                    Merges per note — the newest edit (server or device) wins. Notes deleted on
                    the server are never removed here automatically: a notification asks you to
                    keep or delete each one.
                  </p>
                </div>
                <Button type="button" size="sm" onClick={() => void handleSync()} disabled={syncing}>
                  {syncing ? (
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                  ) : (
                    <>
                      <ArrowUpFromLine size={14} className="mr-1" />
                      <ArrowDownToLine size={14} className="-ml-1" />
                    </>
                  )}
                  Sync now
                </Button>
              </div>

              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
                <div className="flex items-center gap-1.5">
                  {stored.lastSync ? (
                    stored.lastSync.ok ? (
                      <Check size={12} className="text-green-600" />
                    ) : (
                      <TriangleAlert size={12} className="text-amber-600" />
                    )
                  ) : (
                    <CalendarClock size={12} />
                  )}
                  <span data-testid="sync-last-status">{lastSyncLine}</span>
                </div>
                {stored.lastSync && !stored.lastSync.ok && (
                  <div className="whitespace-pre-wrap">{stored.lastSync.summary}</div>
                )}
              </div>
            </section>

            {/* Auto sync */}
            <section className="space-y-3 border-t pt-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="sync-auto" className="text-sm font-semibold">
                    Automatic sync
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Sync in the background every N minutes while the app is open.
                  </p>
                </div>
                <Switch
                  id="sync-auto"
                  checked={autoSync}
                  onCheckedChange={(checked) => setAutoSync(checked === true)}
                />
              </div>
              {autoSync && (
                <div className="space-y-2">
                  <Label htmlFor="sync-interval">Interval (minutes)</Label>
                  <Input
                    id="sync-interval"
                    type="number"
                    min={1}
                    step={1}
                    className="w-32"
                    value={intervalInput}
                    onChange={(e) => setIntervalInput(e.target.value)}
                  />
                  {intervalInput !== '' && parsedInterval == null && (
                    <p className="text-xs text-destructive">Enter a positive number of minutes.</p>
                  )}
                </div>
              )}
            </section>

            {/* Privacy */}
            <section className="border-t pt-6 space-y-2">
              <h3 className="text-sm font-semibold text-foreground">Privacy</h3>
              <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                <li>
                  Encrypted notes sync only in their encrypted form — the key never leaves this
                  device.
                </li>
                <li>
                  Sign-in and access tokens are stored locally and sent only to the server above.
                </li>
                <li>Deleting a note on this device also deletes it on the server at the next sync.</li>
                <li>
                  Notes deleted on the server are never removed here automatically — a
                  notification asks you to keep or delete each one.
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}