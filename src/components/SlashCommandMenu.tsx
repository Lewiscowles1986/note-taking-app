import { useEffect, useState, useRef } from 'react';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code,
  Image,
  Minus,
  GitBranch,
  Table,
  Map,
  Box,
} from 'lucide-react';
import { calloutRegistry } from '@/lib/callouts';

export interface SlashCommand {
  label: string;
  description: string;
  icon: React.ReactNode;
  insert: string;
  /** When set, the command is only offered while the cursor is inside a fenced code block of this language. */
  context?: '3dmodel';
}

const baseCommands: SlashCommand[] = [
  { label: 'Heading 1', description: 'Large heading', icon: <Heading1 size={16} />, insert: '# ' },
  { label: 'Heading 2', description: 'Medium heading', icon: <Heading2 size={16} />, insert: '## ' },
  { label: 'Heading 3', description: 'Small heading', icon: <Heading3 size={16} />, insert: '### ' },
  { label: 'Bullet List', description: 'Unordered list', icon: <List size={16} />, insert: '- ' },
  { label: 'Numbered List', description: 'Ordered list', icon: <ListOrdered size={16} />, insert: '1. ' },
  { label: 'Task List', description: 'Checkbox list', icon: <CheckSquare size={16} />, insert: '- [ ] ' },
  { label: 'Quote', description: 'Block quote', icon: <Quote size={16} />, insert: '> ' },
  { label: 'Code Block', description: 'Fenced code', icon: <Code size={16} />, insert: '```\n\n```' },
  { label: 'Divider', description: 'Horizontal rule', icon: <Minus size={16} />, insert: '\n---\n' },
  { label: 'Image', description: 'Image from URL', icon: <Image size={16} />, insert: '![alt](url)' },
  { label: 'Table', description: 'Markdown table', icon: <Table size={16} />, insert: '| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |' },
  {
    label: 'Mermaid Diagram',
    description: 'Flowchart, sequence, etc.',
    icon: <GitBranch size={16} />,
    insert: '```mermaid\ngraph TD\n    A[Start] --> B[End]\n```',
  },
  {
    label: 'GeoJSON Map',
    description: 'Render interactive map',
    icon: <Map size={16} />,
    insert: '```geojson\n{\n  "type": "FeatureCollection",\n  "features": [\n    {\n      "type": "Feature",\n      "properties": {\n        "name": "Washington, D.C.",\n        "description": "Capital of the United States"\n      },\n      "geometry": {\n        "type": "Point",\n        "coordinates": [-77.0369, 38.9072]\n      }\n    }\n  ]\n}\n```',
  },
  {
    label: '3D Model',
    description: 'Render interactive STL or OBJ',
    icon: <Box size={16} />,
    insert: '```3dmodel\n---\nviewports:\n  - name: Isometric\n    camera: [20, 20, 20]\n    mode: Solid\n  - name: Top View\n    camera: [0, 30, 0]\n    mode: Wireframe\n    projection: orthographic\n---\nattachment:clip.stl\n```',
  },
];

// Auto-generate callout slash commands from the registry
const calloutCommands: SlashCommand[] = calloutRegistry.map((def) => {
  const Icon = def.icon;
  return {
    label: `${def.label} Callout`,
    description: `${def.label} callout block`,
    icon: <Icon size={16} />,
    insert: `> [!${def.type}]\n> Your ${def.label.toLowerCase()} here`,
  };
});

// Frontmatter-setting helpers for the 3D model block. These are only offered
// while the cursor is inside a ```3dmodel fence (see the `context` field).
const modelHelperCommands: SlashCommand[] = [
  {
    label: '3D: Camera Position',
    description: 'Set camera [x, y, z]',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'camera: [20, 20, 20]\n',
  },
  {
    label: '3D: Orthographic Projection',
    description: 'Use an orthographic camera',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'projection: orthographic\n',
  },
  {
    label: '3D: Render Mode',
    description: 'Solid / Surface Angle / Wireframe',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'mode: Solid\n',
  },
  {
    label: '3D: Coordinate System',
    description: 'y-up or z-up (CAD)',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'system: y-up\n',
  },
  {
    label: '3D: Texture Override',
    description: 'Map a texture onto the model',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'texture: attachment:tex.png\n',
  },
  {
    label: '3D: UV Projection',
    description: 'planar-y / planar-x / planar-z',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'uvProjection: planar-y\n',
  },
  {
    label: '3D: Enable Pan',
    description: 'Allow panning',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'pan: true\n',
  },
  {
    label: '3D: Enable Zoom',
    description: 'Allow zooming',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'zoom: true\n',
  },
  {
    label: '3D: Enable Drag / Rotate',
    description: 'Allow orbit dragging',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'drag: true\n',
  },
  {
    label: '3D: Add Viewport',
    description: 'Add a multi-viewport config',
    context: '3dmodel',
    icon: <Box size={16} />,
    insert: 'viewports:\n  - name: Isometric\n    camera: [20, 20, 20]\n    mode: Solid\n',
  },
];

const commands: SlashCommand[] = [...baseCommands, ...calloutCommands, ...modelHelperCommands];
interface SlashCommandMenuProps {
  visible: boolean;
  position: { top: number; left: number };
  filter: string;
  /** Fence language the cursor is inside (e.g. '3dmodel'), or null/undefined outside any fence. */
  context?: string | null;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export default function SlashCommandMenu({
  visible,
  position,
  filter,
  context,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  // Refs to the rendered items so the active one can be scrolled into view.
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = commands.filter(
    (c) =>
      (!c.context || c.context === context) &&
      (c.label.toLowerCase().includes(filter.toLowerCase()) ||
        c.description.toLowerCase().includes(filter.toLowerCase()))
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

  // Keep the highlighted item visible while navigating with the keyboard. The
  // list is capped at max-h-64 and overflows (19 commands), so without this the
  // active highlight marches off-screen as the user arrows through it.
  useEffect(() => {
    const activeEl = itemRefs.current[activeIndex];
    // Guarded so tests (jsdom) and any env lacking the API don't crash.
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, filtered]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[activeIndex]) onSelect(filtered[activeIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, activeIndex, filtered, onSelect, onClose]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="slash-menu"
      style={{ top: position.top, left: position.left }}
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {filtered.map((cmd, i) => (
          <div
            key={cmd.label}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className={`slash-menu-item ${i === activeIndex ? 'active' : ''}`}
            onMouseEnter={() => setActiveIndex(i)}
            onClick={() => onSelect(cmd)}
          >
            <span className="text-muted-foreground">{cmd.icon}</span>
            <div>
              <div className="font-medium">{cmd.label}</div>
              <div className="text-xs text-muted-foreground">{cmd.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
