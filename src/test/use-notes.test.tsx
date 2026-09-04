import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useNotes } from "@/hooks/useNotes";
import { createNote, db, type Note } from "@/lib/db";

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

/** Minutes ago, for deterministic updatedAt ordering in sort assertions. */
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/** Seed one note with explicit field overrides. */
const seed = (overrides: Partial<Note>): Promise<number> => createNote(overrides);

describe("useNotes", () => {
  beforeEach(resetDb);

  it("starts with empty state before the initial Dexie load lands", async () => {
    const { result } = renderHook(() => useNotes());

    expect(result.current.notes).toEqual([]);
    expect(result.current.activeNote).toBeNull();
    expect(result.current.activeNoteId).toBeNull();
    expect(result.current.searchQuery).toBe("");
    expect(result.current.filterTag).toBeNull();
    expect(result.current.filterCategory).toBeNull();

    await waitFor(() => expect(result.current.notes).toEqual([]));
    expect(result.current.allTags).toEqual([]);
    expect(result.current.allCategories).toEqual([]);
  });

  it("loads seeded notes newest-first and derives sorted tags/categories", async () => {
    await seed({ title: "older", tags: ["work"], category: "Projects", createdAt: minutesAgo(30), updatedAt: minutesAgo(30) });
    await seed({ title: "middle", tags: [], category: "Projects", createdAt: minutesAgo(15), updatedAt: minutesAgo(15) });
    await seed({ title: "newer", tags: ["work", "home"], category: "Home", createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });

    const { result } = renderHook(() => useNotes());

    await waitFor(() => expect(result.current.notes).toHaveLength(3));
    expect(result.current.notes.map((n) => n.title)).toEqual(["newer", "middle", "older"]);
    expect(result.current.allTags).toEqual(["home", "work"]);
    expect(result.current.allCategories).toEqual(["Home", "Projects"]);
    expect(result.current.activeNote).toBeNull();
  });

  it("addNote creates a General note and selects it as active", async () => {
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toEqual([]));

    let createdId = 0;
    await act(async () => {
      createdId = await result.current.addNote();
    });

    expect(result.current.notes).toHaveLength(1);
    expect(result.current.notes[0].category).toBe("General");
    expect(result.current.activeNoteId).toBe(createdId);
    expect(result.current.activeNote?.id).toBe(createdId);
    expect(result.current.activeNote?.title).toBe("Untitled");
  });

  it("addNote uses the active category filter when one is set", async () => {
    await seed({ title: "work note", category: "Work", createdAt: minutesAgo(10), updatedAt: minutesAgo(10) });
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    act(() => {
      result.current.setFilterCategory("Projects");
    });
    await waitFor(() => expect(result.current.notes).toEqual([]));

    let createdId = 0;
    await act(async () => {
      createdId = await result.current.addNote();
    });

    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.notes[0].category).toBe("Projects");
    expect(result.current.activeNoteId).toBe(createdId);
  });

  it("searchQuery routes through searchNotes and clearing restores every note", async () => {
    await seed({ title: "Quarterly report", content: "budget numbers", tags: ["finance"], createdAt: minutesAgo(20), updatedAt: minutesAgo(20) });
    await seed({ title: "Scratch pad", content: "holds the needle inside", tags: [], createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });

    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toHaveLength(2));

    act(() => {
      result.current.setSearchQuery("needle");
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["Scratch pad"]));

    // A query with no matches still resolves through the search path.
    act(() => {
      result.current.setSearchQuery("no-such-term");
    });
    await waitFor(() => expect(result.current.notes).toEqual([]));

    act(() => {
      result.current.setSearchQuery("");
    });
    await waitFor(() => expect(result.current.notes).toHaveLength(2));
  });

  it("filterTag and filterCategory narrow the list together", async () => {
    await seed({ title: "work projects", tags: ["work"], category: "Projects", createdAt: minutesAgo(30), updatedAt: minutesAgo(30) });
    await seed({ title: "work home", tags: ["work"], category: "Home", createdAt: minutesAgo(10), updatedAt: minutesAgo(10) });
    await seed({ title: "home only", tags: [], category: "Home", createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });

    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toHaveLength(3));

    act(() => {
      result.current.setFilterTag("work");
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["work home", "work projects"]));

    act(() => {
      result.current.setFilterCategory("Home");
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["work home"]));

    act(() => {
      result.current.setFilterTag(null);
    });
    // "home only" was touched more recently than "work home", so it sorts first.
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["home only", "work home"]));

    act(() => {
      result.current.setFilterCategory(null);
    });
    await waitFor(() => expect(result.current.notes).toHaveLength(3));
  });

  it("saveNote applies changes and sorts pinned notes first", async () => {
    await seed({ title: "oldest", createdAt: minutesAgo(30), updatedAt: minutesAgo(30) });
    await seed({ title: "newest", createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });

    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["newest", "oldest"]));
    const oldestId = result.current.notes[1].id;
    const newestId = result.current.notes[0].id;

    // Pin the newest: comparator sees (pinned, unpinned) → returns -1 branch.
    await act(async () => {
      await result.current.saveNote(newestId, { pinned: true, title: "newest pinned" });
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["newest pinned", "oldest"]));

    // Pin both: tie broken by updatedAt desc. Pinning "oldest" bumped its
    // updatedAt past "newest pinned", so it now sorts first.
    await act(async () => {
      await result.current.saveNote(oldestId, { pinned: true });
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.pinned)).toEqual([true, true]));
    expect(result.current.notes.map((n) => n.title)).toEqual(["oldest", "newest pinned"]);

    // Unpin the newest: the remaining pinned note floats to the top (returns 1 branch).
    await act(async () => {
      await result.current.saveNote(newestId, { pinned: false, title: "newest" });
    });
    await waitFor(() => expect(result.current.notes.map((n) => n.title)).toEqual(["oldest", "newest"]));
  });

  it("removeNote clears the selection only when the active note is removed", async () => {
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toEqual([]));

    let firstId = 0;
    let secondId = 0;
    await act(async () => {
      firstId = await result.current.addNote();
    });
    await act(async () => {
      secondId = await result.current.addNote();
    });
    expect(result.current.activeNoteId).toBe(secondId);

    // Removing a non-active note keeps the selection (activeNoteId !== id).
    await act(async () => {
      await result.current.removeNote(firstId);
    });
    await waitFor(() => expect(result.current.notes).toHaveLength(1));
    expect(result.current.activeNoteId).toBe(secondId);
    expect(result.current.activeNote?.id).toBe(secondId);

    // Removing the active note resets the selection (activeNoteId === id).
    await act(async () => {
      await result.current.removeNote(secondId);
    });
    await waitFor(() => expect(result.current.notes).toHaveLength(0));
    expect(result.current.activeNoteId).toBeNull();
    expect(result.current.activeNote).toBeNull();
  });

  it("setActiveNoteId to an unknown id yields a null activeNote", async () => {
    await seed({ title: "only", createdAt: minutesAgo(1), updatedAt: minutesAgo(1) });
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toHaveLength(1));

    act(() => {
      result.current.setActiveNoteId(424242);
    });
    expect(result.current.activeNoteId).toBe(424242);
    expect(result.current.activeNote).toBeNull();

    act(() => {
      result.current.setActiveNoteId(result.current.notes[0].id);
    });
    expect(result.current.activeNote?.title).toBe("only");
  });

  it("exposes refresh to re-read the database on demand", async () => {
    const { result } = renderHook(() => useNotes());
    await waitFor(() => expect(result.current.notes).toEqual([]));

    await seed({ title: "later", createdAt: minutesAgo(1), updatedAt: minutesAgo(1) });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.notes).toHaveLength(1);
    expect(result.current.notes[0].title).toBe("later");
  });
});