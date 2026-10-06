/**
 * Which language plugins this build activates.
 *
 * Each language's runner file is a build-time plugin: it self-registers when
 * imported, and its heavy payload (wasm, interpreter) is loaded later through a
 * dynamic import(). This module decides whether that self-registration happens,
 * so a build can ship a subset without touching any language's code.
 *
 * Set `VITE_LANGUAGES` (comma-separated) to change the set. The default keeps
 * the browser-runnable languages on and leaves Elixir off, since it needs
 * cross-origin isolation that GitHub Pages cannot provide.
 *
 *   VITE_LANGUAGES=php npm run build            # only PHP
 *   VITE_LANGUAGES=php,ruby npm run build       # PHP and Ruby
 */

const DEFAULT_LANGUAGES = 'js,php,python,ruby';

export const ENABLED_LANGUAGES: string[] = (import.meta.env.VITE_LANGUAGES ?? DEFAULT_LANGUAGES)
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

/** True when this build activates the given language plugin. */
export function isLanguageEnabled(language: string): boolean {
  return ENABLED_LANGUAGES.includes(language.toLowerCase());
}
