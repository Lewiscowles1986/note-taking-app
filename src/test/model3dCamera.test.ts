// Tests for the "Save camera view" write-back: capturing a live 3D camera
// position into the `3dmodel` block's frontmatter without clobbering any of the
// note's other keys or the base64 model payload.
import { describe, it, expect } from 'vitest';
import {
  applyCameraToBlock,
  applyCameraToNoteContent
} from '@/components/Model3DBlock';

const DATA = 'attachment:my-model.stl';

describe('applyCameraToBlock (single top-level viewport)', () => {
  it('updates the existing top-level camera and preserves everything else', () => {
    const block = `---
mode: Solid
pan: true
camera: [10, 10, 15]
---
${DATA}`;
    const out = applyCameraToBlock(block, 0, [1.2345, -2.6789, 3]);
    expect(out).toBe(`---
mode: Solid
pan: true
camera: [1.235, -2.679, 3]
---
${DATA}`);
    expect(out).toContain(DATA);
    expect(out).not.toContain('[10, 10, 15]');
  });

  it('adds a missing top-level camera without clobbering other keys', () => {
    const block = `---
mode: Wireframe
---
${DATA}`;
    const out = applyCameraToBlock(block, 0, [5, 6, 7]);
    expect(out).toContain('camera: [5, 6, 7]');
    expect(out).toContain('mode: Wireframe');
    expect(out).toContain(DATA);
  });
});

describe('applyCameraToBlock (multi-viewport)', () => {
  const block = `---
mode: Solid
viewports:
  - name: Front
    camera: [0, 0, 20]
  - name: Side
    camera: [20, 0, 0]
---
${DATA}`;

  it('updates the matching viewport entry camera', () => {
    const out = applyCameraToBlock(block, 1, [1, 2, 3]);
    expect(out).toContain('    camera: [1, 2, 3]');
    expect(out).toContain('  - name: Front\n    camera: [0, 0, 20]');
    expect(out).toContain(DATA);
    expect(out).not.toContain('[20, 0, 0]');
  });

  it('adds a camera to a viewport entry that had none', () => {
    const sparse = `---
viewports:
  - name: Front
  - name: Side
    camera: [20, 0, 0]
---
${DATA}`;
    const out = applyCameraToBlock(sparse, 0, [0, 0, 9]);
    expect(out).toContain('- name: Front\n  camera: [0, 0, 9]');
    expect(out).toContain('    camera: [20, 0, 0]');
    expect(out).toContain(DATA);
  });
});

describe('applyCameraToBlock (edge cases)', () => {
  it('returns null for a block with no frontmatter', () => {
    expect(applyCameraToBlock(DATA, 0, [1, 2, 3])).toBeNull();
  });
});

describe('applyCameraToNoteContent', () => {
  it('replaces the captured block only, leaving the rest of the note intact', () => {
    const content = `# Title\n\n\`\`\`3dmodel\n---\npan: true\ncamera: [1, 2, 3]\n---\n${DATA}\n\`\`\`\n\nBody text.`;
    const block = `---\npan: true\ncamera: [1, 2, 3]\n---\n${DATA}`;
    const newBlock = `---\npan: true\ncamera: [9, 9, 9]\n---\n${DATA}`;
    const out = applyCameraToNoteContent(content, block, newBlock);
    expect(out).toContain('camera: [9, 9, 9]');
    expect(out).toContain('# Title');
    expect(out).toContain('Body text.');
    expect(out).not.toContain('[1, 2, 3]');
  });

  it('returns content unchanged when the block is not present', () => {
    const content = 'hello';
    expect(applyCameraToNoteContent(content, 'missing', 'other')).toBe('hello');
  });
});
