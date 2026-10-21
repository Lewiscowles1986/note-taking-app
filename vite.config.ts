import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { readdirSync, rmSync } from "node:fs";
import { parseSync, printSync } from "@swc/core";
import { parseLanguages, isEnabled } from "./src/lib/languageList";

// og:image / twitter:image need scheme+host for social scrapers. The Pages
// deploy workflow supplies the site's absolute base URL (PAGES_ASSET_BASE_URL,
// from actions/configure-pages); anywhere else __ASSET_BASE_URL__ collapses to
// an empty string, leaving a page-relative "social-preview.png" reference.
const pagesBase = process.env.PAGES_ASSET_BASE_URL?.replace(/\/+$/, "");
const assetBaseUrl = pagesBase ? `${pagesBase}/` : "";

// Preview builds set VITE_PREVIEW=true (see .github/workflows/github-pages.yml).
// Used to tailor the service worker's navigation-fallback rules per build type.
const previewBuild = process.env.VITE_PREVIEW === "true";

// Pin documentation links to the exact deployed revision so the docs a user
// reads always describe the software they are running. The Pages workflow
// supplies the ref: a tag name when the deploy is a release, otherwise the
// commit SHA (both work as GitHub URLs). Unset (local dev) → fall back to
// "main", which tracks the moving branch rather than the built code.
const deployedRef = process.env.VITE_DEPLOYED_REF || "main";

// VITE_NO_SYNC=1 swaps the sync/OIDC modules for dependency-free stubs
// (src/build-stubs/*) so a build can prove how many bytes the sync feature
// costs. Production never sets it. The alias keys match EXACTLY (plus
// subpaths) what consumers import; order matters — stub keys must come
// before the bare "@" catch-all so they win.
const noSyncBuild = process.env.VITE_NO_SYNC === "1";
const NO_SYNC_ALIASES: Record<string, string> = {
  "@/lib/sync": path.resolve(__dirname, "./src/build-stubs/sync.ts"),
  "@/lib/syncDeletion": path.resolve(__dirname, "./src/build-stubs/syncDeletion.ts"),
  "@/lib/syncNotifications": path.resolve(__dirname, "./src/build-stubs/syncNotifications.ts"),
  "@/lib/authToken": path.resolve(__dirname, "./src/build-stubs/authToken.ts"),
  "@/lib/oidcAuth": path.resolve(__dirname, "./src/build-stubs/oidcAuth.ts"),
};

// Without a PostHog project key the analytics module is aliased to a no-op
// stub, so the (lazy-loaded) posthog-js SDK is not part of the build at all.
// A build WITH a key but no host keeps the real module: posthogSdk.ts falls
// back to the EU host (https://eu.i.posthog.com). The alias must come before
// the bare "@" catch-all so it wins.
const ANALYTICS_STUB_ALIASES: Record<string, string> = {
  "@/lib/posthog": path.resolve(__dirname, "./src/build-stubs/posthog.ts"),
};

// In a keyless build, also COMPILE AWAY the analytics call sites (instead of
// leaving calls into the stub): drop the statement, drop the bytes — and
// tree-shaking then removes the now-unused helpers/imports. Runs pre-transform
// so esbuild/SWC never see the target statements. Matched shapes:
//   - expression-statement calls of: posthogCapture, posthogLogger.info/
//     warn/error, posthog.identify, posthog.reset, identifyOidcUser,
//     resetOidcUser (the last two: their only content is analytics)
//   - `oidcDistinctIdApplied = ...` assignments (state with no consumer left)
//   - if-statements whose whole consequent is one of those calls
//   - `|| !posthog.has_identity()` operands in if-tests (stub yields false,
//     so the shortened guard behaves identically in keyless builds)
// Only statements whose top-level callee matches are removed; code is cut at
// exact SWC spans, so nothing heuristic is deleted.
const ANALYTICS_CALLEES = new Set([
  "posthogCapture",
  "posthogLogger.info",
  "posthogLogger.warn",
  "posthogLogger.error",
  "posthog.identify",
  "posthog.reset",
  "identifyOidcUser",
  "resetOidcUser",
]);

const ANALYTICS_MODULES = ["@/lib/posthog", "@/lib/posthogLogs"];

