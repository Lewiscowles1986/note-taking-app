import { useState, useRef } from 'react';
import type { Note } from '@/lib/db';
import {
  Search,
  Plus,
  Tag,
  FolderOpen,
  Pin,
  Trash2,
  FileDown,
  FileUp,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { exportToHtml, exportToPdf, exportToZip, exportDatabase } from '@/lib/export';
import { importFiles } from '@/lib/import';
import { toast } from 'sonner';

interface NoteSidebarProps {
  notes: Note[];
  activeNoteId: number | null;
  onSelectNote: (id: number) => void;
  onNewNote: () => void;
  onDeleteNote: (id: number) => void;
  onTogglePin: (note: Note) => void;
  searchQuery: string;
  onSearch: (q: string) => void;
  allTags: string[];
  allCategories: string[];
  filterTag: string | null;
  filterCategory: string | null;
  onFilterTag: (t: string | null) => void;
  onFilterCategory: (c: string | null) => void;
  onRefresh: () => void;
}

export default function NoteSidebar({
  notes,
  activeNoteId,
  onSelectNote,
  onNewNote,
  onDeleteNote,
  onTogglePin,
  searchQuery,
  onSearch,
  allTags,
  allCategories,
  filterTag,
  filterCategory,
  onFilterTag,
  onFilterCategory,
  onRefresh,
}: NoteSidebarProps) {
  const [showTags, setShowTags] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const result = await importFiles(files);
    if (result.imported > 0) {
      toast.success(`Imported ${result.imported} note${result.imported !== 1 ? 's' : ''}`);
      onRefresh();
    }
    if (result.errors.length > 0) {
      toast.error(result.errors.join('\n'));
    }
    // Reset input so same file can be re-imported
    e.target.value = '';
  };

  const formatDate = (d: Date) => {
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  const preview = (content: string) => {
    const text = content.replace(/[#*`\[\]>!\-]/g, '').trim();
    return text.slice(0, 80) || 'No content';
  };

  return (
    <div className="w-72 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-sidebar-border">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-sidebar-foreground">Notes</h1>
          <div className="flex gap-1">
            <input
              ref={importInputRef}
              type="file"
              accept=".md,.markdown,.json,.zip"
              multiple
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => importInputRef.current?.click()}
              className="p-1.5 rounded-md hover:bg-sidebar-accent text-muted-foreground transition-colors"
              title="Import notes"
            >
              <FileUp size={16} />
            </button>
            <button
              onClick={() => setShowExport(!showExport)}
              className="p-1.5 rounded-md hover:bg-sidebar-accent text-muted-foreground transition-colors"
              title="Export"
            >
              <FileDown size={16} />
            </button>
            <button
              onClick={onNewNote}
              className="p-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              title="New note"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-sidebar-accent rounded-md text-sm text-sidebar-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Export dropdown */}
      {showExport && (
        <div className="p-2 border-b border-sidebar-border bg-sidebar-accent/50 text-sm">
          <button
            onClick={() => {
              const active = notes.find((n) => n.id === activeNoteId);
              if (active) exportToHtml(active);
            }}
            className="w-full text-left px-2 py-1 rounded hover:bg-sidebar-accent"
            disabled={!activeNoteId}
          >
            Export current as HTML
          </button>
          <button
            onClick={() => {
              const active = notes.find((n) => n.id === activeNoteId);
              if (active) exportToPdf(active);
            }}
            className="w-full text-left px-2 py-1 rounded hover:bg-sidebar-accent"
            disabled={!activeNoteId}
          >
            Export current as PDF
          </button>
          <button
            onClick={() => exportToZip(notes)}
            className="w-full text-left px-2 py-1 rounded hover:bg-sidebar-accent"
          >
            Export all as ZIP
          </button>
          <button
            onClick={() => {
              exportDatabase();
              toast.success('Database backup downloaded');
            }}
            className="w-full text-left px-2 py-1 rounded hover:bg-sidebar-accent"
          >
            Download full database backup
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="px-3 py-2 border-b border-sidebar-border text-xs">
        {/* Active filters */}
        {(filterTag || filterCategory) && (
          <div className="flex flex-wrap gap-1 mb-2">
            {filterTag && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs">
                <Tag size={10} /> {filterTag}
                <button onClick={() => onFilterTag(null)}><X size={10} /></button>
              </span>
            )}
            {filterCategory && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent text-accent-foreground text-xs">
                <FolderOpen size={10} /> {filterCategory}
                <button onClick={() => onFilterCategory(null)}><X size={10} /></button>
              </span>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => setShowTags(!showTags)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {showTags ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Tag size={12} /> Tags
          </button>
          <button
            onClick={() => setShowCategories(!showCategories)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {showCategories ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <FolderOpen size={12} /> Categories
          </button>
        </div>

        {showTags && allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => onFilterTag(filterTag === tag ? null : tag)}
                className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                  filterTag === tag
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-sidebar-accent text-sidebar-foreground hover:bg-primary/15'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {showCategories && allCategories.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {allCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => onFilterCategory(filterCategory === cat ? null : cat)}
                className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                  filterCategory === cat
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-sidebar-accent text-sidebar-foreground hover:bg-primary/15'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Note list */}
      <div className="flex-1 overflow-y-auto">
        {notes.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            {searchQuery ? 'No notes found' : 'No notes yet. Create one!'}
          </div>
        ) : (
          notes.map((note) => (
            <div
              key={note.id}
              onClick={() => note.id && onSelectNote(note.id)}
              className={`group px-3 py-2.5 cursor-pointer border-b border-sidebar-border transition-colors ${
                note.id === activeNoteId
                  ? 'bg-sidebar-accent'
                  : 'hover:bg-sidebar-accent/50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {note.pinned && <Pin size={12} className="text-primary shrink-0" />}
                    <span className="font-medium text-sm text-sidebar-foreground truncate">
                      {note.title}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {preview(note.content)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-muted-foreground">
                      {formatDate(note.updatedAt)}
                    </span>
                    {note.tags.slice(0, 2).map((t) => (
                      <span
                        key={t}
                        className="text-[10px] px-1.5 py-0 rounded-full bg-primary/10 text-primary"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="opacity-0 group-hover:opacity-100 flex gap-0.5 shrink-0 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(note);
                    }}
                    className="p-1 rounded hover:bg-sidebar-accent"
                    title={note.pinned ? 'Unpin' : 'Pin'}
                  >
                    <Pin size={12} className={note.pinned ? 'text-primary' : 'text-muted-foreground'} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (note.id) onDeleteNote(note.id);
                    }}
                    className="p-1 rounded hover:bg-destructive/10"
                    title="Delete"
                  >
                    <Trash2 size={12} className="text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-sidebar-border">
        <span className="text-[10px] text-muted-foreground">
          {notes.length} note{notes.length !== 1 ? 's' : ''} · Stored locally
        </span>
      </div>
    </div>
  );
}
