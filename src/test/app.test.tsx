import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { createNote, db } from "@/lib/db";

/**
 * App — the provider + router shell (ROUND 23 of the coverage campaign).
 *
 * App is a 26-line composition root: it wires the TooltipProvider, both
 * toasters (Radix + Sonner) and a BrowserRouter with an Index route at "/"
 * and a catch-all "*" route to NotFound. It has no conditional logic, so a
 * single mount executes every statement; the tests below additionally walk
 * both routes so the shell is exercised for real:
 *
 *   - "/" mounts the genuine Index page against the real Dexie database
 *     (fake-indexeddb, wiped per test) — the same setup Index's own test
 *     file uses, keeping this test honest without a stand-up.
 *   - An unknown path is reached the way a browser reaches it: a history
 *     push plus a popstate event, which react-router's BrowserRouter
 *     subscribes to. No router mock needed — jsdom implements the History
 *     API.
 *
 * NotFound logs every unmatched route through console.error; the spy below
 * silences that output and lets the catch-all route be asserted end-to-end.
 */
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

/** Clear every table (schema stays open at v4). Unlike delete/reopen this
 * cannot raise DatabaseClosedError from a previous test's in-flight read
 * landing after the wipe — pending reads resolve against empty tables. */
async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

describe("App shell (Round 23 — 100% line coverage)", () => {
  it("mounts the provider stack and renders Index at /", async () => {
    const { container } = render(<App />);

    // Real Index mounts through BrowserRouter's "/" route: sidebar layout
    // plus the empty state, loaded from the real (just-wiped) database.
    expect(await screen.findByRole("heading", { name: "No note selected" })).toBeInTheDocument();
    expect(screen.getByText("No notes yet. Create one!")).toBeInTheDocument();
    expect(container.querySelector(".w-72")).toBeTruthy();
  });

  it("streams notes from the real database into the Index route", async () => {
    await createNote({ title: "Shell note", content: "rendered through the router" });

    render(<App />);

    expect(await screen.findByText("Shell note")).toBeInTheDocument();
  });

  it("renders NotFound for unknown routes via the catch-all", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "No note selected" });

    // Navigate like a browser would: a history push followed by the
    // popstate event BrowserRouter listens for.
    act(() => {
      window.history.pushState({}, "", "/definitely/missing");
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    expect(await screen.findByRole("heading", { level: 1, name: "404" })).toBeInTheDocument();
    expect(screen.getByText("Oops! Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Home" })).toHaveAttribute("href", "/");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "404 Error: User attempted to access non-existent route:",
      "/definitely/missing",
    );
  });
});