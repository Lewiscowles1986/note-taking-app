// Renders the Note Haven brand rasters from their SVG sources using the repo's
// Playwright Chromium, so every icon is pixel-identical to the vector mark and
// to public/social-preview.png. Vector art scales losslessly, so each PNG is
// captured at its exact output size.
//
// Usage:
//   node scripts/generate-icons.mjs          # icon set only
//   node scripts/generate-icons.mjs --all    # also re-renders social-preview.png
//
// favicon.ico needs ImageMagick (magick); if it is missing the script skips it.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
const ROUNDED = join(pub, "favicon.svg");
const MASKABLE = join(pub, "icon-maskable.svg");

// [source svg, output file, edge length]
const ICONS = [
  [ROUNDED, "favicon-16x16.png", 16],
  [ROUNDED, "favicon-32x32.png", 32],
  [ROUNDED, "favicon-48x48.png", 48],
  [ROUNDED, "android-chrome-192x192.png", 192],
  [ROUNDED, "android-chrome-512x512.png", 512],
  [MASKABLE, "apple-touch-icon.png", 180],
  [MASKABLE, "maskable-icon-512x512.png", 512],
];

const browser = await chromium.launch();
for (const [svg, out, size] of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // The SVG is inlined as a data: URL: file:// subresources are blocked from
  // about:blank documents created by setContent. omitBackground keeps the
  // transparent corners of the rounded mark.
  const svgData = readFileSync(svg).toString("base64");
  await page.setContent(
    `<style>*{margin:0;padding:0}</style>` +
      `<img src="data:image/svg+xml;base64,${svgData}" width="${size}" height="${size}" style="display:block">`,
    { waitUntil: "load" },
  );
  await page.screenshot({ path: join(pub, out), omitBackground: true });
  await page.close();
  console.log(`rendered public/${out} (${size}x${size})`);
}
await browser.close();

// Multi-resolution .ico for browsers that still request /favicon.ico directly.
try {
  execFileSync("magick", [
    join(pub, "favicon-16x16.png"),
    join(pub, "favicon-32x32.png"),
    join(pub, "favicon-48x48.png"),
    join(pub, "favicon.ico"),
  ]);
  console.log("wrote public/favicon.ico (16/32/48)");
} catch {
  console.warn("magick not found — skipped favicon.ico regeneration");
}

if (process.argv.includes("--all")) {
  const browser2 = await chromium.launch();
  // Capture at 2x device scale for crisp text, then downsample to the
  // canonical 1200x630 Open Graph size.
  const page = await browser2.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
  });
  await page.goto("file://" + join(pub, "social-preview.svg"));
  await page.evaluate(() => document.fonts.ready);
  const tmp = join(root, "social-preview@2x.png");
  await page.screenshot({ path: tmp, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser2.close();
  execFileSync("sips", [
    "-s", "format", "png",
    "--resampleWidth", "1200",
    tmp,
    "--out", join(pub, "social-preview.png"),
  ]);
  execFileSync("rm", ["-rf", tmp]);
  console.log("rendered public/social-preview.png (1200x630)");
}