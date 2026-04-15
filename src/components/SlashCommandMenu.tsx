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
} from 'lucide-react';
import { calloutRegistry } from '@/lib/callouts';

export interface SlashCommand {
  label: string;
  description: string;
  icon: React.ReactNode;
  insert: string;
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

const commands: SlashCommand[] = [...baseCommands, ...calloutCommands];
interface SlashCommandMenuProps {
  visible: boolean;
  position: { top: number; left: number };
  filter: string;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export default function SlashCommandMenu({
  visible,
  position,
  filter,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = commands.filter(
    (c) =>
      c.label.toLowerCase().includes(filter.toLowerCase()) ||
      c.description.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

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
