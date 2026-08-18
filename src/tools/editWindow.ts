/**
 * editWindow.ts — showing the model what its edit actually produced.
 *
 * After a change lands, the tool hands back the changed region with line numbers
 * rather than making the model re-read the whole file to see the result. That one
 * habit is the difference between an edit costing one call and costing two, and
 * re-reads were measured as a large share of wasted context.
 *
 * These live apart from the edit tool itself because `replace_symbol_body` needs
 * the same rendering and has nothing else in common with it. Pure functions over
 * normalized (LF) text: no filesystem, no EOL concerns, trivially testable.
 */

/**
 * Render the lines spanning [startChar, endChar] in `text`, plus `pad` lines of
 * context on each side, with 1-based right-aligned line numbers. Pure and indexed
 * on the normalized (LF) text, so it's independent of the file's real EOL. Bounded
 * by `maxLines` so a sweeping replace can't flood the result.
 */
export function numberedWindow(
  text: string,
  startChar: number,
  endChar: number,
  pad = 4,
  maxLines = 30,
): string {
  const lines = text.split("\n");
  const startLine = charToLine(text, startChar);
  const endLine = charToLine(text, endChar);
  const from = Math.max(0, startLine - pad);
  let to = Math.min(lines.length - 1, endLine + pad);
  let truncated = false;
  if (to - from + 1 > maxLines) {
    to = from + maxLines - 1;
    truncated = true;
  }
  const width = String(to + 1).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${String(i + 1).padStart(width)}  ${lines[i] ?? ""}`);
  }
  if (truncated) out.push("    … (region continues; re-read the file if you need the rest)");
  return out.join("\n");
}

/** The 0-based line a character offset falls on (count of newlines before it). */
export function charToLine(text: string, charIndex: number): number {
  let line = 0;
  const limit = Math.min(charIndex, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}
