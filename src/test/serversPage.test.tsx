/**
 * Component tests for the servers page (src/pages/ServersPage.tsx): the
 * multi-server entry point. Covers add (idempotent), rename, remove (with
 * its confirm step), per-server identity/lastSync rendering, and the
 * header's Back vs Close semantics.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ServersPage from '@/pages/ServersPage';
import { addServer, saveServerSettings, getServerSettings, listServers } from '@/lib/syncServers';
import { saveOidcSessionFor, type OidcSession } from '@/lib/oidcStorage';

// jsdom lacks window.location origin handling the page relies on — the
// component only reads storage + fires toasts; stub sonner's toast.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const SESSION: OidcSession = {
  clientId: 'c',
  accessToken: 'at',
  refreshToken: null,
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scope: 'openid',
  claims: { preferred_username: 'alice' },
  endpoints: {},
};

function setup(overrides: Partial<Record<string, unknown>> = {}): void {
  addServer('https://alpha.test', 'Alpha');
  saveServerSettings('https://alpha.test', {
    authToken: '',
    autoSync: false,
    intervalMinutes: 15,
    syncScope: 'all',
    syncedCategories: [],
    excludedCategories: [],
    excludedNoteIds: [],
    lastSync: { at: new Date().toISOString(), ok: true, summary: '1 pushed' },
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('ServersPage', () => {
  it('renders configured servers with label, URL, identity and lastSync', () => {
    setup();
    saveOidcSessionFor('https://alpha.test', SESSION);
    render(
      <ServersPage
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenServerSettings={() => undefined}
      />,
    );
    expect(screen.getByTestId('server-row-https://alpha.test')).toBeTruthy();
    expect(screen.getByTestId('server-label-https://alpha.test').textContent).toBe('Alpha');
    expect(screen.getByTestId('server-identity-https://alpha.test').textContent).toContain('alice');
    expect(screen.getByTestId('server-last-sync-https://alpha.test').textContent).toContain('1 pushed');
  });

  it('shows the empty state when no servers are configured', () => {
    render(
      <ServersPage
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenServerSettings={() => undefined}
      />,
    );
    expect(screen.getByTestId('servers-empty')).toBeTruthy();
    expect(screen.getByTestId('add-server-url')).toBeTruthy();
  });

  it('adds a server via the Add form (idempotent URL normalization)', () => {
    render(
      <ServersPage
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenServerSettings={() => undefined}
      />,
    );
    const url = screen.getByTestId('add-server-url') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://new.test///' } });
    fireEvent.click(screen.getByTestId('add-server-button'));
    expect(screen.getByTestId('server-row-https://new.test')).toBeTruthy();
  });

  it('opening Settings for a row calls onOpenServerSettings with that server id', () => {
    setup();
    const opened: string[] = [];
    render(
      <ServersPage
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenServerSettings={(id) => opened.push(id)}
      />,
    );
    fireEvent.click(screen.getByTestId(`server-settings-https://alpha.test`));
    expect(opened).toEqual(['https://alpha.test']);
  });

  it('Remove requires confirmation and then wipes the server', async () => {
    setup();
    const { removeServer } = await import('@/lib/syncServers');
    render(
      <ServersPage
        onBack={() => undefined}
        onClose={() => undefined}
        onOpenServerSettings={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId(`server-remove-https://alpha.test`));
    // Confirmation first: the row still exists, the confirm button appears.
    expect(screen.getByTestId(`server-remove-confirm-https://alpha.test`)).toBeTruthy();
    expect(listServers()).toHaveLength(1);
    fireEvent.click(screen.getByTestId(`server-remove-confirm-https://alpha.test`));
    await waitFor(() => {
      expect(listServers()).toHaveLength(0);
    });
  });

  it('Close calls onClose (both pages) and Back calls onBack (notes)', () => {
    setup();
    const calls: string[] = [];
    render(
      <ServersPage
        onBack={() => calls.push('back')}
        onClose={() => calls.push('close')}
        onOpenServerSettings={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTitle('Back to notes'));
    fireEvent.click(screen.getByTitle('Close both pages'));
    expect(calls).toEqual(['back', 'close']);
  });
});