import { describe, it, expect } from 'vitest';
import {
  parseSwaggerFrontmatter,
  normalizeServerUrl,
  applyBasePath,
  hostToServerUrl,
} from '@/lib/swaggerFrontmatter';

describe('parseSwaggerFrontmatter', () => {
  it('returns raw text when no frontmatter present', () => {
    const raw = 'openapi: 3.0.0';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta).toEqual({});
    expect(specText).toBe(raw);
  });

  it('strips the frontmatter from the spec text', () => {
    const raw = 'servers: https://api.example.com\n---\nopenapi: 3.0.0\ninfo:\n  title: T';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://api.example.com']);
    expect(specText).toBe('openapi: 3.0.0\ninfo:\n  title: T');
  });

  it('parses block-list servers', () => {
    const raw = 'servers:\n  - https://api.example.com\n  - https://staging.example.com/v2\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://api.example.com', 'https://staging.example.com/v2']);
  });

  it('parses inline comma-separated servers', () => {
    const raw = 'servers: https://a.dev, https://b.dev\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('accepts the singular `server` alias', () => {
    const raw = 'server: https://single.dev\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://single.dev']);
  });

  it('drops server entries without a scheme', () => {
    const raw = 'servers:\n  - api.example.com\n  - https://good.dev\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://good.dev']);
  });

  it('strips trailing slashes from server urls', () => {
    expect(normalizeServerUrl('https://api.dev///')).toBe('https://api.dev');
    expect(normalizeServerUrl('  https://api.dev  ')).toBe('https://api.dev');
    expect(normalizeServerUrl('not-a-url')).toBeNull();
    expect(normalizeServerUrl('')).toBeNull();
  });

  it('parses host and basePath', () => {
    const raw = 'host: api.example.com\nbasePath: /v2\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.host).toBe('api.example.com');
    expect(meta.basePath).toBe('/v2');
  });

  it('accepts basePath variants and strips quotes', () => {
    const raw = 'basepath: "/api/v1"\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.basePath).toBe('/api/v1');
  });

  it('combines host + basePath into a server url', () => {
    expect(hostToServerUrl({ host: 'api.dev', basePath: '/v2' })).toBe('http://api.dev/v2');
    expect(hostToServerUrl({ host: 'https://api.dev' })).toBe('https://api.dev');
    expect(hostToServerUrl({ basePath: '/v2' })).toBeNull();
    expect(hostToServerUrl({})).toBeNull();
  });

  it('applies basePath without double-appending', () => {
    expect(applyBasePath('https://api.dev', '/v2')).toBe('https://api.dev/v2');
    expect(applyBasePath('https://api.dev/v2', '/v2')).toBe('https://api.dev/v2');
    expect(applyBasePath('https://api.dev/v2/full', '/v2')).toBe('https://api.dev/v2/full');
    expect(applyBasePath('https://api.dev', undefined)).toBe('https://api.dev');
  });

  it('applies basePath to frontmatter servers too', () => {
    const raw = 'servers: https://api.dev\nbasePath: /v1\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(applyBasePath(meta.servers![0], meta.basePath)).toBe('https://api.dev/v1');
  });

  it('parses multi-line notes', () => {
    const raw = 'notes:\n  Internal API — do not share\n  Auth required\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.notes).toBe('Internal API — do not share\nAuth required');
  });

  it('keys are case-insensitive', () => {
    const raw = 'SERVERS:\n  - https://upper.dev\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://upper.dev']);
  });

  it('ignores unknown keys and their list items', () => {
    const raw = 'servers:\n  - https://good.dev\ntitle: My API\n  - orphan\n---\nspec';
    const { meta } = parseSwaggerFrontmatter(raw);
    expect(meta).toEqual({ servers: ['https://good.dev'] });
  });
});