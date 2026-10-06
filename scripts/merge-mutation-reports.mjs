#!/usr/bin/env node
/**
 * merge-mutation-reports.mjs — combine the per-shard Stryker reports produced by
 * the matrix in .github/workflows/test-quality.yml into a single report.
 *
 * Background: `npx stryker run --mutate <subset>` writes a *complete, valid*
 * report for just that subset — the initial dry run still exercises the whole
 * test suite, so coverage analysis and per-test mapping stay correct. Shards
 * mutate disjoint files, so merging is a union of `files`; every other field
 * (thresholds, testFiles, projectRoot, schemaVersion, …) is identical per shard.
 *
 * Usage:
 *   node scripts/merge-mutation-reports.mjs <outDir> <shardJson>...
 *
 * Writes:
 *   <outDir>/mutation.json — merged, consumed by scripts/test-quality-report.mjs
 *   <outDir>/mutation.html — self-contained browser report, mirroring Stryker's
 *                            own html reporter (the shard HTML files are partial)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const [outDir, ...shardFiles] = process.argv.slice(2);
if (!outDir || shardFiles.length === 0) {
  console.error("usage: merge-mutation-reports.mjs <outDir> <shardJson>...");
  process.exit(2);
}

const shards = shardFiles.map((file) => ({ file, report: JSON.parse(readFileSync(file, "utf8")) }));

const merged = { ...shards[0].report };
merged.files = {};
for (const { report } of shards) {
  for (const [path, entry] of Object.entries(report.files ?? {})) {
    if (merged.files[path]) {
      // Shards are meant to be disjoint; if that ever breaks, keep every mutant
      // rather than silently dropping one shard's results.
      merged.files[path] = { ...merged.files[path], mutants: [...merged.files[path].mutants, ...entry.mutants] };
    } else {
      merged.files[path] = entry;
    }
  }
}
// Each shard only records its own subset; state the full mutated set instead.
if (merged.config) merged.config.mutate = Object.keys(merged.files).sort();

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "mutation.json"), JSON.stringify(merged));
writeFileSync(join(outDir, "mutation.html"), renderHtml(merged));

const total = Object.values(merged.files).reduce((n, f) => n + (f.mutants?.length ?? 0), 0);
console.log(
  `Merged ${shards.length} shard report(s): ${Object.keys(merged.files).length} files, ${total} mutants → ${outDir}`,
);

/**
 * Mirrors @stryker-mutator/core's HtmlReporter: inline the mutation-testing-elements
 * bundle, then assign the report. `<` is escaped (into `<"+">`) exactly as Stryker
 * does so report content can never close the surrounding script tag.
 */
function renderHtml(report) {
  const require = createRequire(import.meta.url);
  const elements = readFileSync(
    require.resolve("mutation-testing-elements/dist/mutation-test-elements.js"),
    "utf8",
  );
  const json = JSON.stringify(report).replace(/</g, '<"+"');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script>
${elements}
</script>
</head>
<body>
<mutation-test-report-app titlePostfix="Stryker">
Your browser doesn't support <a href="https://caniuse.com/#search=custom%20elements">custom elements</a>.
Please use a latest version of an evergreen browser (Firefox, Chrome, Safari, Opera, Edge, etc).
</mutation-test-report-app>
<script>
const app = document.querySelector('mutation-test-report-app');
app.report = ${json};
function updateTheme() {
  document.body.style.backgroundColor = app.themeBackgroundColor;
}
app.addEventListener('theme-changed', updateTheme);
updateTheme();
</script>
</body>
</html>`;
}
