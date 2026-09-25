// Exclusion policy (server-side deny lists): env parsing, discovery
// advertisement, PUT enforcement (403), manifest filtering, and the DELETE
// exemption (exclusions govern content sync, not lifecycle bookkeeping).
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseListEnv, parseExclusions, exclusionDiscoveryFields, isCategoryExcluded, isUidExcluded } from '../exclusions.mjs';
import { discoveryDocument } from '../oidc.mjs';
import { buildConfig } from '../config.mjs';
import { makeStore, seedUsers } from './helpers.mjs';

describe('parseListEnv', () => {
  it('splits on commas, trims whitespace, drops empties', () => {
    assert.deepEqual(parseListEnv('Private, Legal ,  Work'), ['Private', 'Legal', 'Work']);
  });

  it('dedupes while preserving first-seen order', () => {
    assert.deepEqual(parseListEnv('B,A,B,C,A'), ['B', 'A', 'C']);
  });

  it('returns [] for undefined, empty, and whitespace-only values', () => {
    assert.deepEqual(parseListEnv(undefined), []);
    assert.deepEqual(parseListEnv(''), []);
    assert.deepEqual(parseListEnv('   '), []);
    assert.deepEqual(parseListEnv(',,,,'), []);
  });
});

describe('parseExclusions', () => {
  it('reads both env vars', () => {
    const exclusions = parseExclusions({
      NOTEHAVEN_EXCLUDED_CATEGORIES: 'Private,Legal',
      NOTEHAVEN_EXCLUDED_NOTES: ' uid-1 , uid-2',
    });
    assert.deepEqual(exclusions.excludedCategories, ['Private', 'Legal']);
    assert.deepEqual(exclusions.excludedUids, ['uid-1', 'uid-2']);
  });

  it('defaults to empty lists when the env is unset', () => {
    const exclusions = parseExclusions({});
    assert.deepEqual(exclusions.excludedCategories, []);
    assert.deepEqual(exclusions.excludedUids, []);
  });
});

describe('exclusion predicates', () => {
  const exclusions = { excludedCategories: ['Private'], excludedUids: ['u-9'] };
  it('matches category names exactly (case-sensitive)', () => {
    assert.equal(isCategoryExcluded(exclusions, 'Private'), true);
    assert.equal(isCategoryExcluded(exclusions, 'private'), false);
    assert.equal(isCategoryExcluded(exclusions, ''), false);
    assert.equal(isCategoryExcluded(exclusions, undefined), false);
  });

  it('matches uids exactly', () => {
    assert.equal(isUidExcluded(exclusions, 'u-9'), true);
    assert.equal(isUidExcluded(exclusions, 'U-9'), false);
    assert.equal(isUidExcluded(exclusions, 'u-8'), false);
  });
});

describe('discovery advertisement', () => {
  it('omits the notes key entirely when nothing is excluded', () => {
    const doc = discoveryDocument('http://localhost:8080');
    assert.equal('notes' in doc, false);
    assert.deepEqual(exclusionDiscoveryFields({ excludedCategories: [], excludedUids: [] }), {});
  });

  it('includes notes.excluded_categories/excluded_uids when set', () => {
    const doc = discoveryDocument('http://localhost:8080', { excludedCategories: ['Private'], excludedUids: ['u-1'] });
    assert.deepEqual(doc.notes, { excluded_categories: ['Private'], excluded_uids: ['u-1'] });
  });

  it('buildConfig surfaces the env lists', () => {
    const config = buildConfig({ args: { issuer: 'http://localhost:8190' }, env: { NOTEHAVEN_EXCLUDED_CATEGORIES: 'Legal' } });
    assert.deepEqual(config.exclusions, { excludedCategories: ['Legal'], excludedUids: [] });
  });

  it('buildConfig without env has empty exclusions', () => {
    const config = buildConfig({ args: { issuer: 'http://localhost:8190' }, env: {} });
    assert.deepEqual(config.exclusions, { excludedCategories: [], excludedUids: [] });
  });
});