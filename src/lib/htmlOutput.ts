/**
 * Heuristic for deciding whether a code-runner's output is HTML that should be
 * rendered in a sandboxed iframe (via `srcdoc`) rather than shown as plain text.
 *
 * A string is treated as HTML when it starts with a `<` and contains at least
 * one HTML tag (opening or closing). This catches typical PHP output such as
 * `echo "<h1>Hello</h1>";` while leaving plain text and code output alone.
 */
export function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-zA-Z][^>]*>/.test(trimmed);
}
