/**
 * caretPark.ts — put the TERMINAL's own cursor where the text caret belongs.
 *
 * A caret drawn by the app has to live in a cell, because a terminal grid has no room
 * between two of them. Every version of that is wrong in some way: standing ON a character
 * hides it for half of each blink, and taking a column of its own opens a gap between the
 * letters it sits between. The gap is what a real text field never has.
 *
 * The terminal's own cursor has no such problem — it is drawn BETWEEN cells by the
 * terminal itself, costs no column, and blinks (or does not) according to the settings the
 * user already chose. So nothing is drawn here. After each frame the cursor is parked at
 * the right cell and shown.
 *
 * Two things fall out of that for free: an IME renders its preedit text at the physical
 * cursor, so CJK input appears inline instead of somewhere else on screen; and screen
 * readers and magnifiers follow the native cursor, so they follow the caret.
 *
 * ## Why the position comes from LAYOUT, not from the painted text
 *
 * The first version of this found the caret's row by searching the painted screen for the
 * row's text. It worked until it did not: a row ending in a space is painted against a
 * background of padding spaces, a row wider than the box is painted truncated, and in
 * either case the search fails and the cursor is dropped. Typing a space made the caret
 * vanish until the next keystroke — a bug that only exists because the position was being
 * inferred from pixels rather than known.
 *
 * The layout already knows. Ink measures every node, and `measureElement` reports a node's
 * position within the live region — which is the whole screen here, since the transcript
 * is re-rendered each frame and nothing is in a Static region. So the input declares the
 * BOX its caret sits in, and the column within it, and the answer is read from the layout
 * at paint time. Nothing to match, nothing to fail.
 */
import { measureElement, type DOMElement } from "ink";

/** Where the caret belongs: a node whose position the layout knows, and a column into it. */
export interface CaretDeclaration {
  /**
   * A REF to the box holding the caret row, not the node itself.
   *
   * Resolved at paint time, which is the only moment both facts are true at once: the
   * ref has been attached (React attaches refs during the mutation phase) and yoga has
   * computed the layout. Holding the node instead means holding whatever was current
   * when the declaration was made, which is one render out of date.
   */
  ref: { current: DOMElement | null };
  /** How many characters into the row the caret sits. */
  column: number;
}

let declared: CaretDeclaration | null = null;
let onMoved: (() => void) | null = null;

/**
 * Called when the caret moves, so the renderer can park it even if NO FRAME is written.
 *
 * This is the whole reason it exists. Ink does not write a frame when its output is
 * unchanged, and typing a space at the end of a line produces an identical frame —
 * trailing blanks are indistinguishable from the padding already there. So the one thing
 * that DID change, the cursor, never reached the terminal, and the caret sat a character
 * behind until the after-burst repaint fired four hundred milliseconds later. That pause
 * is the whole bug: everything else was already correct.
 */
export function onCaretMoved(fn: (() => void) | null): void {
  onMoved = fn;
}

/**
 * Declare the caret, or clear it with null.
 *
 * Cleared whenever the input is not the thing being typed into — an open picker, a turn in
 * flight with no prompt — so the cursor is not left parked in a box nobody is using.
 */
export function declareCaret(caret: CaretDeclaration | null): void {
  const moved = caret?.column !== declared?.column || caret?.ref !== declared?.ref;
  declared = caret;
  if (moved) onMoved?.();
}

export function caretDeclaration(): CaretDeclaration | null {
  return declared;
}

/**
 * The screen cell the caret sits on, or null when there is nothing to park.
 *
 * Read at PAINT time, which is after layout, so the measurements are the ones the frame
 * about to be written was built from. Null is a real answer and the caller must respect
 * it: parking at a guess puts a visible cursor somewhere the user is not typing.
 */
export function caretCell(caret: CaretDeclaration | null = declared): { x: number; y: number } | null {
  if (!caret?.ref.current) return null;
  try {
    const box = measureElement(caret.ref.current);
    // A node that has never been laid out measures as nothing. Parking inside a
    // zero-width box would put the cursor at the top-left corner of the screen.
    if (box.width === 0 && box.height === 0) return null;
    const column = Math.max(0, Math.min(caret.column, Math.max(0, box.width - 1)));
    return { x: box.x + column, y: box.y };
  } catch {
    // The node was unmounted between the declaration and the paint.
    return null;
  }
}

/** Move the terminal cursor to a cell and show it. Coordinates are 1-based on the wire. */
export function parkAt(cell: { x: number; y: number }): string {
  return `\x1b[${cell.y + 1};${cell.x + 1}H\x1b[?25h`;
}

/** Hide the cursor, for the span of a paint and for frames with no caret on screen. */
export const HIDE = "\x1b[?25l";
