# Note Haven — Feature Gallery

Note Haven is a local-first, privacy-focused Markdown note-taking app. Your notes live in your browser, and you can write, render, diagram, map, model, and encrypt them all in one place.

> These screenshots are captured automatically by the Playwright documentation tour. See the [Testing](#testing) section below to regenerate them.

## Your Notes at a Glance

![Your Notes at a Glance](images/app-overview.png)

The main workspace pairs a searchable sidebar with a full Markdown editor. Notes are stored entirely in your browser, so everything you write stays on your device.

## Find Anything Instantly

![Find Anything Instantly](images/sidebar-search.png)

Real-time full-text search narrows your notes as you type, so you can jump straight to the note you need without scrolling.

## Organize with Tags

![Organize with Tags](images/tag-filters.png)

Tags and categories let you group related notes. Expand the Tags facet and click a tag to filter the list down to just those notes.

## Write Faster with Slash Commands

![Write Faster with Slash Commands](images/slash-commands.png)

Type `/` in the editor to open a command palette for inserting code blocks, headings, lists, and more without leaving the keyboard.

## Beautiful Markdown Rendering

![Beautiful Markdown Rendering](images/markdown-view.png)

Switch to View mode to see your Markdown rendered with headings, bold and italic text, lists, links, and GitHub-flavored tables.

## Callouts for Emphasis

![Callouts for Emphasis](images/callouts.png)

Obsidian-style callouts like `> [!NOTE]` and `> [!WARNING]` add styled highlights that draw attention to important information.

## Run Code in Your Notes

![Run Code in Your Notes](images/code-runner.png)

JavaScript code blocks can be executed right inside a note. Press Run to see the output — including `console.log` — without leaving the page.

## Live Diagrams with Mermaid

![Live Diagrams with Mermaid](images/mermaid-diagram.png)

Write Mermaid syntax in a fenced code block and Note Haven renders it as a flowchart, sequence diagram, or other diagram directly in your note.

## Readable BPMN Workflows

![Readable BPMN Workflows](images/bpmn-diagram.png)

BPMN XML is recognized as a dedicated renderer and presented in a labeled, readable block so workflow definitions stay easy to inspect in your notes.

## BPMN Source View

![BPMN Source View](images/bpmn-code.png)

Toggle to the code view to inspect the underlying BPMN XML directly, alongside the rendered diagram.

## Interactive Maps

![Interactive Maps](images/geojson-map.png)

Paste GeoJSON into a code block to render an interactive map with markers. Great for trip plans, field notes, or anything location-based.

## 3D Models in Your Notes

![3D Models in Your Notes](images/model-3d.png)

Embed STL or OBJ models and explore them in 3D. Orbit, pan, and zoom with the on-screen controls, all rendered locally in your browser.

## CAD-Style Multi-Viewports

![CAD-Style Multi-Viewports](images/model-3d-viewports.png)

Configure multiple viewports with different cameras and render modes — like a CAD workspace — to inspect a model from several angles at once.

## Frozen Viewports

![Frozen Viewports](images/model-3d-frozen.png)

A viewport can be frozen so the model is shown at a fixed angle with no controls, perfect for a clean, presentation-ready view.

## A Calendar of Your Notes

![A Calendar of Your Notes](images/calendar-view.png)

The calendar view shows which notes you edited on each day, so you can retrace your writing history and find notes by date.

## Keep Notes Private

![Keep Notes Private](images/encryption-locked.png)

Encrypt a note with a password and it locks immediately. Its contents are hidden until you unlock it, keeping sensitive information safe.

## Manage Encryption Keys

![Manage Encryption Keys](images/encryption-dialog.png)

Beyond passwords, Note Haven supports RSA key pairs. Generate, import, and export keys to keep your encrypted notes accessible across devices.

## Start Fresh

![Start Fresh](images/empty-state.png)

A clean first-run state greets you with a single button to create your first note — no setup, no account, no cloud.

## Testing

The gallery is produced by the E2E documentation tour, which walks each feature to a deterministic state and captures the screenshots above. The images and this page are generated together, so they always stay in sync.

Regenerate the gallery with:

```bash
npm run docs:screenshots
```

This runs `E2E_DOCS=1 playwright test e2e/docs-tour.spec.ts --project=chromium`. The tour is gated behind the `E2E_DOCS` environment variable, so a normal `npm run test:e2e` run skips it entirely and never touches `docs/`.
