import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

// og:image / twitter:image need scheme+host for social scrapers. The Pages
// deploy workflow supplies the site's absolute base URL (PAGES_ASSET_BASE_URL,
// from actions/configure-pages); anywhere else __ASSET_BASE_URL__ collapses to
// an empty string, leaving a page-relative "social-preview.png" reference.
const pagesBase = process.env.PAGES_ASSET_BASE_URL?.replace(/\/+$/, "");
const assetBaseUrl = pagesBase ? `${pagesBase}/` : "";

// Preview builds set VITE_PREVIEW=true (see .github/workflows/github-pages.yml).
// Used to tailor the service worker's navigation-fallback rules per build type.
const previewBuild = process.env.VITE_PREVIEW === "true";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  // Default to "/" for local dev; the Pages deploy workflow overrides this
  // with the repo subpath (e.g. /note-taking-app/) so assets resolve correctly.
  base: process.env.GITHUB_PAGES_BASE || "/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
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
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));
