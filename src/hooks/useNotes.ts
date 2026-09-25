import { useState, useEffect, useCallback } from 'react';
import {
  type Note,
  getAllNotes,
  createNote,
  updateNote,
  deleteNote,
  getNote,
  searchNotes,
  getAllTags,
  getAllCategories,
} from '@/lib/db';
import { recordDeletion } from '@/lib/syncDeletion';
import { SYNC_NOTIFICATIONS_EVENT } from '@/lib/syncNotifications';

export function useNotes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    let result: Note[];
    if (searchQuery) {
      result = await searchNotes(searchQuery);
    } else {
      result = await getAllNotes();
    }
    if (filterTag) {
      result = result.filter((n) => n.tags.includes(filterTag));
    }
    if (filterCategory) {
      result = result.filter((n) => n.category === filterCategory);
    }

    // Sort: pinned first, then by updatedAt desc
    result.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    setNotes(result);
    setAllTags(await getAllTags());
    setAllCategories(await getAllCategories());
  }, [searchQuery, filterTag, filterCategory]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the list in sync when the sync engine mutates the store outside a
  // render-triggering path — resolving a keep-or-delete prompt with Delete
  // removes the note directly in IndexedDB (src/lib/syncNotifications.ts).
  useEffect(() => {
    const onQueueChange = () => void refresh();
    window.addEventListener(SYNC_NOTIFICATIONS_EVENT, onQueueChange);
    return () => window.removeEventListener(SYNC_NOTIFICATIONS_EVENT, onQueueChange);
  }, [refresh]);

  const activeNote = notes.find((n) => n.id === activeNoteId) ?? null;

  const addNote = useCallback(async () => {
    const id = await createNote({ category: filterCategory || 'General' });
    await refresh();
    setActiveNoteId(id);
    return id;
  }, [refresh, filterCategory]);

  const saveNote = useCallback(
    async (id: number, changes: Partial<Note>) => {
      await updateNote(id, changes);
      await refresh();
    },
    [refresh]
  );

  const removeNote = useCallback(
    async (id: number) => {
      // Remember the deletion for the next sync (tombstone) BEFORE removing,
      // so the note's identity and last-edit time survive the delete.
      const existing = await getNote(id);
      recordDeletion(id, existing?.updatedAt ?? new Date());
      await deleteNote(id);
      if (activeNoteId === id) setActiveNoteId(null);
      await refresh();
    },
    [activeNoteId, refresh]
  );

  return {
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
  };
}
