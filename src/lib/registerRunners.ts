/**
 * Registration entry point for every code-block language runner.
 *
 * Each `*Runner.ts` calls its own `register*()` at import time, and this module
 * eagerly imports them so those side effects run. Registration deliberately does
 * NOT look up functions by name: a production build mangles names (esbuild
 * renames `registerPhpRunner` to `ge`), so a name-based lookup silently
 * registers nothing in the built app.
 *
 * The glob is eager because a lazy glob returns import functions, which would
 * not run the modules' side effects.
 */

import.meta.glob('./*Runner.ts', { eager: true });
