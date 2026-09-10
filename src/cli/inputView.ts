/**
 * inputView.ts — what the prompt box actually shows: the buffer wrapped into rows,
 * windowed to a height the frame can afford, with the cursor's exact position.
 *
 * Pure, and separate from the component, because the two things that go wrong here are
 * both arithmetic. A buffer that wraps to more rows than the frame can spare pushes the
 * tip line off the bottom of the screen (measured — that is the glitch this fixes), and
 * a cursor mapped onto the wrong row is worse than no cursor at all. Neither is
 * observable from a typecheck, and both are trivial to assert on a plain string array.
 *
 * The wrap records where each row STARTED in the original buffer, which is what makes
 * the cursor exact. Wrapping and then trying to guess the offset back is where an
 * off-by-one lives: a word break silently drops the space it broke on, so the rendered
 * text is shorter than the source it came from.
 */
import { findTextColumn } from "./wordEdit.js";

/** One rendered row and where it came from in the buffer. */
export interface InputRow {
  text: string;
  /** Index in the original buffer where this row begins. */
  start: number;
}

export interface InputView {
  /** The rows to draw, already windowed to `maxRows`. */
  rows: InputRow[];
  /** Which of `rows` holds the cursor, and where along it. */
  cursorRow: number;
  cursorCol: number;
  /** Rows scrolled out of view above/below, so the box can say so. */
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * Greedy word-wrap that remembers offsets (pure).
 *
 * Explicit newlines always break. A word longer than the width is split rather than
 * allowed to overflow — an unbroken 300-character URL must not push the box wider than
 * the terminal.
 */
export function wrapWithOffsets(text: string, width: number): InputRow[] {
  const w = Math.max(1, width);
  const rows: InputRow[] = [];
  let lineStart = 0;

  for (const line of splitKeepingOffsets(text)) {
    if (line.text.length === 0) {
      rows.push({ text: "", start: line.start });
      continue;
    }
    let i = 0;
    while (i < line.text.length) {
      if (line.text.length - i <= w) {
        rows.push({ text: line.text.slice(i), start: line.start + i });
        break;
      }
      // Break on the last space that fits; if there is none, the word is longer than
      // the row and gets split at the edge.
      const slice = line.text.slice(i, i + w + 1);
      const lastSpace = slice.lastIndexOf(" ");
      const take = lastSpace > 0 ? lastSpace : w;
      rows.push({ text: line.text.slice(i, i + take), start: line.start + i });
      // Skip the single space we broke on; any others belong to the next row.
      i += take + (lastSpace > 0 ? 1 : 0);
    }
    lineStart = line.start + line.text.length + 1;
  }
  void lineStart;
  return rows.length > 0 ? rows : [{ text: "", start: 0 }];
}

/** Split on newlines, keeping each line's offset in the original string. */
function splitKeepingOffsets(text: string): InputRow[] {
  const out: InputRow[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      out.push({ text: text.slice(start), start });
      return out;
    }
    out.push({ text: text.slice(start, nl), start });
    start = nl + 1;
  }
}

/**
 * The rows to draw and where the cursor sits among them.
 *
 * `maxRows` is a hard ceiling on the box's height. Beyond it the view scrolls with the
 * cursor rather than growing, because the prompt shares a fixed frame with the chat and
 * the tip line: a box allowed to grow without limit takes those rows from the bottom of
 * the screen, which is exactly what it looks like when the tip disappears.
 */
export function inputView(value: string, cursor: number, width: number, maxRows: number): InputView {
  const all = wrapWithOffsets(value, width);
  const clampedCursor = Math.max(0, Math.min(cursor, value.length));

  // The LAST row whose start is at or before the cursor. Searching for the first row
  // that contains it would put a cursor sitting exactly on a break at the end of the
  // previous row instead of the start of the next, which is where the caret belongs
  // after typing the character that caused the break.
  let row = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.start <= clampedCursor) row = i;
    else break;
  }
  const cursorCol = Math.max(0, Math.min(clampedCursor - all[row]!.start, all[row]!.text.length));

  const cap = Math.max(1, maxRows);
  if (all.length <= cap) {
    return { rows: all, cursorRow: row, cursorCol, hiddenAbove: 0, hiddenBelow: 0 };
  }
  // Keep the cursor in view, preferring to show as much as possible BEFORE it — when
  // typing you care about what you have just written, not the tail you are pushing down.
  let first = Math.min(Math.max(0, row - (cap - 1)), all.length - cap);
  first = Math.max(0, first);
  return {
    rows: all.slice(first, first + cap),
    cursorRow: row - first,
    cursorCol,
    hiddenAbove: first,
    hiddenBelow: all.length - (first + cap),
  };
}

/**
 * The buffer offset a click at (clickX, clickY) landed on, or null when the click cannot
 * be placed with confidence.
 *
 * A mouse report gives a terminal row and column; this has to turn that into a position
 * in the text. The obvious route — work out where the box was laid out and subtract — is
 * the one thing that must not be done here: the layout is decided by flex at render time,
 * the box has a marker on its first row and continuations on the rest, and any arithmetic
 * that duplicates that becomes wrong the day one of them changes. A wrong answer is not a
 * missing feature, it is a cursor that jumps somewhere the user did not click.
 *
 * So it reads the screen instead. `gridRowAt(y)` returns what was actually PAINTED on
 * row y, and a view row is located by finding its own text there; the difference between
 * where the text starts and where the click landed is the column, with no assumption
 * about borders, padding or the prompt marker.
 *
 * A neighbouring row is checked as well, because two rows of a message can read the same
 * and matching the wrong one would place the caret a line away. Anything that does not
 * resolve returns null and the caller does nothing.
 */
export function clickToOffset(
  rows: InputRow[],
  cursorRow: number,
  cursorCol: number,
  gridRowAt: (y: number) => (x: number) => string,
  width: number,
  clickX: number,
  clickY: number,
): number | null {
  // A painted row IS the row: the caret takes no column of its own. It is the TERMINAL
  // cursor now, parked after the frame (see caretPark.ts), so nothing is inserted into
  // the text and what was rendered matches the buffer exactly.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const col = findTextColumn(gridRowAt(clickY), width, row.text);
    if (col < 0) continue;

    // Confirm with a neighbour: view rows are contiguous on screen, so the row above (or
    // below, for the first) must be where this match implies it is.
    if (i > 0) {
      if (findTextColumn(gridRowAt(clickY - 1), width, rows[i - 1]!.text) < 0) continue;
    } else if (rows.length > 1) {
      if (findTextColumn(gridRowAt(clickY + 1), width, rows[1]!.text) < 0) continue;
    }

    const within = Math.max(0, Math.min(row.text.length, clickX - col));
    return row.start + within;
  }
  return null;
}
