import { useState } from 'react';
import type { Note } from '@/lib/db';
import { Tag, FolderOpen, Plus, X, Lock, Unlock } from 'lucide-react';

interface NoteMetaBarProps {
  note: Note;
  allCategories: string[];
  onSave: (changes: Partial<Note>) => void;
  onEncryptClick?: () => void;
}

export default function NoteMetaBar({ note, allCategories, onSave, onEncryptClick }: NoteMetaBarProps) {
  const [newTag, setNewTag] = useState('');
  const [editingCategory, setEditingCategory] = useState(false);
  const [categoryInput, setCategoryInput] = useState(note.category);

  const addTag = () => {
    const tag = newTag.trim();
    if (tag && !note.tags.includes(tag)) {
      onSave({ tags: [...note.tags, tag] });
    }
    setNewTag('');
  };

  const removeTag = (tag: string) => {
    onSave({ tags: note.tags.filter((t) => t !== tag) });
  };

  const saveCategory = () => {
    const cat = categoryInput.trim() || 'General';
    onSave({ category: cat });
    setEditingCategory(false);
  };

  const isEncrypted = !!note.encrypted;

  return (
    <div className="px-4 py-2 pr-[calc(env(safe-area-inset-right,0px)_+_1rem)] border-b border-border flex items-center gap-4 text-xs flex-wrap">
      {/* Category */}
      <div className="flex items-center gap-1.5">
        <FolderOpen size={12} className="text-muted-foreground" />
        {editingCategory ? (
          <div className="flex items-center gap-1">
            <input
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              onBlur={saveCategory}
              onKeyDown={(e) => e.key === 'Enter' && saveCategory()}
              className="bg-accent px-2 py-2.5 min-h-11 rounded text-xs w-28 outline-none sm:py-0.5 sm:min-h-0 sm:w-24"
              list="categories"
              autoFocus
            />
            <datalist id="categories">
              {allCategories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        ) : (
          <button
            onClick={() => {
              setCategoryInput(note.category);
              setEditingCategory(true);
            }}
            className="flex items-center px-2 py-2.5 min-h-11 text-muted-foreground hover:text-foreground sm:px-0 sm:py-0.5 sm:min-h-0"
          >
            {note.category}
          </button>
        )}
      </div>

      {/* Tags */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Tag size={12} className="text-muted-foreground" />
        {note.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-primary/10 text-primary"
          >
            {tag}
            <button onClick={() => removeTag(tag)} className="p-2 flex items-center justify-center -m-1">
              <X size={10} />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-0.5">
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTag()}
            placeholder="Add tag"
            className="bg-transparent py-2.5 min-h-11 w-16 outline-none text-xs placeholder:text-muted-foreground sm:py-0 sm:min-h-0"
          />
          {newTag && (
            <button
              onClick={addTag}
              className="p-2 min-w-11 min-h-11 flex items-center justify-center text-primary sm:min-w-min sm:min-h-min sm:p-0"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Encryption indicator / toggle */}
      <button
        onClick={onEncryptClick}
        className={`ml-auto flex items-center gap-1 px-2.5 py-2.5 min-h-11 rounded transition-colors sm:py-0.5 sm:min-h-0 ${
          isEncrypted
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground'
        }`}
        title={isEncrypted ? 'Encrypted — click to manage' : 'Encrypt this note'}
      >
        {isEncrypted ? <Lock size={12} /> : <Unlock size={12} />}
        <span>{isEncrypted ? 'Encrypted' : 'Encrypt'}</span>
      </button>
    </div>
  );
}
