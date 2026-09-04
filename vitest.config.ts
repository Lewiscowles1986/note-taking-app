import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Keep test output readable: silence console noise that is either an
    // intentional error-path under test or environment-inherent, not a
    // regression signal. Assertions on behaviour are unaffected.
    onConsoleLog(log) {
      return !(
        log.includes("Error loading or parsing 3D model") || // Model3DBlock error-branch tests (fetch fails on attachment:/unknown scheme in jsdom)
        log.includes("unknown scheme") || // the `cause` stack of the above
        log.includes("React Router Future Flag Warning") || // v7 opt-in hints from every router instance
        log.includes("Not implemented: navigation") || // jsdom cannot follow downloads/navigation
        log.includes("was not wrapped in act(") // Model3DBlock resolves loads async; state lands after the test
      );
    },
    // `npm run test:coverage` — V8 provider, no instrumentation build step.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "**/*.d.ts",
        // shadcn/radix plumbing that is covered by the component libraries
        "src/components/ui/**",
      ],
      // json-summary feeds scripts/test-quality-report.mjs (PR visualisation)
      reporter: ["text", "html", "lcov", "json-summary"],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
