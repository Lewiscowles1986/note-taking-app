/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "true" on PR preview builds (drives the visible preview banner). */
  readonly VITE_PREVIEW?: string;
  /** Human-readable branch label shown in the preview banner. */
  readonly VITE_PREVIEW_LABEL?: string;
  /**
   * Storage namespace for this build. Preview builds set it to a PR-specific
   * slug so their IndexedDB is isolated from the real app; on main it is unset
   * and storage falls back to the default database name.
   */
  readonly VITE_STORAGE_NAMESPACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
