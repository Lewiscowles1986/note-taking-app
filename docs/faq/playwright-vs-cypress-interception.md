# FAQ: oh so playwright has interception a bit like how cypress can have the same

> **Question:** oh so playwright has interception a bit like how cypress can have the same

**Answer:**

Exactly — same idea, slightly different mechanics.

- **Cypress** `cy.intercept()` and **Playwright** `page.route()` both sit at the network layer, so they capture real browser requests (`fetch` and XHR) rather than stubbing app-level functions. That's why the e2e tests exercise the app's genuine fetch stack — which is how the CORS/preflight bug surfaced — instead of a hand-rolled fake like the vitest `makeFetch` stub.

Differences worth knowing:

| | Playwright `page.route()` | Cypress `cy.intercept()` |
|---|---|---|
| Where it runs | External driver (CDP) intercepting the browser's network stack | Inside the app's own browser via its proxy layer |
| Static fixtures | Handlers in code, or `routeFromHAR()` for record/replay | `cy.intercept(url, { fixture: 'x.json' })` |
| Scope | Per page/context, can also intercept document/asset requests | App-origin requests while the test runs |

One caveat that matters for *this* repo: Playwright's interception has historically had gaps around requests **initiated by a service worker** — and Note Haven is a PWA with a registered SW. It didn't bite us because the sync calls come from the page (window `fetch`), not the worker; the SW only caches shell/assets. But it's worth remembering if we ever assert on SW-issued fetches — that's also why the offline PWA spec does a "warm reload" pass instead of relying on interception.