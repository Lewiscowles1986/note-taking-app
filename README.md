# Note Haven 📝

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Lewiscowles1986/note-taking-app)

Note Haven is a local-first, privacy-focused Markdown note-taking application. It combines the simplicity of Markdown with powerful features like encrypted notes, interactive diagrams, and sandboxed code execution, all while keeping your data strictly in your own browser.

## ✨ Key User Features

> 📸 [Feature gallery](docs/FEATURES.md) — screenshots captured automatically by the E2E suite.

### 🔒 Privacy & Security First

- **Local-first:** Your notes are stored in your browser's IndexedDB. Your data never leaves your device unless you choose to export it.
- **End-to-End Encryption:** Protect sensitive notes with industry-standard AES/RSA encryption. Supports both simple passwords and robust Key Pair (RSA) management.
- **Secure Key Management:** Export and import your encryption keys (JWK/PEM formats) to keep your notes accessible across devices.

### ✍️ Modern Writing Experience

- **Markdown Centric:** Real-time rendering of GitHub Flavored Markdown (GFM).
- **Smart Editor:** Slash commands (`/`) for quick formatting, auto-completing lists, and intelligent indentation.
- **Obsidian-style Callouts:** Use `> [!NOTE]` and other callouts to add styled highlights (Tip, Warning, Caution, etc.) to your notes.
- **Rich Media Support:** Paste images directly into the editor. Automatic thumbnailing and local attachment management.
- **Interactive Diagrams:** Native support for [Mermaid.js](https://mermaid.js.org/) to create flowcharts, sequence diagrams, and more directly in your notes.
- **Code Execution:** Write and run sandboxed JavaScript code blocks directly within your notes. Perfect for quick calculations or prototyping.
- **GeoJSON support:** Render GeoJSON data as interactive maps directly in notes. Supports multiple markers and auto-clustering of points too close together.
- **3D Model Rendering:** Render interactive STL and OBJ 3D models directly in notes. Supports custom camera angles, coordinate systems, texture overrides, and CAD-style multi-viewport grids via Markdown code blocks with YAML frontmatter.

### 🗂 Organized & Discoverable
- **Powerful Search:** Instantly find notes with real-time full-text search.
- **Tagging & Categories:** Organize your thoughts with a flexible system of tags and categories.
- **Pinned Notes:** Keep your most important notes at the top.
- **Calendar View:** Visualize your note-taking history and find notes by date.
- **Import / Export:** Easily backup your entire database or individual notes.

---

## 🛠 Developer Experience (DX)

Note Haven is built with a focus on type safety, performance, and extensibility.

### 🏗 Tech Stack

- **Frontend:** [React 18](https://reactjs.org/) + [TypeScript](https://www.typescriptlang.org/)
- **Build Tool:** [Vite](https://vitejs.dev/) with SWC for lightning-fast HMR.
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) + [Shadcn UI](https://ui.shadcn.com/) (Radix UI primitives).
- **Storage:** [Dexie.js](https://dexie.org/) for a robust, typed IndexedDB interface.
- **Markdown:** `react-markdown` with GFM and customized syntax highlighting via [Shiki](https://shiki.matsu.io/).
- **Icons:** [Lucide React](https://lucide.dev/).

### 🧪 Testing & Quality

- **Unit/Component:** [Vitest](https://vitest.dev/) + [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/) for fast, reliable tests (`src/test/`).
- **Coverage:** `npm run test:coverage` (V8 provider; text report in CI, HTML in `coverage/`).
- **E2E Testing:** [Playwright](https://playwright.dev/) for browser automation. `npm run test:e2e` runs the headless Playwright suite (specs: app, notes, editor, calendar, security, export-import). See [e2e/README.md](e2e/README.md) for details.
- **Linting:** [oxlint](https://oxc.rs/docs/guide/usage/linter.html) — the Rust-based linter from the oxc project, with type-aware rules powered by tsgo (the native TypeScript compiler).
- **What to write when:** [docs/TESTING.md](docs/TESTING.md) — the test pyramid, coverage workflow, and the opt-in tooling menu (mutation testing via StrykerJS, IndexedDB integration tests, network mocking).
- **Local CI:** Run your GitHub Actions locally using [act](https://github.com/nektos/act).

### 🚀 Getting Started

1. **Dev Container (recommended):** open the repository in VS Code or Codespaces and **Reopen in Container**. Node.js, npm, git, the docker CLI and the Playwright browsers are pinned declaratively (Nix + a Playwright base image), so no local toolchain setup is required. Prefer the terminal? `scripts/devcontainer-up.sh` starts the container in one command (building the pinned image from source if it is not published yet). See [.devcontainer/README.md](.devcontainer/README.md).
2. **Manual install:** clone, install Node 22 (see `.node-version`), then
   ```bash
   npm install
   ```

3. **Development:**
   ```bash
   npm run dev
   ```

4. **Build:**
   ```bash
   npm run build
   ```

5. **Testing:**
   ```bash
   npm test          # Run Vitest
   npm run test:e2e  # Run the Playwright E2E suite (headless)
   ```

6. **Local CI (Optional):**
   Install `act` to run the GitHub Actions workflow (test, lint, build) across Node.js versions (22, 24, 25):
   ```bash
   brew install act
   # Run all actions
   act
   # If on Apple M-series, you might need:
   act --container-architecture linux/amd64
   ```

### 🚀 Deploying & PR previews (GitHub Pages)

The app is published to GitHub Pages from the **`gh-pages` branch** (Deploy from a
branch, path `/`), so the published site and a live preview per PR live side by side:

```
https://<owner>.github.io/<repo>/                  <-- the real app (main)
https://<owner>.github.io/<repo>/preview-builds/<branch>/   <-- a PR's preview
```

`.github/workflows/github-pages.yml` uses `peaceiris/actions-gh-pages` (the same
pattern as the sibling `py-call-graph` repo):

- **push to `main`** builds the app and publishes it to the `gh-pages` root with
  `keep_files: true`, so existing `preview-builds/` are preserved.
- **pull request** builds that branch as a clearly-badged **PREVIEW** (amber
  banner, isolated per-branch IndexedDB) and publishes it to
  `preview-builds/<branch>/`, then comments the link on the PR.

Each push to `gh-pages` makes GitHub Pages rebuild, so a preview is live in the
build — no waiting on a later `main` deploy.

> **One-time setup:** ensure GitHub Pages is configured as **Source → Deploy from
> a branch → `gh-pages` / (root)**. (The old config published from `main` via a
> GitHub Actions workflow, which is why a PR branch could never publish.)

### 🧩 Extensibility

The application is designed to be easily extended:
- **Code Runners:** Register new language runners in `src/lib/codeRunners.ts`.
- **Slash Commands:** Add new commands in `src/components/SlashCommandMenu.tsx`.
- **UI Components:** Built on top of Shadcn UI for consistent design language.
- **GeoJSON Support:** Configure GeoJSON data with YAML frontmatter in a ` ```geojson ` block. For now it's just markers, but may add layers, etc.
- **3D Models:** Configure STL or OBJ interactive model views using the ` ```3dmodel ` block language.

#### ⚙️ 3D Model Configuration (YAML Frontmatter)
You can configure rendering parameters via YAML frontmatter in a ` ```3dmodel ` block:
- `pan`: `true|false` (Enable/disable camera panning)
- `zoom`: `true|false` (Enable/disable scrolling/pinching to zoom)
- `drag` / `grab`: `true|false` (Enable/disable mouse dragging to rotate)
- `camera`: `[x, y, z]` (Camera position coordinates)
- `system`: `z-up|y-up` (Coordinate system; defaults to `z-up` for STL and `y-up` for OBJ)
- `projection`: `perspective|orthographic` (Camera projection mode; defaults to `perspective`. `orthographic` is ideal for blueprint-style views)
- `texture`: `attachment:name|URL` (Apply custom texture to the model)
- `uvProjection`: `planar-x|planar-y|planar-z` (Apply planar UV mapping coordinates projection)
- `viewports`: List of viewport configurations for side-by-side or grid multi-view CAD displays:
  ```yaml
  viewports:
    - name: Isometric
      camera: [20, 20, 20]
      mode: Solid
    - name: Top View
      camera: [0, 30, 0]
      mode: Wireframe
      projection: orthographic
      pan: false
  ```

  Attachments are similar syntax to markdown images, but with base64 inline content; which we can turn into named artifacts to access.

---

## TODO

- server runner examples
- reference server sandbox integration code
- WASM runner example (we could use PHP)
- storybook example
- ability to plug-in backend server
   - indexDB still primary
   - may borrow from vibecodedmess.space for full offline-first experience
- infra code
- better tests
   - [X] browser automation tests
   - more comprehensive unit and integration level tests
- regresion tests
   - [X] window.open has two entrypoints. AI couldn't quite cope there.
- [X] ci workflow(s)
- [X] cd setup?

---

## 📄 License

AGPL v3 License - A.K.A ... _probably dont use this code_
