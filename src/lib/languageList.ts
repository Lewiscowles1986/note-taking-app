/**
 * Language list helpers, free of `import.meta.env` so the Vite config can import
 * this module from Node as well as the app importing it from the browser.
 */

export const DEFAULT_LANGUAGES = 'js,php,python,ruby';

/** Parse a comma-separated language list (e.g. VITE_LANGUAGES). */
export function parseLanguages(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_LANGUAGES)
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `languages` contains `language`. */
export function isEnabled(languages: string[], language: string): boolean {
  return languages.includes(language.toLowerCase());
}
