/**
 * paint.ts — the diff. Two grids in, the smallest correct escape sequence out.
 *
 * This is the whole point of the framebuffer. Ink's own output is "erase the lines
 * I drew last time, then write every one of them again" — the full screen, every
 * frame, whether one character changed or none did. On a 200x50 terminal that is
 * around 10,000 cells plus styling, tens of kilobytes, pushed through a blocking
 * write on every keystroke and every scroll notch.
 *
 * What this produces instead is only the cells that actually differ, which for a
 * keystroke is a handful and for a scroll is a few rows.
 *
 * ## Three optimisations, all of which matter
 *
 * 1. **Runs, not cells.** Changed cells next to each other are emitted as ONE
 *    cursor move followed by their characters. Positioning every cell separately
 *    would cost ~8 bytes of escape per 1 byte of content and would often be worse
 *    than the full rewrite it replaces.
 *
 * 2. **A carried pen.** Style is emitted only where it CHANGES, and is remembered
 *    across runs and across rows within a frame — a screen of one colour costs one
 *    SGR sequence for the whole frame, not one per run.
 *
 * 3. **Short jumps beat absolute moves.** Continuing a run that is only a couple of
 *    columns along is cheaper as a "cursor right" than as a full reposition, and
 *    cheaper still as spaces when the skipped cells are blank and unstyled.
 *
 * Same shape as ratatui's `Buffer::diff` and OpenTUI's Zig renderer; the run-length
 * batching and the carried pen are exactly what those do to hold 60fps.
 */
import { DEFAULT_COLOR, Screen, WIDE_CONTINUATION, attrParams, colorParams } from "./screen.js";

/** The style currently in effect on the real terminal, as we emit. */
interface Pen {
  fg: number;
  bg: number;
  attrs: number;
}

/**
 * `true` when nothing about the pen is set — the state a bare `\x1b[0m` leaves.
 * Used to skip emitting a reset that would change nothing.
 */
function isClean(pen: Pen): boolean {
  return pen.fg === DEFAULT_COLOR && pen.bg === DEFAULT_COLOR && pen.attrs === 0;
}

/**
 * The escape needed to move the pen from `from` to the cell's style.
 *
 * Attributes can be turned on individually but there is no reliable way to turn a
 * single one off across terminals, so when any attribute is dropped the whole pen
 * is reset and rebuilt. That is a few extra bytes on a rare transition, against
 * correctness everywhere — a stale `bold` that never clears is the kind of artifact
 * that survives for the rest of the session.
 */
function penEscape(from: Pen, screen: Screen, i: number): string {
  const fg = screen.fg[i]!;
  const bg = screen.bg[i]!;
  const attrs = screen.attrs[i]!;
  if (from.fg === fg && from.bg === bg && from.attrs === attrs) return "";

  const params: number[] = [];
  const dropped = from.attrs & ~attrs;
  if (dropped !== 0) {
    // Rebuild from scratch.
    params.push(0);
    params.push(...attrParams(attrs));
    if (fg !== DEFAULT_COLOR) params.push(...colorParams(fg, true));
    if (bg !== DEFAULT_COLOR) params.push(...colorParams(bg, false));
  } else {
    const added = attrs & ~from.attrs;
    if (added !== 0) params.push(...attrParams(added));
    if (fg !== from.fg) params.push(...colorParams(fg, true));
    if (bg !== from.bg) params.push(...colorParams(bg, false));
  }

  from.fg = fg;
  from.bg = bg;
  from.attrs = attrs;
  if (params.length === 0) return "";
  return `\x1b[${params.join(";")}m`;
}

/** The character a cell prints. A wide character's second column prints nothing —
 *  the terminal already moved the cursor two columns for the first. */
function charOf(screen: Screen, i: number): string {
  const c = screen.chars[i]!;
  if (c === WIDE_CONTINUATION) return "";
  return String.fromCodePoint(c === 0 ? 32 : c);
}

/**
 * How many unchanged cells are re-printed to bridge two changed regions instead of
 * breaking the run and repositioning.
 *
 * An absolute cursor move is 6-10 bytes, so re-printing up to that many identical
 * characters is the cheaper of the two — and it means a row of small scattered edits
 * (a status line ticking, a word changing) goes out as one run rather than a dozen.
 *
 * This is the ONLY cursor optimisation, deliberately. An earlier version also tracked
 * the cursor's column so a nearby run could be reached with a relative `\x1b[{n}C`
 * instead of an absolute move. A red-check killed it: introducing an off-by-one into
 * that tracking broke nothing, because the branch is unreachable — any gap small
 * enough to nudge across has already been bridged into the run above, and any gap too
 * large to bridge is also too large to nudge. Untestable code that cannot run is worse
 * than no code, so it is gone and every run positions absolutely.
 */
const BRIDGE_GAP = 6;

/**
 * Emit the escape sequence that turns `previous` into `next`.
 *
 * Both grids must be the same size. Returns `""` when nothing changed at all, which
 * the caller uses to skip the write entirely — an idle app should put no bytes on
 * the terminal, which is also what stops it waking the CPU.
 *
 * `originRow` is where row 0 of the grid sits on the real screen, 1-based, because
 * terminal coordinates are 1-based.
 */
export function paint(previous: Screen, next: Screen, originRow = 1): string {
  if (previous.width !== next.width || previous.height !== next.height) {
    throw new Error(
      `paint(): grids differ in size (${previous.width}x${previous.height} vs ${next.width}x${next.height})`,
    );
  }

  const out: string[] = [];
  // The style currently in effect on the real terminal. Carried across runs AND
  // across rows for the whole frame, so a uniformly coloured screen costs one SGR
  // sequence rather than one per run.
  const pen: Pen = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 };

  for (let y = 0; y < next.height; y++) {
    const rowStart = y * next.width;
    let x = 0;
    while (x < next.width) {
      const i = rowStart + x;
      if (next.sameAs(previous, i)) {
        x++;
        continue;
      }

      // A run of changed cells. Extended through UNCHANGED cells when only a few
      // separate two changed ones: re-printing two identical characters is cheaper
      // than the escape sequence needed to skip them.
      let end = x;
      let gap = 0;
      for (let k = x; k < next.width; k++) {
        if (!next.sameAs(previous, rowStart + k)) {
          end = k;
          gap = 0;
        } else if (++gap > BRIDGE_GAP) {
          break;
        }
      }

      out.push(`\x1b[${originRow + y};${x + 1}H`);
      for (let k = x; k <= end; k++) {
        const at = rowStart + k;
        out.push(penEscape(pen, next, at));
        out.push(charOf(next, at));
      }
      x = end + 1;
    }
  }

  if (out.length === 0) return "";
  // Leave the terminal in a clean state. A frame that ends mid-style would tint
  // whatever is written next — including anything the app prints outside Ink.
  if (!isClean(pen)) out.push("\x1b[0m");
  return out.join("");
}
