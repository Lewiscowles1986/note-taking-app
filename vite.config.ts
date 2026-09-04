import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// og:image / twitter:image need scheme+host for social scrapers. The Pages
// deploy workflow supplies the site's absolute base URL (PAGES_ASSET_BASE_URL,
// from actions/configure-pages); anywhere else __ASSET_BASE_URL__ collapses to
// an empty string, leaving a page-relative "social-preview.png" reference.
const pagesBase = process.env.PAGES_ASSET_BASE_URL?.replace(/\/+$/, "");
const assetBaseUrl = pagesBase ? `${pagesBase}/` : "";

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
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));
