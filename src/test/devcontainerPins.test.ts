import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the Playwright version pin, which is duplicated across four files
 * that must agree:
 *
 *   1. .devcontainer/base.Dockerfile    — ARG PLAYWRIGHT_IMAGE (the image built)
 *   2. .devcontainer/devcontainer.json  — the tag contributors pull
 *   3. scripts/e2e-docker.sh            — host-side e2e image
 *   4. package-lock.json                — the @playwright/test the suite runs
 *
 * When any of these drift, the failure surfaces late and confusingly: the
 * devcontainer test job silently boots a stale published image and
 * post-create.sh aborts with a version mismatch, or e2e browsers do not match
 * the installed Playwright.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/** The Playwright version baked into the base image (base.Dockerfile ARG). */
function baseImageVersion(): string {
  const match = read('.devcontainer/base.Dockerfile').match(/playwright:v([0-9]+\.[0-9]+\.[0-9]+)-noble/);
  expect(match, 'no playwright:v<version>-noble tag in .devcontainer/base.Dockerfile').not.toBeNull();
  return match![1];
}

describe('devcontainer Playwright pin', () => {
  it('base.Dockerfile and package-lock.json agree', () => {
    const lockfile = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const npmVersion = lockfile.packages['node_modules/@playwright/test']?.version;
    expect(npmVersion, 'no @playwright/test entry in package-lock.json').toBeTruthy();
    expect(npmVersion).toBe(baseImageVersion());
  });

  it('devcontainer.json references the base image version', () => {
    // CI rewrites this to <version>-amd64 / <version>-arm64 before running the
    // in-container checks, so compare only the version and allow the suffix.
    const pinned = read('.devcontainer/devcontainer.json').match(/"image"\s*:\s*"[^"]*:([^"]+)"/);
    expect(pinned, 'no "image" tag in .devcontainer/devcontainer.json').not.toBeNull();
    const version = pinned![1].replace(/-(amd64|arm64)$/, '');
    expect(version).toBe(baseImageVersion());
  });

  it('scripts/e2e-docker.sh derives its image from base.Dockerfile', () => {
    // It must not hard-code a version: that copy is the one that rots quietly.
    const script = read('scripts/e2e-docker.sh');
    expect(script).not.toMatch(/mcr\.microsoft\.com\/playwright:v[0-9]/);
    expect(script).toMatch(/base\.Dockerfile/);
  });

  it('devcontainer post-create pairing check stays wired up', () => {
    const postCreate = read('.devcontainer/post-create.sh');
    expect(postCreate).toMatch(/PW_IMAGE_TAG/);
    expect(read('.devcontainer/devcontainer.json')).toMatch(
      /"postCreateCommand"\s*:\s*"[^"]*post-create\.sh/,
    );
  });
});
