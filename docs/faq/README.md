# Sync feature — FAQ

Questions raised while designing and reviewing the sync settings feature
(`feat/sync-settings`), with the answers as given at the time.

| File | Question |
|---|---|
| [sync-server-included.md](sync-server-included.md) | so is a server included now? |
| [sync-http-boundary-testing.md](sync-http-boundary-testing.md) | so how are you testing the HTTP boundary? |
| [playwright-vs-cypress-interception.md](playwright-vs-cypress-interception.md) | oh so playwright has interception a bit like how cypress can have the same |

Related reading: [docs/sync.md](../sync.md) (the wire protocol), and the
implementation in `src/lib/sync.ts`, `src/lib/syncSettings.ts`,
`src/pages/SettingsPage.tsx`, `e2e/sync.spec.ts`.