import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronLeft,
  Cloud,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  Server,
  Settings as SettingsIcon,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { runInFlight } from '@/lib/inFlight';
import { toast } from 'sonner';
import {
  addServer,
  listServers,
  removeServer,
  renameServer,
  getServerSettings,
  type ServerRecord,
} from '@/lib/syncServers';
import { resolveAuthToken } from '@/lib/authToken';
import { loadOidcSessionFor, type OidcSession } from '@/lib/oidcStorage';
import SyncNotifications from '@/components/SyncNotifications';

interface ServersPageProps {
  /** Back to the settings page (which shows this server's details). */
  onBack: () => void;
  /** Close BOTH pages — back to the main notes view. */
  onClose: () => void;
  /** Opens the per-server SettingsPage scoped to that server. */
  onOpenServerSettings: (serverId: string) => void;
  /** Fires after any sync so the caller can refresh its note list. */
  onSynced?: () => void;
}

/**
 * Servers page — the list of configured sync servers, each syncing
 * independently with its own settings, identity and sync cadence.
 *
 * Navigation model: Index opens this page from the gear button. "Back"
 * (left chevron) returns to the per-server settings of the server you came
 * from (or notes when there is none — not reachable today); "Close" (right)
 * closes BOTH pages and returns to the notes view.
 */
