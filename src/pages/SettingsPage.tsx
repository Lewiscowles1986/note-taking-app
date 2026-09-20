import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarClock,
  Check,
  ChevronLeft,
  Cloud,
  Loader2,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  loadSyncSettings,
  saveSyncSettings,
  clearSyncSettings,
  type StoredSyncSettings,
} from '@/lib/syncSettings';
import {
  runSync,
  runSyncIfConfigured,
  SyncError,
} from '@/lib/sync';
import { runInFlight } from '@/lib/inFlight';
import { toast } from 'sonner';

interface SettingsPageProps {
  onBack: () => void;
  /** Fires after a successful sync so the caller can refresh its note list. */
  onSynced?: () => void;
}

/**
 * Full-screen sync settings page (same layout pattern as the calendar view).
 *
 * Server connection: base URL + optional bearer token + auto-sync cadence.
 * "Sync now" runs the two-way merge through the global in-flight registry so
 * it shows in the indicator, is cancellable, and conflicts with concurrent
 * syncs instead of racing them.
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

  const dirty =
    serverUrl !== stored.serverUrl ||
    authToken !== stored.authToken ||
    autoSync !== stored.autoSync ||
    intervalInput !== String(stored.intervalMinutes);

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
      lastSync: stored.lastSync,
    }),
    [serverUrl, authToken, autoSync, parsedInterval, stored.intervalMinutes, stored.lastSync],
  );

  /** Persist current fields (also used before a sync so the engine sees them). */
  const persist = (extra?: Partial<StoredSyncSettings>) => {
    const next = { ...currentConfig, ...extra };
    saveSyncSettings(next);
    setStored(next);
  };

  const save = () => {
    persist();
    toast.success('Sync settings saved');
  };

  const handleSync = async () => {
    // Unsaved field edits apply before the run — otherwise the engine would
    // sync against a stale configuration.
    persist();
    setSyncing(true);
    try {
      const result = await runInFlight(
        { label: 'Syncing with server', group: 'sync' },
        async () => runSync(),
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
      const headers: Record<string, string> = {};
      if (currentConfig.authToken) headers.Authorization = `Bearer ${currentConfig.authToken}`;
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
    setStored(loadSyncSettings());
    setServerUrl('');
    setAuthToken('');
    setAutoSync(false);
    setIntervalInput('15');
    toast.success('Server connection forgotten');
  };

  // Background auto-sync: a single interval while the page is mounted and a
  // server is configured. runSyncIfConfigured never throws.
  useEffect(() => {
    if (!autoSync || !currentConfig.serverUrl || parsedInterval == null) return;
    const ms = parsedInterval * 60_000;
    const timer = window.setInterval(() => {
      void runSyncIfConfigured();
    }, ms);
    return () => window.clearInterval(timer);
  }, [autoSync, currentConfig.serverUrl, parsedInterval]);

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

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
            {/* Connection */}
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">Sync server</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                Notes sync with a REST JSON server over{' '}
                <code className="bg-muted px-1 rounded">/api/notes</code> — see{' '}
                <a
                  href="https://github.com/lewiscowles/note-taking-app/blob/main/docs/sync.md"
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

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={handleTest} disabled={testing}>
                  {testing ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Cloud size={14} className="mr-1.5" />}
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

            {/* Sync now + status */}
            <section className="space-y-3 border-t pt-6">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Two-way sync</h3>
                  <p className="text-xs text-muted-foreground">
                    Merges per note — the newest edit (server or device) wins; deletions propagate
                    both ways.
                  </p>
                </div>
                <Button type="button" size="sm" onClick={handleSync} disabled={syncing}>
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
                <li>The access token is stored locally and sent only to the server above.</li>
                <li>Deleting a note on this device also deletes it on the server at the next sync.</li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}