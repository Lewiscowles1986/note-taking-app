#!/usr/bin/env node
/**
 * test-quality-report.mjs — build the coverage + mutation markdown report.
 *
 * Usage:  node scripts/test-quality-report.mjs [output-file]
 *
 * Inputs (both optional; missing files produce a graceful "not available"
 * section instead of failing the workflow):
 *   coverage/coverage-summary.json   — vitest json-summary reporter
 *   reports/mutation/mutation.json   — Stryker json reporter
 *
 * Outputs:
 *   • appends the report to $GITHUB_STEP_SUMMARY when that env var is set
 *   • writes the same markdown to the file given as argv[2] (for the sticky
 *     PR comment in .github/workflows/test-quality.yml)
 *
 * Report-only by design: this script never exits non-zero and never gates a
 * PR — it visualises. Threshold enforcement belongs to the test job itself.
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_FILE = join(ROOT, "coverage", "coverage-summary.json");
const MUTATION_FILE = join(ROOT, "reports", "mutation", "mutation.json");

const OUT_FILE = process.argv[2] || null;
const SUMMARY = process.env.GITHUB_STEP_SUMMARY || null;
const STICKY_MARKER = "<!-- note-haven-test-quality -->";

const fmtPct = (p) => (typeof p === "number" ? `${p.toFixed(2)}%` : "—");

function rel(p) {
  // coverage-summary.json uses absolute paths; mutation.json uses root-relative.
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

/* ---------- coverage ---------- */

function loadCoverage() {
  if (!existsSync(COVERAGE_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(COVERAGE_FILE, "utf8"));
    const perFile = new Map();
    for (const [k, v] of Object.entries(j)) {
      if (k === "total") continue;
      perFile.set(rel(k), v.lines?.pct ?? null);
    }
    return { total: j.total, perFile };
  } catch {
    return null;
  }
}

/* ---------- mutation ---------- */

// Mirrors Stryker's own metric: detected (killed + timeout) over valid
// (killed + timeout + survived + noCoverage + runtimeError; CompileError
// and Ignored are excluded from the denominator).
function scoreFromMutants(mutants) {
  const c = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, RuntimeError: 0, other: 0 };
  for (const m of mutants) {
    if (m.status in c) c[m.status] += 1;
    else c.other += 1;
  }
  const detected = c.Killed + c.Timeout;
  const valid = detected + c.Survived + c.NoCoverage + c.RuntimeError;
  return {
    ...c,
    detected,
    valid,
    total: mutants.length,
    score: valid > 0 ? (detected / valid) * 100 : null,
  };
}

function loadMutation() {
  if (!existsSync(MUTATION_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(MUTATION_FILE, "utf8"));
    const perFile = new Map();
    for (const [path, entry] of Object.entries(j.files || {})) {
      perFile.set(path, { score: scoreFromMutants(entry.mutants || []), mutants: entry.mutants || [] });
    }
    let det = 0, val = 0, tot = 0;
    for (const { score } of perFile.values()) { det += score.detected; val += score.valid; tot += score.total; }
    return { perFile, detected: det, valid: val, total: tot, score: val > 0 ? (det / val) * 100 : null };
  } catch {
    return null;
  }
}

/* ---------- markdown ---------- */

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

function survivorsSection(mutation) {
  const withSurvivors = [...mutation.perFile.entries()]
    .filter(([, { score }]) => score.Survived > 0)
    .sort((a, b) => b[1].score.Survived - a[1].score.Survived)
    .slice(0, 5);
  if (withSurvivors.length === 0) {
    return "No mutants survived — every one was killed by the test suite. 🎉\n";
  }
  let out = "<details>\n<summary><strong>Surviving mutants</strong> (top 5 files — full interactive report in the <code>mutation-report</code> artifact)</summary>\n\n";
  for (const [file, { mutants }] of withSurvivors) {
    const survivors = mutants
      .filter((m) => m.status === "Survived")
      .slice(0, 5);
    out += `\n**\`${file}\`** — ${mutants.filter((m) => m.status === "Survived").length} survived\n\n`;
    for (const m of survivors) {
      const line = m.location?.start?.line ?? "?";
      const repl = m.replacement ? ` → \`${esc(m.replacement.slice(0, 60))}\`` : "";
      out += `- \`L${line}\` \`${m.mutatorName}\`${repl}\n`;
    }
    const more = mutants.filter((m) => m.status === "Survived").length - survivors.length;
    if (more > 0) out += `- …and ${more} more (see artifact)\n`;
    out += "\n";
  }
  return out + "</details>\n";
}

function buildMarkdown(coverage, mutation) {
  const lines = [STICKY_MARKER, "", "## 🧪 Test quality report", ""];

  lines.push(`Coverage: **${fmtPct(coverage?.total?.lines?.pct)}** lines · **${fmtPct(coverage?.total?.branches?.pct)}** branches · **${fmtPct(coverage?.total?.functions?.pct)}** functions`);
  if (mutation) {
    lines.push(`Mutation score (src/lib): **${fmtPct(mutation.score)}** — ${mutation.detected} detected (killed + timeout) of ${mutation.valid} valid mutants${mutation.total !== mutation.valid ? ` (${mutation.total} total)` : ""}`);
  } else {
    lines.push("Mutation score: *not available for this run*");
  }
  lines.push("");

  if (coverage?.perFile?.size || mutation?.perFile?.size) {
    lines.push("| File | Lines | Mutation | Killed | Survived | No cov |");
    lines.push("|---|---|---|---|---|---|");
    const files = new Set([...(coverage?.perFile.keys() ?? []), ...(mutation?.perFile.keys() ?? [])]);
    const rows = [...files].map((f) => {
      const cov = coverage?.perFile.get(f) ?? null;
      const mut = mutation?.perFile.get(f)?.score ?? null;
      return { f, cov, mut };
    });
    rows.sort((a, b) => (a.mut?.score ?? 999) - (b.mut?.score ?? 999) || (a.cov ?? 999) - (b.cov ?? 999));
    for (const { f, cov, mut } of rows) {
      lines.push(
        `| \`${f}\` | ${fmtPct(cov)} | ${fmtPct(mut?.score)} | ${mut ? mut.Killed : "—"} | ${mut ? mut.Survived : "—"} | ${mut ? mut.NoCoverage : "—"} |`
      );
    }
    lines.push("");
  }

  if (mutation) lines.push(survivorsSection(mutation));

  lines.push("<details>");
  lines.push("<summary>About this report</summary>");
  lines.push("");
  lines.push("- Coverage: Vitest v8 provider (`npm run test:coverage`) — report-only, no thresholds enforced.");
  lines.push("- Mutation testing: StrykerJS on `src/lib/**/*.ts` (`npx stryker run`) — score = (killed + timeout) / valid mutants.");
  lines.push("- Interactive reports are attached to this run as artifacts: `coverage-report` (HTML) and `mutation-report` (HTML).");
  lines.push("- A scheduled or manual run posts the same report to the run summary instead of a PR comment.");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

/* ---------- main ---------- */

const coverage = loadCoverage();
const mutation = loadMutation();
const markdown = buildMarkdown(coverage, mutation);

if (!coverage && !mutation) {
  console.error("Neither coverage/coverage-summary.json nor reports/mutation/mutation.json found; nothing to report.");
  process.exit(0);
}

process.stdout.write(markdown);
if (SUMMARY) appendFileSync(SUMMARY, markdown);
if (OUT_FILE) writeFileSync(OUT_FILE, markdown);