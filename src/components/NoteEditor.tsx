import { useState, useRef, useCallback, useEffect } from 'react';
import { type Note, type NoteAttachment, MAX_INLINE_SIZE, fileToDataUrl, detectContentFeatures } from '@/lib/db';
import SlashCommandMenu, { type SlashCommand } from './SlashCommandMenu';
import { Paperclip } from 'lucide-react';

interface NoteEditorProps {
  note: Note;
  onSave: (changes: Partial<Note>) => void;
}

export default function NoteEditor({ note, onSave }: NoteEditorProps) {
  const [content, setContent] = useState(note.content);
  const [title, setTitle] = useState(note.title);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slash command state
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashPos, setSlashPos] = useState({ top: 0, left: 0 });
  const [slashStart, setSlashStart] = useState(-1);

  const lastNoteId = useRef(note.id);

  useEffect(() => {
    if (note.id !== lastNoteId.current) {
      setContent(note.content);
      setTitle(note.title);
      lastNoteId.current = note.id;
    }
  }, [note.id, note.content, note.title]);

  const saveContent = useCallback(
    (newContent: string) => {
      setContent(newContent);
      // Auto-derive title from first heading or first line
      const firstLine = newContent.split('\n').find((l) => l.trim());
      const derivedTitle = firstLine
        ? firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Untitled'
        : 'Untitled';
      setTitle(derivedTitle);
      onSave({ content: newContent, title: derivedTitle, ...detectContentFeatures(newContent) });
    },
    [onSave]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart;

    // Check for slash command trigger
    const beforeCursor = val.slice(0, pos);
    const lastNewline = beforeCursor.lastIndexOf('\n');
    const currentLine = beforeCursor.slice(lastNewline + 1);

    if (currentLine.startsWith('/')) {
      const filter = currentLine.slice(1);
      setSlashVisible(true);
      setSlashFilter(filter);
      setSlashStart(lastNewline + 1);

      // Position the menu
      if (textareaRef.current) {
        const rect = textareaRef.current.getBoundingClientRect();
        const lineNumber = beforeCursor.split('\n').length;
        setSlashPos({
          top: Math.min(lineNumber * 24 + 8, rect.height - 280),
          left: 16,
        });
      }
    } else {
      setSlashVisible(false);
    }

    saveContent(val);
  };

  const handleSlashSelect = (cmd: SlashCommand) => {
    const before = content.slice(0, slashStart);
    const afterSlash = content.slice(slashStart);
    const newlineIdx = afterSlash.indexOf('\n');
    const after = newlineIdx >= 0 ? afterSlash.slice(newlineIdx) : '';

    const newContent = before + cmd.insert + after;
    saveContent(newContent);
    setSlashVisible(false);

    // Focus and set cursor
    setTimeout(() => {
      if (textareaRef.current) {
        const cursorPos = before.length + cmd.insert.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(cursorPos, cursorPos);
      }
    }, 0);
  };

  const processAndInsertImage = async (file: File, label: string) => {
    try {
      const { processImage } = await import('@/lib/imageProcessor');
      const result = await processImage(file);

      const attId = crypto.randomUUID();
      const att: NoteAttachment = {
        id: attId,
        name: `${label}-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
        type: file.type,
        data: result.originalDataUrl,
        size: result.originalSize,
        thumbnail: result.thumbnailDataUrl,
      };

      // Markdown only stores a lightweight reference — no data URL in content
      const ta = textareaRef.current;
      const insertText = `![${label}](attachment:${attId})`;
      const start = ta ? ta.selectionStart : content.length;
      const end = ta ? ta.selectionEnd : content.length;
      const newContent = content.slice(0, start) + insertText + content.slice(end);

      const firstLine = newContent.split('\n').find((l) => l.trim());
      const derivedTitle = firstLine
        ? firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Untitled'
        : 'Untitled';

      setContent(newContent);
      setTitle(derivedTitle);
      onSave({
        content: newContent,
        title: derivedTitle,
        attachments: [...note.attachments, att],
        ...detectContentFeatures(newContent),
      });

      setTimeout(() => {
        if (ta) {
          ta.focus();
          const pos = start + insertText.length;
          ta.setSelectionRange(pos, pos);
        }
      }, 0);
    } catch (err) {
      console.error('Image processing failed:', err);
      // Fallback: insert a placeholder
      insertAtCursor(`![${label}](failed-to-process)`);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        await processAndInsertImage(file, 'pasted image');
        return;
      }
    }
  };

  const handleFileAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        await processAndInsertImage(file, file.name);
      } else if (file.size <= MAX_INLINE_SIZE) {
        const dataUrl = await fileToDataUrl(file);
        const att: NoteAttachment = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          data: dataUrl,
          size: file.size,
        };
        insertAtCursor(`[📎 ${file.name}](${dataUrl})`);
        onSave({ attachments: [...note.attachments, att] });
      } else {
        const url = prompt(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Enter an external URL for this file:`);
        if (url) {
          insertAtCursor(`[📎 ${file.name}](${url})`);
        }
      }
    }
    e.target.value = '';
  };

  const insertAtCursor = (text: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newContent = content.slice(0, start) + text + content.slice(end);
    saveContent(newContent);
    setTimeout(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current;
    if (!ta) return;

    // Tab indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const indent = '  ';

      if (start === end && !e.shiftKey) {
        // No selection: insert tab at cursor
        const newContent = content.slice(0, start) + indent + content.slice(end);
        saveContent(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(start + indent.length, start + indent.length);
        }, 0);
      } else {
        // Selection: indent/outdent each line
        const before = content.slice(0, start);
        const after = content.slice(end);
        const lineStart = before.lastIndexOf('\n') + 1;
        const selected = content.slice(lineStart, end);
        const lines = selected.split('\n');

        const transformed = lines.map((line) =>
          e.shiftKey
            ? line.startsWith(indent) ? line.slice(indent.length) : line.replace(/^\t/, '')
            : indent + line
        );
        const newBlock = transformed.join('\n');
        const newContent = content.slice(0, lineStart) + newBlock + after;
        saveContent(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(lineStart, lineStart + newBlock.length);
        }, 0);
      }
      return;
    }

    if (e.key !== 'Enter' || e.shiftKey || slashVisible) return;

    const pos = ta.selectionStart;
    const before = content.slice(0, pos);
    const after = content.slice(ta.selectionEnd);

    // Find the current line
    const lastNewline = before.lastIndexOf('\n');
    const currentLine = before.slice(lastNewline + 1);

    // Match list patterns
    const unorderedMatch = currentLine.match(/^(\s*)([-*+])\s/);
    const orderedMatch = currentLine.match(/^(\s*)(\d+)\.\s/);
    const checkboxMatch = currentLine.match(/^(\s*)-\s\[[ x]\]\s/);

    let continuation = '';

    if (checkboxMatch) {
      const cIndent = checkboxMatch[1];
      if (currentLine.trim() === '- [ ]' || currentLine.trim() === '- [x]') {
        const newContent = before.slice(0, lastNewline + 1) + after;
        e.preventDefault();
        saveContent(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(lastNewline + 1, lastNewline + 1);
        }, 0);
        return;
      }
      continuation = `${cIndent}- [ ] `;
    } else if (orderedMatch) {
      const oIndent = orderedMatch[1];
      const num = parseInt(orderedMatch[2], 10);
      if (currentLine.trim() === `${num}.`) {
        const newContent = before.slice(0, lastNewline + 1) + after;
        e.preventDefault();
        saveContent(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(lastNewline + 1, lastNewline + 1);
        }, 0);
        return;
      }
      continuation = `${oIndent}${num + 1}. `;
    } else if (unorderedMatch) {
      const uIndent = unorderedMatch[1];
      const marker = unorderedMatch[2];
      if (currentLine.trim() === marker) {
        const newContent = before.slice(0, lastNewline + 1) + after;
        e.preventDefault();
        saveContent(newContent);
        setTimeout(() => {
          ta.focus();
          ta.setSelectionRange(lastNewline + 1, lastNewline + 1);
        }, 0);
        return;
      }
      continuation = `${uIndent}${marker} `;
    }

    if (continuation) {
      e.preventDefault();
      const insert = '\n' + continuation;
      const newContent = before + insert + after;
      saveContent(newContent);
      setTimeout(() => {
        ta.focus();
        const newPos = pos + insert.length;
        ta.setSelectionRange(newPos, newPos);
      }, 0);
    }
  };

  return (
    <div className="relative flex-1 flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
          title="Attach file"
        >
          <Paperclip size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileAttach}
        />
        <span className="text-xs text-muted-foreground font-mono">Editing</span>
      </div>
      <div className="relative flex-1 min-h-0">
        <textarea
          ref={textareaRef}
          className="note-editor"
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Start writing... Type / for commands"
          spellCheck
        />
        <SlashCommandMenu
          visible={slashVisible}
          position={slashPos}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setSlashVisible(false)}
        />
      </div>
    </div>
  );
}
