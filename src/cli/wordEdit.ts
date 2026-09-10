/**
 * wordEdit.ts — where the cursor lands when you move or delete by the chunk.
 *
 * Backspace one character at a time is fine for a typo and useless for a sentence, and
 * the input had nothing between the two: Ctrl+U cleared the whole line and that was the
 * only bulk operation. These are the missing middle, and they are here as pure functions
 * on (text, cursor) rather than inside the reducer so the boundary rules can be pinned by
 * tests instead of discovered by holding a key down and watching what disappears.
 *
 * A "word" here is a run of non-whitespace, which is coarser than a language-aware
 * boundary and is the right coarseness for this input: `C:\Users\me\Pictures\shot.png`
 * is one thing you want gone in one keystroke, not eight.
 */

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/**
 * Where on a painted terminal row a piece of text begins, or -1 if it is not there.
 *
 * This is how a click in the input box finds its column WITHOUT anyone computing where
 * the box was laid out. The box's border, padding and prompt marker all sit to the left
 * of the text; rather than adding those up (and being wrong the day one of them changes),
 * the row's own text is located in the row that was actually painted, and the difference
 * IS the offset. A row that cannot be found returns -1, and the caller does nothing —
 * which is the whole point: a mistaken guess moves nobody's cursor.
 *
 * One mismatched cell is tolerated because the caret takes the cell it sits on, so the
 * row on screen differs from the row in the buffer by exactly one character whenever the
 * caret is mid-row and lit.
 *
 * `rowAt` reads a cell as a string, so the caller decides where the row comes from.
 */
export function findTextColumn(
  rowAt: (x: number) => string,
  width: number,
  text: string,
  tolerance = 1,
): number {
  if (text === "") return -1;
  for (let start = 0; start + text.length <= width; start++) {
    let wrong = 0;
    for (let i = 0; i < text.length; i++) {
      if (rowAt(start + i) !== text[i]) {
        wrong++;
        if (wrong > tolerance) break;
      }
    }
    if (wrong <= tolerance) return start;
  }
  return -1;
}

/**
 * Start of the chunk behind the cursor: skip any whitespace immediately behind, then the
 * run of non-whitespace before that. Trailing whitespace goes with the word it follows,
 * so deleting from the end of `foo bar   ` lands on `foo ` in one press rather than
 * spending a press on the gap.
 */
export function wordStart(value: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, value.length));
  while (i > 0 && isSpace(value[i - 1]!)) i--;
  while (i > 0 && !isSpace(value[i - 1]!)) i--;
  return i;
}

/**
 * End of the chunk ahead of the cursor: skip whitespace, then the run of non-whitespace.
 * The mirror of wordStart, so pressing forward then back returns you where you were.
 */
export function wordEnd(value: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, value.length));
  while (i < value.length && isSpace(value[i]!)) i++;
  while (i < value.length && !isSpace(value[i]!)) i++;
  return i;
}

/**
 * End of the LINE the cursor is on, not of the whole buffer. The input is multi-line
 * (Shift+Enter), so "delete to the end" has to mean the line or it would eat the rest of
 * a message from the middle of its first line.
 */
export function lineEnd(value: string, cursor: number): number {
  const from = Math.max(0, Math.min(cursor, value.length));
  const nl = value.indexOf("\n", from);
  return nl === -1 ? value.length : nl;
}

/**
 * What Ctrl+K removes: the rest of the line, or — when the cursor already sits at the end
 * of one — the line break itself, which is what joins this line to the next. Without that
 * second case the key does nothing at a line end and reads as broken.
 */
export function killToLineEnd(value: string, cursor: number): { value: string; cursor: number } {
  const from = Math.max(0, Math.min(cursor, value.length));
  const end = lineEnd(value, from);
  const to = end === from ? Math.min(from + 1, value.length) : end;
  return { value: value.slice(0, from) + value.slice(to), cursor: from };
}
