/**
 * Registration entry point for the wasm-backed language runners.
 *
 * Every `*Runner.ts` module calls its own `register*()` at import time; this
 * module just pulls them in. Registration therefore lives in module side
 * effects, not in function names — a production build mangling the names (as
 * esbuild does) still registers every runner.
 *
 * `import.meta.glob` is eager because a lazy glob returns import functions,
 * which would not run the modules' side effects.
 */

import.meta.glob('./*Runner.ts', { eager: true });
