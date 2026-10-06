/**
 * Which language plugins this build activates.
 *
 * Each language's runner file is a build-time plugin: it self-registers when
 * imported, and its heavy payload (wasm, interpreter) is loaded later through a
 * dynamic import(). This decides whether that self-registration happens, and the
 * Vite config uses the same list to leave a disabled language's bundle out of
 * the build entirely.
 *
 * Set `VITE_LANGUAGES` (comma-separated) to change the set. The default keeps
 * the browser-runnable languages on and leaves Elixir off, since it needs
 * cross-origin isolation that GitHub Pages cannot provide.
 *
 *   VITE_LANGUAGES=php npm run build            # only PHP
 *   VITE_LANGUAGES=php,ruby npm run build       # PHP and Ruby
 */

import { parseLanguages, isEnabled } from './languageList';

export const ENABLED_LANGUAGES: string[] = parseLanguages(import.meta.env.VITE_LANGUAGES);

/** True when this build activates the given language plugin. */
export function isLanguageEnabled(language: string): boolean {
  return isEnabled(ENABLED_LANGUAGES, language);
}
