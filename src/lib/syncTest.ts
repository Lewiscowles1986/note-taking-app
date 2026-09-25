/**
 * "Test connection" — one shared implementation for the settings page and the
 * servers page. Probes a server's notes manifest with the SAME resolution the
 * sync engine uses (that server's OIDC session token when signed in, else its
 * manual bearer token) and reports the outcome as a toast. Never throws.
 *
 * Dynamically imported by both pages so it stays out of the eager chunk.
 */

import { getServerSettings } from './syncServers';
import { resolveAuthToken } from './authToken';
import { toast } from 'sonner';

/**
 * Probe `{server}/api/notes` for one server and toast the manifest count
 * (or the failure). The toast texts are asserted by the e2e suite — change
 * them together.
 */
export async function testConnection(serverId: string): Promise<void> {
  const settings = getServerSettings(serverId);
  const base = settings.serverUrl;
  if (!base) {
    toast.error('Enter a server URL first');
    return;
  }
  try {
    // Same resolution as the sync engine: that server's OIDC session token
    // when signed in, else its manual bearer token.
    const token = await resolveAuthToken(serverId, settings.authToken);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${base}/api/notes`, { method: 'GET', headers });
    if (!response.ok) {
      toast.error(`Server responded ${response.status}`);
      return;
    }
    const text = await response.text();
    let notes: unknown = null;
    try {
      notes = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      toast.error('Server responded with invalid JSON');
      return;
    }
    const list = Array.isArray(notes) ? notes : ((notes as { notes?: unknown })?.notes as unknown[] | undefined);
    if (!Array.isArray(list)) {
      toast.error('Reached the server, but the response is not a notes manifest');
      return;
    }
    toast.success(`Connection OK — ${list.length} note${list.length !== 1 ? 's' : ''} on server`);
  } catch {
    toast.error('Could not reach the server');
  }
}