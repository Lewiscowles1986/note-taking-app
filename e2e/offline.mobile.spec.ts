import { test, expect, seedNotes, APP_PATH, type NoteSeed } from './fixtures';

/**
 * PWA / service-worker offline smoke, run against the PRODUCTION build.
 *
 * The service worker is only generated/registered at build time (vite-plugin-pwa
 * has no devOptions.enabled), so this suite must point at `vite preview` of
 * `dist`, not the dev server. Run it via:
 *
 *   npm run test:e2e:pwa
 *
 * which builds the app, boots `vite preview`, and runs this file in attach mode
 * with E2E_PWA=1. Without E2E_PWA the file is skipped so the default dev-server
 * suites don't try (and fail) to exercise a non-existent service worker.
 */
test.use({ viewport: { width: 390, height: 844 } });

test.skip(!process.env.E2E_PWA, 'PWA/offline spec requires E2E_PWA=1 against vite preview');

function makeNote(overrides: Partial<NoteSeed> = {}): NoteSeed {
  const now = new Date();
  return {
    title: 'Untitled',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: ['2024-01-01'],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

test('service worker caches the shell and the note loads while offline', async ({
  page,
  context,
}) => {
  const t = new Date();
  await seedNotes(page, [makeNote({ title: 'Offline note', content: 'cached locally', updatedAt: t })]);
  await page.goto(APP_PATH);

  // Register the service worker and let it take control of the page once.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
  }
  await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
  });
  await expect(page.getByText('Offline note', { exact: true })).toBeVisible();

  // Now drop the network and reload — the SW must serve the shell from cache
  // and IndexedDB must still contain the note (local-first, no network).
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Offline note', { exact: true })).toBeVisible();
});
