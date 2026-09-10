/**
 * selection.ts — dragging to select text, and what gets copied.
 *
 * The terminal normally does this for you, and while an app has mouse reporting on it
 * cannot: once the app asks for mouse events the terminal hands them over and stops
 * drawing selections of its own, which is why selecting used to need Shift held down.
 * Wheel scrolling in the alternate screen needs that same reporting, so the two cannot
 * both be the terminal's job. This is the other way round the problem: keep the mouse,
 * and do the selecting here.
 *
 * It works on the FRAMEBUFFER GRID rather than on any React tree, which is the whole
 * reason it is safe. A mouse report carries a terminal row and column; the grid is the
 * terminal, one entry per cell. So a click maps onto a cell with no arithmetic about
 * where anything was laid out, and highlighting is a bit flipped on cells after the
 * frame is built, which cannot move, wrap, or resize a single thing on screen.
 *
 * Selection is by TEXT FLOW, not by rectangle: dragging across three lines takes the end
 * of the first, all of the second, and the start of the third, the way selecting in a
 * document does.
 */
import { ATTR, DEFAULT_COLOR, Screen, WIDE_CONTINUATION } from "./framebuffer/screen.js";

/** A cell on the terminal, zero-based. Mouse reports are 1-based; convert at the edge. */
export interface Cell {
  x: number;
  y: number;
}

/** A drag in progress or finished: where it started, and where the pointer is now. */
export interface Selection {
  anchor: Cell;
  focus: Cell;
}

/** True when the drag never left the cell it started in, so nothing is selected. */
export function isEmpty(sel: Selection): boolean {
  return sel.anchor.x === sel.focus.x && sel.anchor.y === sel.focus.y;
}

/**
 * What Ctrl+C should do given the current selection (pure).
 *
 * The app owns the mouse in the full-screen shell, so text is selected by dragging and
 * Ctrl+C is the reflex to copy it. Quitting on that reflex — right after someone
 * highlighted something to keep — loses the selection and the session at once. So a
 * live selection turns Ctrl+C into a copy that also dismisses the highlight; with
 * nothing selected it quits, so a second press once the highlight is gone still leaves.
 */
export function ctrlCShouldCopy(sel: Selection | null): sel is Selection {
  return sel !== null && !isEmpty(sel);
}

/**
 * The two ends in reading order, so the rest of the file never has to care which way the
 * user dragged. Selecting upwards and selecting downwards are the same selection.
 */
export function normalize(sel: Selection): { start: Cell; end: Cell } {
  const { anchor, focus } = sel;
  const anchorFirst = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
  return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/**
 * The columns covered on row `y`, as a half-open range, or null when the row is outside
 * the selection. A middle row is covered end to end; the first and last are cut by where
 * the drag began and ended.
 */
export function rowSpan(sel: Selection, y: number, width: number): { from: number; to: number } | null {
  const { start, end } = normalize(sel);
  if (y < start.y || y > end.y) return null;
  const from = y === start.y ? start.x : 0;
  // The focus cell is where the pointer is, and the character under the pointer is part
  // of what you are selecting, so the range includes it.
  const to = y === end.y ? end.x + 1 : width;
  return { from: Math.max(0, Math.min(from, width)), to: Math.max(0, Math.min(to, width)) };
}

/**
 * Mark the selected cells inverse, in place.
 *
 * Called on the frame AFTER it is built and before it is diffed against the screen, so
 * the highlight costs one attribute bit per cell and nothing else: no layout, no reflow,
 * and no second render. Clearing a selection needs no undo for the same reason — the
 * next frame is built without the bit and the diff repaints those cells on its own.
 */
export function applySelection(screen: Screen, sel: Selection | null): void {
  if (!sel || isEmpty(sel)) return;
  for (let y = 0; y < screen.height; y++) {
    const span = rowSpan(sel, y, screen.width);
    if (!span) continue;
    for (let x = span.from; x < span.to; x++) {
      const i = screen.index(x, y);
      // NORMALISE the colour first, then invert. Inverting alone swaps each cell's own
      // colours in, so a red error line becomes a red block and a cyan hint a cyan one —
      // the highlight takes on whatever the text under it happened to be, and one
      // selection reads as a patchwork. Resetting foreground and background to the
      // terminal's defaults BEFORE inverting makes every selected cell the same: the
      // default fg on the default bg, inverted, whatever colour the text was. The result
      // is one flat block that stays readable in a light theme or a dark one, because it
      // is the terminal's own inverse rather than a colour we picked. Only the tinted
      // copy is touched; the clean frame keeps the real colours for when the highlight
      // moves or clears (see the framebuffer's `clean`).
      //
      // NOT dim, for the reason it always was: on an inverted cell `dim` applies to the
      // block behind the text, washing it grey while the blanks beside it stay solid.
      screen.fg[i] = DEFAULT_COLOR;
      screen.bg[i] = DEFAULT_COLOR;
      screen.attrs[i] = (screen.attrs[i]! | ATTR.inverse) & ~ATTR.dim;
    }
  }
}

/**
 * The text a selection covers, as it would be pasted.
 *
 * Trailing blanks are cut from every row, because a terminal row is padded out to the
 * full width and copying that padding would paste a wall of spaces. A row that holds
 * nothing but padding becomes an empty line, which is what keeps the blank line between
 * two paragraphs.
 */
export function selectionText(screen: Screen, sel: Selection | null): string {
  if (!sel || isEmpty(sel)) return "";
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    const span = rowSpan(sel, y, screen.width);
    if (!span) continue;
    let line = "";
    for (let x = span.from; x < span.to; x++) {
      const ch = screen.chars[screen.index(x, y)]!;
      // The right half of a wide character carries no codepoint of its own; the left
      // half already contributed the whole character. The other out-of-range value is
      // the renderer's "unknown cell" sentinel, which a grid mid-repaint can hold and
      // which is not a character either. Neither may reach String.fromCodePoint, which
      // throws on them rather than returning something harmless.
      if (ch === WIDE_CONTINUATION || ch > 0x10ffff) continue;
      line += String.fromCodePoint(ch);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}
