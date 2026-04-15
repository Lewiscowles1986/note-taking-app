/**
 * Parse YAML-like frontmatter from code block content.
 * Frontmatter ends at the first line that is exactly "---".
 *
 * Supported keys:
 *   compatible:   list of version strings
 *   incompatible: list of version strings
 *   notes:        multi-line string (no "---" allowed inside)
 */

export interface CodeFrontmatter {
  compatible?: string[];
  incompatible?: string[];
  notes?: string;
}

export interface ParsedCodeBlock {
  meta: CodeFrontmatter;
  code: string;
}

export function parseCodeFrontmatter(raw: string): ParsedCodeBlock {
  const lines = raw.split('\n');
  const delimIdx = lines.findIndex((l) => l.trim() === '---');

  if (delimIdx < 0) return { meta: {}, code: raw };

  const headerLines = lines.slice(0, delimIdx);
  const code = lines.slice(delimIdx + 1).join('\n');

  const meta: CodeFrontmatter = {};
  let currentKey: string | null = null;
  let notesLines: string[] = [];

  for (const line of headerLines) {
    const keyMatch = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1].toLowerCase();
      const inlineVal = keyMatch[2].trim();

      if (key === 'compatible' || key === 'incompatible') {
        currentKey = key;
        meta[key] = [];
        // inline list like "compatible: 2.7, 3.6"
        if (inlineVal) {
          meta[key] = inlineVal.split(',').map((s) => s.trim()).filter(Boolean);
          currentKey = null;
        }
      } else if (key === 'notes') {
        currentKey = 'notes';
        if (inlineVal) {
          notesLines.push(inlineVal);
        }
      } else {
        currentKey = null;
      }
      continue;
    }

    // List item under compatible/incompatible
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && (currentKey === 'compatible' || currentKey === 'incompatible')) {
      meta[currentKey]!.push(listMatch[1].trim());
      continue;
    }

    // Continuation line for notes
    if (currentKey === 'notes') {
      notesLines.push(line.trimStart());
      continue;
    }
  }

  if (notesLines.length > 0) {
    meta.notes = notesLines.join('\n').trim();
  }

  return { meta, code };
}