export default function ServersPage({ onBack, onClose, onOpenServerSettings, onSynced }: ServersPageProps) {
  // Servers + their settings + sessions, re-read on demand (storage events
  // from other tabs and same-tab mutations both funnel through reload()).
  const [servers, setServers] = useState<ServerRecord[]>(() => listServers());
  const [settings, setSettings] = useState<Record<string, ReturnType<typeof getServerSettings>>>(() =>
    Object.fromEntries(listServers().map((s) => [s.id, getServerSettings(s.id)])),
  );
  const [sessions, setSessions] = useState<Record<string, OidcSession | null>>(() =>
    Object.fromEntries(listServers().map((s) => [s.id, loadOidcSessionFor(s.id)])),
  );
  const [addUrl, setAddUrl] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  /** id of the row whose label is being edited inline. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** id of the row pending a Remove confirmation. */
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const reload = useCallback(() => {
    const list = listServers();
    setServers(list);
    setSettings(Object.fromEntries(list.map((s) => [s.id, getServerSettings(s.id)])));
    setSessions(Object.fromEntries(list.map((s) => [s.id, loadOidcSessionFor(s.id)])));
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => reload();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reload]);

  const handleAdd = () => {
    const url = addUrl.trim().replace(/\/+$/, '');
    if (!url) {
      toast.error('Enter a server URL first');
      return;
    }
    setAdding(true);
    try {
      const record = addServer(url, addLabel.trim() || undefined);
      setAddUrl('');
      setAddLabel('');
      reload();
      toast.success(`Server added — ${record.label ?? record.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the server');
    } finally {
      setAdding(false);
    }
  };

  const handleSyncOne = async (serverId: string) => {
    setSyncingId(serverId);
    try {
      const { runSync } = await import('@/lib/sync');
      const result = await runInFlight(
        { label: `Syncing server`, group: 'sync' },
        async () => runSync({ serverId }),
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
      setSyncingId(null);
      reload();
    }
  };

  const handleTestOne = async (serverId: string) => {
    setTestingId(serverId);
    try {
      const { testConnection } = await import('@/lib/syncTest');
      await testConnection(serverId);
    } finally {
      setTestingId(null);
    }
  };

  const handleSignIn = async (serverId: string) => {
    setSigningId(serverId);
    try {
      // Lazy import keeps the crypto/JWKS machinery out of this chunk until a
      // sign-in is actually requested. login() persists the per-server OIDC
      // config (issuer = the sync server URL by default) and navigates away.
      const { login } = await import('@/lib/oidcAuth');
      const { getServerSettings, saveServerSettings } = await import('@/lib/syncServers');
      const { loadOidcConfigFor, saveOidcConfigFor } = await import('@/lib/oidcStorage');
      // Default the OIDC issuer to the sync server itself (reference setup).
      const config = loadOidcConfigFor(serverId);
      if (config.issuer !== serverId) {
        saveOidcConfigFor(serverId, { ...config, issuer: serverId });
      }
      // Seed the per-server settings with the URL so the engine has a base
      // even before the user opens this server's settings page.
      const settings = getServerSettings(serverId);
      saveServerSettings(serverId, settings);
      await login(serverId, { returnTo: '/?servers=1' });
      toast.error('Could not start sign-in — check the issuer URL');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setSigningId(null);
    }
  };

  const handleSignOut = async (serverId: string) => {
    setSigningId(serverId);
    try {
      const { logout } = await import('@/lib/oidcAuth');
      await logout(serverId);
      toast.success('Signed out');
    } catch {
      toast.error('Sign-out failed — tokens cleared locally anyway');
      const { clearOidcSessionFor } = await import('@/lib/oidcStorage');
      clearOidcSessionFor(serverId);
    } finally {
      setSigningId(null);
      reload();
    }
  };

  const signedInName = (session: OidcSession | null): string =>
    session?.claims?.preferred_username ??
    session?.claims?.name ??
    session?.claims?.email ??
    session?.claims?.sub ??
    '';

  return (
    <div className="flex h-dvh bg-background overflow-hidden">
      <div className="flex-1 flex flex-col h-full min-w-0">
        {/* Header — mirrors the settings/calendar header layout */}
        <div className="flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)_+_0.5rem)] pr-[calc(env(safe-area-inset-right,0px)_+_1rem)] border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="p-2.5 min-w-11 min-h-11 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors sm:min-w-min sm:min-h-min sm:p-1.5"
              title="Back to settings"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-medium text-foreground">Sync servers</span>
          </div>
          <div className="flex items-center gap-2">
            <SyncNotifications />
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-2.5 min-h-11 whitespace-nowrap rounded text-xs font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors sm:py-1 sm:min-h-0"
              title="Close both pages"
            >
              <X size={12} />
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
            <p className="text-xs text-muted-foreground">
              Every configured server syncs independently — its own settings, sign-in and sync
              schedule. A note syncs to <em>all</em> servers whose scope admits it.
            </p>

            {/* Server list */}
            {servers.length === 0 && (
              <div className="rounded-md border px-3 py-4 text-center space-y-1" data-testid="servers-empty">
                <Server size={20} className="mx-auto text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No sync servers configured</p>
                <p className="text-xs text-muted-foreground">
                  Add your first sync server below — notes then sync with it in both directions.
                </p>
              </div>
            )}

            <ul className="space-y-3" data-testid="servers-list">
              {servers.map((server) => {
                const serverSettings = settings[server.id];
                const session = sessions[server.id];
                const lastSync = serverSettings.lastSync;
                return (
                  <li
                    key={server.id}
                    className="rounded-md border px-3 py-3 space-y-2.5"
                    data-testid={`server-row-${server.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {renamingId === server.id ? (
                          <form
                            className="flex items-center gap-1.5"
                            onSubmit={(e) => {
                              e.preventDefault();
                              renameServer(server.id, renameValue);
                              setRenamingId(null);
                              reload();
                            }}
                          >
                            <Input
                              autoFocus
                              className="h-7 max-w-56"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              aria-label="Server name"
                            />
                            <button
                              type="submit"
                              className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground"
                              title="Save name"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground"
                              title="Cancel"
                              onClick={() => setRenamingId(null)}
                            >
                              <X size={14} />
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="group flex items-center gap-1.5 min-w-0"
                            title="Rename server"
                            onClick={() => {
                              setRenamingId(server.id);
                              setRenameValue(server.label ?? '');
                            }}
                          >
                            <span className="text-sm font-medium text-foreground truncate" data-testid={`server-label-${server.id}`}>
                              {server.label ?? server.id}
                            </span>
                            <Pencil size={11} className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                          </button>
                        )}
                        <p className="text-xs text-muted-foreground truncate">{server.id}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void handleSyncOne(server.id)}
                          disabled={syncingId !== null}
                          data-testid={`server-sync-${server.id}`}
                        >
                          {syncingId === server.id ? (
                            <Loader2 size={14} className="animate-spin mr-1.5" />
                          ) : (
                            <>
                              <ArrowUpFromLine size={14} className="mr-1" />
                              <ArrowDownToLine size={14} className="-ml-1" />
                            </>
                          )}
                          Sync now
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpenServerSettings(server.id)}
                          data-testid={`server-settings-${server.id}`}
                        >
                          <SettingsIcon size={14} className="mr-1.5" />
                          Settings
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {/* Signed-in identity (per-server OIDC) */}
                      {session ? (
                        <span className="text-foreground" data-testid={`server-identity-${server.id}`}>
                          Signed in: {signedInName(session) || 'account'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="underline hover:text-foreground"
                          onClick={() => void handleSignIn(server.id)}
                          disabled={signingId === server.id}
                          data-testid={`server-sign-in-${server.id}`}
                        >
                          {signingId === server.id ? 'Signing in…' : 'Sign in'}
                        </button>
                      )}
                      {session && (
                        <button
                          type="button"
                          className="underline hover:text-foreground"
                          onClick={() => void handleSignOut(server.id)}
                          data-testid={`server-sign-out-${server.id}`}
                        >
                          Sign out
                        </button>
                      )}
                      {/* Last sync outcome */}
                      <span data-testid={`server-last-sync-${server.id}`}>
                        {lastSync
                          ? `${lastSync.ok ? '✓' : '⚠'} ${new Date(lastSync.at).toLocaleString()} — ${lastSync.summary}`
                          : 'Never synced'}
                      </span>
                      {!lastSync?.ok && <TriangleAlert size={12} className="text-amber-600" aria-hidden="true" />}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => void handleTestOne(server.id)}
                        disabled={testingId === server.id}
                        data-testid={`server-test-${server.id}`}
                      >
                        {testingId === server.id ? (
                          <Loader2 size={12} className="animate-spin mr-1.5" />
                        ) : (
                          <Cloud size={12} className="mr-1.5" />
                        )}
                        Test connection
                      </Button>
                      {confirmRemoveId === server.id ? (
                        <span className="flex items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground">Remove this server and its sync data?</span>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="h-7"
                            onClick={() => {
                              removeServer(server.id);
                              setConfirmRemoveId(null);
                              reload();
                              toast.success('Server removed');
                            }}
                            data-testid={`server-remove-confirm-${server.id}`}
                          >
                            <Trash2 size={12} className="mr-1" />
                            Remove
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={() => setConfirmRemoveId(null)}
                            data-testid={`server-remove-cancel-${server.id}`}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => setConfirmRemoveId(server.id)}
                          data-testid={`server-remove-${server.id}`}
                        >
                          <Trash2 size={12} className="mr-1" />
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Add server */}
            <section className="rounded-md border px-3 py-3 space-y-3">
              <div className="flex items-center gap-2">
                <Plus size={14} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Add a server</h2>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="add-server-url">Server URL</Label>
                  <Input
                    id="add-server-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://sync.example.com"
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="add-server-url"
                  />
                </div>
                <Button type="button" onClick={handleAdd} disabled={adding} data-testid="add-server-button">
                  {adding ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Plus size={14} className="mr-1.5" />}
                  Add server
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-server-label">Label (optional)</Label>
                <Input
                  id="add-server-label"
                  placeholder="Work server"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  autoComplete="off"
                  data-testid="add-server-label"
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}