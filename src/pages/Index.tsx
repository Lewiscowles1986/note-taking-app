import { useState, useCallback } from 'react';
import { useNotes } from '@/hooks/useNotes';
import { useEncryption } from '@/hooks/useEncryption';
import NoteSidebar from '@/components/NoteSidebar';
import NoteEditor from '@/components/NoteEditor';
import NoteViewer from '@/components/NoteViewer';
import NoteMetaBar from '@/components/NoteMetaBar';
import CalendarView from '@/components/CalendarView';
import EncryptionDialog from '@/components/EncryptionDialog';
import type { Note } from '@/lib/db';
import type { StoredKeyPair } from '@/lib/crypto';
import { Eye, Pencil, PanelLeftClose, PanelLeftOpen, Calendar, Lock } from 'lucide-react';
import { toast } from 'sonner';

export default function Index() {
  const {
    notes,
    activeNote,
    activeNoteId,
    setActiveNoteId,
    addNote,
    saveNote,
    removeNote,
    searchQuery,
    setSearchQuery,
    filterTag,
    setFilterTag,
    filterCategory,
    setFilterCategory,
    allTags,
    allCategories,
    refresh,
  } = useNotes();

  const encryption = useEncryption();

  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [calendarMode, setCalendarMode] = useState(false);
  const [encryptionDialogOpen, setEncryptionDialogOpen] = useState(false);

  // Decrypted content cache: noteId -> plaintext (in memory only)
  const [decryptedCache, setDecryptedCache] = useState<Record<number, string>>({});

  const handleSave = (changes: Partial<Note>) => {
    if (activeNoteId) {
      // If note is encrypted and we have decrypted content, re-encrypt on save
      if (activeNote?.encrypted && changes.content !== undefined) {
        // Store plaintext in cache, actual content stays encrypted
        setDecryptedCache((prev) => ({ ...prev, [activeNoteId]: changes.content! }));
        // Don't save plaintext content to DB for encrypted notes
        const { content, ...otherChanges } = changes;
        if (Object.keys(otherChanges).length > 0) {
          saveNote(activeNoteId, otherChanges);
        }
        return;
      }
      saveNote(activeNoteId, changes);
    }
  };

  const handleNewNote = useCallback(async () => {
    await addNote();
    setMode('edit');
    setCalendarMode(false);
  }, [addNote]);

  const handleTogglePin = (note: Note) => {
    if (note.id) {
      saveNote(note.id, { pinned: !note.pinned });
    }
  };

  const handleCalendarSelect = (noteId: number, targetMode: 'edit' | 'view') => {
    setActiveNoteId(noteId);
    setMode(targetMode);
    setCalendarMode(false);
  };

  const handleEncrypt = useCallback(async (
    method: 'password' | 'keypair',
    credential: string | StoredKeyPair,
  ) => {
    if (!activeNote || !activeNoteId) return;
    const plaintext = decryptedCache[activeNoteId] ?? activeNote.content;
    const payload = await encryption.encryptContent(plaintext, method, credential);
    // Store encrypted payload, clear plaintext
    await saveNote(activeNoteId, {
      content: '[encrypted]',
      encrypted: payload,
    });
    // Remove from cache
    setDecryptedCache((prev) => {
      const next = { ...prev };
      delete next[activeNoteId];
      return next;
    });
    toast.success('Note encrypted');
  }, [activeNote, activeNoteId, decryptedCache, encryption, saveNote]);

  const handleDecrypt = useCallback(async (credential: string) => {
    if (!activeNote || !activeNoteId || !activeNote.encrypted) return;
    const plaintext = await encryption.decryptContent(activeNote.encrypted, credential);
    // Save decrypted content back, remove encryption marker
    await saveNote(activeNoteId, {
      content: plaintext,
      encrypted: null,
    });
    // Clear from cache
    setDecryptedCache((prev) => {
      const next = { ...prev };
      delete next[activeNoteId];
      return next;
    });
    toast.success('Note decrypted');
  }, [activeNote, activeNoteId, encryption, saveNote]);

  const handleExportKeys = useCallback(async (kp: StoredKeyPair, format: 'jwk' | 'pem') => {
    let data: string;
    let filename: string;
    if (format === 'jwk') {
      const exported = await encryption.exportAsJwk(kp);
      data = JSON.stringify(exported, null, 2);
      filename = `${kp.name}-keys.json`;
    } else {
      const exported = await encryption.exportAsPem(kp);
      data = exported.publicPem + '\n\n' + exported.privatePem;
      filename = `${kp.name}-keys.pem`;
    }
    const blob = new Blob([data], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Keys exported as ${format.toUpperCase()}`);
  }, [encryption]);

  const handleImportKeys = useCallback(async (name: string, data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.publicKey && parsed.privateKey) {
        await encryption.importJwk(name, parsed.publicKey, parsed.privateKey);
        toast.success('Key pair imported');
        return;
      }
    } catch {
      // Not JWK JSON, might be PEM — not implemented for paste
    }
    throw new Error('Invalid format. Paste JWK JSON: {"publicKey": {...}, "privateKey": {...}}');
  }, [encryption]);

  // Get display content for active note (decrypted if available)
  const getDisplayNote = (): Note | null => {
    if (!activeNote) return null;
    if (activeNote.encrypted && decryptedCache[activeNote.id!]) {
      return { ...activeNote, content: decryptedCache[activeNote.id!] };
    }
    return activeNote;
  };

  const displayNote = getDisplayNote();
  const isLocked = activeNote?.encrypted && !decryptedCache[activeNote.id!];

  if (calendarMode) {
    return (
      <div className="flex h-screen bg-background overflow-hidden">
        <div className="flex-1 flex flex-col h-full min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCalendarMode(false)}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
                title="Back to notes"
              >
                <PanelLeftOpen size={18} />
              </button>
              <span className="text-sm font-medium text-foreground">Calendar</span>
            </div>
            <button
              onClick={() => setCalendarMode(false)}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Pencil size={12} />
              Notes
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <CalendarView
              notes={notes}
              onSelectNote={handleCalendarSelect}
              onNewNote={handleNewNote}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {sidebarOpen && (
        <NoteSidebar
          notes={notes}
          activeNoteId={activeNoteId}
          onSelectNote={setActiveNoteId}
          onNewNote={handleNewNote}
          onDeleteNote={removeNote}
          onTogglePin={handleTogglePin}
          searchQuery={searchQuery}
          onSearch={setSearchQuery}
          allTags={allTags}
          allCategories={allCategories}
          filterTag={filterTag}
          filterCategory={filterCategory}
          onFilterTag={setFilterTag}
          onFilterCategory={setFilterCategory}
          onRefresh={refresh}
        />
      )}

      <div className="flex-1 flex flex-col h-full min-w-0">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
            >
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            {activeNote && (
              <div className="flex items-center gap-1.5">
                {activeNote.encrypted && (
                  <Lock size={14} className="text-primary" />
                )}
                <h2 className="text-sm font-medium text-foreground truncate max-w-xs">
                  {activeNote.title}
                </h2>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCalendarMode(true)}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
              title="Calendar view"
            >
              <Calendar size={18} />
            </button>

            {activeNote && (
              <div className="flex items-center rounded-md bg-muted p-0.5">
                <button
                  onClick={() => setMode('edit')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                    mode === 'edit'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Pencil size={12} />
                  Edit
                </button>
                <button
                  onClick={() => setMode('view')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors ${
                    mode === 'view'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Eye size={12} />
                  View
                </button>
              </div>
            )}
          </div>
        </div>

        {activeNote ? (
          <div className="flex-1 flex flex-col min-h-0">
            <NoteMetaBar
              note={activeNote}
              allCategories={allCategories}
              onSave={handleSave}
              onEncryptClick={() => setEncryptionDialogOpen(true)}
            />
            <div className="flex-1 overflow-y-auto">
              {isLocked ? (
                <div className="flex-1 flex items-center justify-center h-full">
                  <div className="text-center">
                    <Lock size={48} className="mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-semibold text-foreground mb-2">Note is Encrypted</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Decrypt this note to view or edit its contents.
                    </p>
                    <button
                      onClick={() => setEncryptionDialogOpen(true)}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                      Unlock Note
                    </button>
                  </div>
                </div>
              ) : mode === 'edit' ? (
                <NoteEditor note={displayNote!} onSave={handleSave} />
              ) : (
                <NoteViewer note={displayNote!} onSave={handleSave} />
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-6xl mb-4">📝</div>
              <h2 className="text-xl font-semibold text-foreground mb-1">No note selected</h2>
              <p className="text-muted-foreground text-sm mb-4">
                Select a note or create a new one
              </p>
              <button
                onClick={handleNewNote}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Create Note
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Encryption dialog */}
      {encryptionDialogOpen && activeNote && (
        <EncryptionDialog
          note={activeNote}
          keyPairs={encryption.keyPairs}
          onEncrypt={handleEncrypt}
          onDecrypt={handleDecrypt}
          onGenerateKeyPair={encryption.generateNewKeyPair}
          onImportKeys={handleImportKeys}
          onExportKeys={handleExportKeys}
          onDeleteKeyPair={encryption.removeKeyPair}
          onClose={() => setEncryptionDialogOpen(false)}
        />
      )}
    </div>
  );
}
