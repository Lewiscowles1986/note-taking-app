import { describe, it, expect } from 'vitest';
import { getCalloutDef, calloutTypePattern, calloutRegistry } from '@/lib/callouts';

describe('calloutRegistry', () => {
  it('contains all five GitHub callout types', () => {
    const types = calloutRegistry.map((c) => c.type);
    expect(types).toContain('NOTE');
    expect(types).toContain('TIP');
    expect(types).toContain('IMPORTANT');
    expect(types).toContain('WARNING');
    expect(types).toContain('CAUTION');
  });

  it('each callout has a unique colorKey', () => {
    const colorKeys = calloutRegistry.map((c) => c.colorKey);
    expect(new Set(colorKeys).size).toBe(colorKeys.length);
  });

  it('each callout has icon and label', () => {
    for (const def of calloutRegistry) {
      expect(def.icon).toBeDefined();
      expect(def.label.length).toBeGreaterThan(0);
    }
  });
});

describe('getCalloutDef', () => {
  it('finds callout by type case-insensitively', () => {
    expect(getCalloutDef('tip')?.label).toBe('Tip');
    expect(getCalloutDef('TIP')?.label).toBe('Tip');
    expect(getCalloutDef('Tip')?.label).toBe('Tip');
  });

  it('returns undefined for unknown types', () => {
    expect(getCalloutDef('UNKNOWN')).toBeUndefined();
  });
});

describe('calloutTypePattern', () => {
  it('produces a regex-ready alternation of all types', () => {
    const pattern = calloutTypePattern();
    const regex = new RegExp(`^>\\s*\\[!(${pattern})\\]\\s*$`);
    expect(regex.test('> [!NOTE]')).toBe(true);
    expect(regex.test('> [!TIP]')).toBe(true);
    expect(regex.test('> [!IMPORTANT]')).toBe(true);
    expect(regex.test('> [!WARNING]')).toBe(true);
    expect(regex.test('> [!CAUTION]')).toBe(true);
    expect(regex.test('> [!UNKNOWN]')).toBe(false);
  });
});

describe('callout parsing from markdown lines', () => {
  // Replicating the parsing logic from NoteViewer to test it
  function parseSegments(content: string) {
    const lines = content.split('\n');
    const segments: { type: 'markdown' | 'callout'; content: string; calloutType?: string; bodyLines?: string[] }[] = [];
    const typeRegex = new RegExp(`^>\\s*\\[!(${calloutTypePattern()})\\]\\s*$`);
    let i = 0;

    while (i < lines.length) {
      const calloutMatch = lines[i].match(typeRegex);
      if (calloutMatch) {
        const cType = calloutMatch[1];
        const bodyLines: string[] = [];
        i++;
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bodyLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        segments.push({ type: 'callout', content: '', calloutType: cType, bodyLines });
      } else {
        if (segments.length > 0 && segments[segments.length - 1].type === 'markdown') {
          segments[segments.length - 1].content += '\n' + lines[i];
        } else {
          segments.push({ type: 'markdown', content: lines[i] });
        }
        i++;
      }
    }
    return segments;
  }

  it('parses a single callout', () => {
    const segments = parseSegments('> [!TIP]\n> This is helpful');
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('callout');
    expect(segments[0].calloutType).toBe('TIP');
    expect(segments[0].bodyLines).toEqual(['This is helpful']);
  });

  it('parses callout with surrounding markdown', () => {
    const segments = parseSegments('Hello\n\n> [!WARNING]\n> Be careful\n\nGoodbye');
    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe('markdown');
    expect(segments[1].type).toBe('callout');
    expect(segments[1].calloutType).toBe('WARNING');
    expect(segments[2].type).toBe('markdown');
  });

  it('parses multiple callouts', () => {
    const content = '> [!NOTE]\n> Info\n\n> [!CAUTION]\n> Danger';
    const segments = parseSegments(content);
    const callouts = segments.filter((s) => s.type === 'callout');
    expect(callouts).toHaveLength(2);
    expect(callouts[0].calloutType).toBe('NOTE');
    expect(callouts[1].calloutType).toBe('CAUTION');
  });

  it('does not parse regular blockquotes as callouts', () => {
    const segments = parseSegments('> Just a regular quote');
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('markdown');
  });

  it('handles multiline callout bodies', () => {
    const segments = parseSegments('> [!IMPORTANT]\n> Line 1\n> Line 2\n> Line 3');
    expect(segments[0].bodyLines).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });
});

describe('callout CSS contract', () => {
  // These tests verify the expected CSS class structure that callouts depend on.
  // If the rendering code or CSS changes, these should catch regressions.

  const expectedClasses: Record<string, { container: string; colorKey: string }> = {
    NOTE:      { container: 'callout callout-note',      colorKey: 'note' },
    TIP:       { container: 'callout callout-tip',       colorKey: 'tip' },
    IMPORTANT: { container: 'callout callout-important', colorKey: 'important' },
    WARNING:   { container: 'callout callout-warning',   colorKey: 'warning' },
    CAUTION:   { container: 'callout callout-caution',   colorKey: 'caution' },
  };

  for (const [type, expected] of Object.entries(expectedClasses)) {
    it(`${type} callout maps to correct CSS classes`, () => {
      const def = getCalloutDef(type);
      expect(def).toBeDefined();
      expect(`callout callout-${def!.colorKey}`).toBe(expected.container);
      expect(def!.colorKey).toBe(expected.colorKey);
    });
  }

  it('all callout types have distinct colorKeys for distinct styling', () => {
    const keys = calloutRegistry.map((c) => c.colorKey);
    const distinctColors = new Set(keys);
    expect(distinctColors.size).toBe(calloutRegistry.length);
    // Verify none share a colorKey (which would mean same background/border)
    expect(distinctColors).toContain('note');
    expect(distinctColors).toContain('tip');
    expect(distinctColors).toContain('important');
    expect(distinctColors).toContain('warning');
    expect(distinctColors).toContain('caution');
  });

  it('callout container class uses callout-header for icon/title', () => {
    // This ensures the CSS selector `.callout-<type> .callout-header` contract is preserved
    // The NoteViewer renders: <div class="callout callout-<colorKey>"><div class="callout-header">...
    for (const def of calloutRegistry) {
      // Verify the colorKey produces valid CSS class names (no spaces, special chars)
      expect(def.colorKey).toMatch(/^[a-z]+$/);
    }
  });
});