const dropAnalyticsCalls: Plugin = {
  name: "drop-analytics-calls",
  enforce: "pre",
  transform(code: string, id: string) {
    if (!/\.[jt]sx?$/.test(id) || id.includes("node_modules")) return null;
    if (ANALYTICS_MODULES.some((m) => id.includes(m.slice(2)))) return null;
    if (!code.includes("@/lib/posthog") && !/posthogCapture|posthogLogger|identifyOidcUser|resetOidcUser|oidcDistinctIdApplied/.test(code))
      return null;

    let mod;
    try {
      mod = parseSync(code, {
        syntax: "typescript",
        tsx: /\.(tsx|jsx)$/.test(id),
        target: "es2022",
      });
    } catch {
      return null; // let the normal pipeline surface parse errors
    }

    const calleeName = (c: any): string | null => {
      if (!c) return null;
      if (c.type === "Identifier") return c.value;
      if (c.type === "MemberExpression") {
        const obj = c.object as any;
        const base =
          obj?.type === "Identifier" ? obj.value : (obj?.property?.value as string) ?? null;
        return base ? `${base}.${c.property.value}` : null;
      }
      return null;
    };
    const isTargetCall = (e: any): boolean =>
      !!e &&
      e.type === "CallExpression" &&
      ANALYTICS_CALLEES.has(calleeName(e.callee) ?? "");
    const isTargetStmt = (st: any): boolean => {
      if (!st) return false;
      if (st.type === "ExpressionStatement")
        return isTargetCall(st.expression)
          || (st.expression.type === "AssignmentExpression"
            && calleeName(st.expression.left) === "oidcDistinctIdApplied");
      // if (<test>) <analytics-only call>;
      if (st.type === "IfStatement" && !st.alternate)
        return isTargetStmt(st.consequent);
      return false;
    };
    // Remove target statements from every statement-bearing node, wherever it
    // is nested (closures, callbacks, try/catch, branches). The AST is
    // acyclic; spans are irrelevant because we PRINT the modified tree rather
    // than slicing bytes.
    let touched = false;
    const descend = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        n.forEach(descend);
        return;
      }
      // swc wraps some values in typeless parents (e.g. ExprOrSpread around
      // call arguments): they must be traversed, not skipped, or closures
      // behind wrapper nodes (promise .then/.finally callbacks) are missed.
      const holder = Array.isArray(n.stmts) && (n.type === "BlockStatement" || n.type === "FunctionBody")
        ? "stmts"
        : (n.body && Array.isArray(n.body.stmts) && (n.body.type === "BlockStatement" || n.body.type === "FunctionBody")
          ? "body"
          : null);
      if (holder === "stmts") {
        const kept = (n.stmts as any[]).filter((st) => {
          if (isTargetStmt(st)) { touched = true; return false; }
          return true;
        });
        n.stmts = kept;
      } else if (holder === "body") {
        if (isTargetStmt(n.body) && n.body.type === "ExpressionStatement") {
          touched = true;
          delete n.body; // arrow with analytics-only body -> empty body; TS prints "=> {}"? swc needs a body; replace below
          n.body = { type: "BlockStatement", span: n.span ?? { start: 0, end: 0, ctxt: 0 }, stmts: [] };
        } else {
          descend(n.body);
        }
      }
      for (const k of Object.keys(n)) {
        const v = (n as any)[k];
        if (v && typeof v === "object") descend(v);
      }
    };
    for (const item of mod.body) descend(item);
    // If-statement forms wrap a call directly; the descend pass already
    // filters consequents via isTargetStmt on BlockStatement bodies and the
    // n.body branch above. Nested if-consequent calls (non-block) are rare;
    // handle by a second look: for IfStatement with an ExpressionStatement
    // consequent whose expression is a target call, drop the if node.
    const pruneIfs = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(pruneIfs); return; }
      // descend even through typeless wrapper objects (see descend above)
      if (Array.isArray(n.stmts) && (n.type === "BlockStatement" || n.type === "FunctionBody")) {
        const kept = (n.stmts as any[]).filter((st) => {
          if (st.type !== "IfStatement") return true;
          const c = st.consequent;
          const isDirect =
            c.type === "ExpressionStatement" && isTargetCall(c.expression);
          const isAssign =
            c.type === "ExpressionStatement" &&
            c.expression.type === "AssignmentExpression" &&
            calleeName(c.expression.left) === "oidcDistinctIdApplied";
          if (isDirect || isAssign) { touched = true; return false; }
          return true;
        });
        n.stmts = kept;
      }
      if (n.body && typeof n.body === "object") pruneIfs(n.body);
      for (const k of Object.keys(n)) {
        const v = (n as any)[k];
        if (v && typeof v === "object") pruneIfs(v);
      }
    };
    for (const item of mod.body) pruneIfs(item);
    // The `|| !posthog.has_identity()` guard: stub has_identity is false, the
    // reset inside is removed above, so drop the operand via exact text.
    const out = printSync(mod).code;
    const finalCode = out.replace(" || !posthog.has_identity()", "");
    if (!touched && finalCode === out) return null;
    return { code: finalCode, map: null };
  },
};

