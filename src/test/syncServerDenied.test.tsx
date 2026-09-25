/**
 * Server-denied categories in the settings UI (FIX: block only ADDING).
 *
 * A server-denied category may already sit in syncedCategories (allow-listed
 * before the admin denied it). The checkbox stays ENABLED so removal always
 * works; the onCheckedChange guard refuses only the ADD direction. A disabled
 * checkbox could never fire the removal — that is exactly the bug this pins.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/pages/SettingsPage';
import { saveSyncSettings, loadSyncSettings } from '@/lib/syncSettings';
import { db } from '@/lib/db';

beforeAll(() => {
  // SettingsPage links to the docs pinned at the deployed ref — the vite
  // define does not exist in vitest, so stub the global.
  (globalThis as Record<string, unknown>).__DEPLOYED_REF__ = 'test-ref';
});

const NOW = new Date();

async function seedCategoryNote(): Promise<void> {
  await db.notes.add({
    title: 'Seeded',
    content: 'body',
    tags: [],
    category: 'Private',
    attachments: [],
    createdAt: NOW,
    updatedAt: NOW,
    editDates: ['2026-01-01'],
    pinned: false,
    encrypted: null,
    hasCodeBlocks: false,
    hasMermaid: false,
    hasGeoJson: false,
    hasModel3D: false,
  } as never);
}

/** Discovery stub: the server denies the "Private" category. */
function stubDiscovery(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/.well-known/')) {
        return new Response(
          JSON.stringify({ notes: { excluded_categories: ['Private'], excluded_uids: [] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
}

async function openScopePicker(): Promise<HTMLButtonElement> {
  render(<SettingsPage onBack={() => undefined} />);
  fireEvent.click(screen.getByTestId('sync-scope-categories'));
  return waitFor(() => {
    const el = screen.getByTestId('sync-scope-cat-Private') as HTMLButtonElement;
    expect(el).toBeTruthy();
    return el;
  });
}

beforeEach(async () => {
  localStorage.clear();
  await db.delete();
  await db.open();
  await seedCategoryNote();
  stubDiscovery();
});

describe('SettingsPage — server-denied categories (add blocked, removal free)', () => {
  it('server-denied + pre-checked → uncheck REMOVES it from syncedCategories (in-page state + save)', async () => {
    saveSyncSettings({
      ...loadSyncSettings(),
      serverUrl: 'https://sync.test',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      syncScope: 'categories',
      syncedCategories: ['Private'], // pre-existing allow-list entry
    });
    const checkbox = await openScopePicker();
    expect(checkbox.dataset.state).toBe('checked');

    // The stale entry can always be removed.
    fireEvent.click(checkbox);
    await waitFor(() => {
      const el = screen.getByTestId('sync-scope-cat-Private') as HTMLButtonElement;
      expect(el.dataset.state).not.toBe('checked');
    });

    // The removal survives a Save (persisted to localStorage).
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(loadSyncSettings().syncedCategories).toEqual([]);
    });
  });

  it('server-denied + unchecked → checking is a NO-OP (cannot add)', async () => {
    saveSyncSettings({
      ...loadSyncSettings(),
      serverUrl: 'https://sync.test',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      syncScope: 'categories',
      syncedCategories: [],
    });
    const checkbox = await openScopePicker();
    expect(checkbox.dataset.state).not.toBe('checked');

    fireEvent.click(checkbox);
    const el = screen.getByTestId('sync-scope-cat-Private') as HTMLButtonElement;
    expect(el.dataset.state).not.toBe('checked');

    // The denial marker is shown next to the category.
    expect(screen.getByTestId('sync-server-denied-Private')).toBeTruthy();
  });

  it('non-denied categories still check and uncheck normally (guard is scoped to the denied set)', async () => {
    await db.notes.add({
      title: 'Other',
      content: 'y',
      tags: [],
      category: 'Work',
      attachments: [],
      createdAt: NOW,
      updatedAt: NOW,
      editDates: ['2026-01-01'],
      pinned: false,
      encrypted: null,
      hasCodeBlocks: false,
      hasMermaid: false,
      hasGeoJson: false,
      hasModel3D: false,
    } as never);
    saveSyncSettings({
      ...loadSyncSettings(),
      serverUrl: 'https://sync.test',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      syncScope: 'categories',
      syncedCategories: [],
    });
    await openScopePicker();
    const work = screen.getByTestId('sync-scope-cat-Work') as HTMLButtonElement;
    fireEvent.click(work);
    expect((screen.getByTestId('sync-scope-cat-Work') as HTMLButtonElement).dataset.state).toBe('checked');
    fireEvent.click(screen.getByTestId('sync-scope-cat-Work'));
    expect((screen.getByTestId('sync-scope-cat-Work') as HTMLButtonElement).dataset.state).not.toBe('checked');
  });
});