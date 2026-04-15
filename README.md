# Note Haven 📝

Note Haven is a local-first, privacy-focused Markdown note-taking application. It combines the simplicity of Markdown with powerful features like encrypted notes, interactive diagrams, and sandboxed code execution, all while keeping your data strictly in your own browser.

## ✨ Key User Features

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

- **Unit/Integration:** [Vitest](https://vitest.dev/) for fast, reliable tests.
- **E2E Testing:** [Playwright](https://playwright.dev/) for browser automation.
- **Linting:** [ESLint](https://eslint.org/) with modern flat-config and TypeScript support.
- **Local CI:** Run your GitHub Actions locally using [act](https://github.com/nektos/act).

### 🚀 Getting Started

1. **Clone and Install:**
   ```bash
   git clone <repository-url>
   cd note-haven
   npm install
   ```

2. **Development:**
   ```bash
   npm run dev
   ```

3. **Build:**
   ```bash
   npm run build
   ```

4. **Testing:**
   ```bash
   npm test          # Run Vitest
   npx playwright test # Run Playwright (if configured)
   ```

5. **Local CI (Optional):**
   Install `act` to run the GitHub Actions workflow (test, lint, build) across Node.js versions (22, 24, 25):
   ```bash
   brew install act
   # Run all actions
   act
   # If on Apple M-series, you might need:
   act --container-architecture linux/amd64
   ```

### 🧩 Extensibility

The application is designed to be easily extended:
- **Code Runners:** Register new language runners in `src/lib/codeRunners.ts`.
- **Slash Commands:** Add new commands in `src/components/SlashCommandMenu.tsx`.
- **UI Components:** Built on top of Shadcn UI for consistent design language.

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
   - browser automation tests
   - more comprehensive unit and integration level tests
- regresion tests
   - window.open has two entrypoints. AI couldn't quite cope there.
- ci workflow(s)
- cd setup? - technically as this compiles to static app it's fairly deliverable; but in what state?

---

## 📄 License

AGPL v3 License - dont use this code