// Leaves a disabled language's wasm out of the built site: a language that is
// not enabled should not ship its payload, not merely leave it unloaded. Runs
// after Vite has copied public/ into dist/, so the source tree is never touched.
function excludeDisabledLanguages(enabled: string[]) {
  let outDir = "dist";
  return {
    name: "exclude-disabled-languages",
    apply: "build" as const,
    configResolved(config: { build: { outDir: string } }) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dist = path.resolve(__dirname, outDir);
      for (const entry of readdirSync(dist)) {
        const match = /^([a-z]+)-wasm$/.exec(entry);
        if (match && !isEnabled(enabled, match[1])) {
          rmSync(path.join(dist, entry), { recursive: true, force: true });
        }
      }
    },
  };
}

const enabledLanguages = parseLanguages(process.env.VITE_LANGUAGES);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Vite loads .env files for the app build but NOT into the config's
  // process.env, so resolve analytics inclusion via loadEnv (mode-aware,
  // same precedence as the app's own import.meta.env).
  const { VITE_POSTHOG_KEY } = loadEnv(mode, __dirname, "");
  const analyticsEnabled = Boolean(VITE_POSTHOG_KEY);
  return ({
  // Default to "/" for local dev; the Pages deploy workflow overrides this
  // with the repo subpath (e.g. /note-taking-app/) so assets resolve correctly.
  base: process.env.GITHUB_PAGES_BASE || "/",
  define: {
    __DEPLOYED_REF__: JSON.stringify(deployedRef),
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    ...(analyticsEnabled ? [] : [dropAnalyticsCalls]),
    excludeDisabledLanguages(enabledLanguages),
    {
      name: "compose-social-preview-url",
      transformIndexHtml: (html) => html.replaceAll("__ASSET_BASE_URL__", assetBaseUrl),
    },
    VitePWA({
      // The service worker precaches the hashed build output and re-registers
      // silently: a new deploy activates on the user's next load.
      registerType: "autoUpdate",
      workbox: {
        // SPA: serve the app shell for client-side routes...
        navigateFallback: "index.html",
        // ...but NEVER for the per-PR previews. Previews are published next to
        // the app under /preview-builds/<branch>/ and the service worker's scope
        // (/note-taking-app/) covers them too; without this denylist it would
        // smuggle in the main app's index.html and its own 404 route, masking
        // the real preview. This exclusion applies only to the real build — a
        // preview's OWN worker still needs SPA fallback within its own scope.
        navigateFallbackDenylist: previewBuild
          ? [/[^/]+\.[^/]+$/]
          : [/preview-builds\//, /[^/]+\.[^/]+$/],
        // No wasm runtime is precached. The matrices span dozens of versions and
        // run to hundreds of MB, so precaching them would stall install and bloat
        // the deploy. They are fetched on demand and cached after first use by the
        // runtime rule below, which also keeps the install small. Raise workbox's
        // per-file cap anyway so the dynamically imported .mjs glue can be cached.
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,mjs,wasm}"],
        // Any language's wasm bundle: a new language needs no edit here.
        globIgnores: ["**/*-wasm/**"],
        // Precaching the wasm matrices is not viable (hundreds of MB, and the
        // install would stall on them). Instead cache a runtime the first time it
        // is actually loaded, so it is instant on later runs and available
        // offline. Each bundle lives at a versioned path, so the bytes never
        // change and CacheFirst is safe. This covers whichever versions a reader
        // touches, not all of them.
        runtimeCaching: [
          {
            urlPattern: /-wasm\//,
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-runtimes-v1",
              // Warming all versions of a language can exceed the default cap,
              // so allow the full matrix per language (plus a little headroom).
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "apple-touch-icon.png",
        "maskable-icon-512x512.png",
        "social-preview.png",
      ],
      manifest: {
        name: "Note Haven",
        short_name: "Note Haven",
        description: "A local-first, privacy-focused Markdown note-taking app.",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#F5F1E8",
        theme_color: "#1E4D4A",
        icons: [
          { src: "android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      // Stub aliases FIRST (no-sync / no-analytics builds): the bare "@"
      // catch-all below would otherwise swallow "@/lib/sync" before the stub
      // match.
      ...(noSyncBuild ? NO_SYNC_ALIASES : {}),
      ...(analyticsEnabled ? {} : ANALYTICS_STUB_ALIASES),
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  });
});
