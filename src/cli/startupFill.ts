/**
 * startupFill.ts — how many blank rows the inline shell prints above its first screen.
 *
 * The inline shell prints into the terminal's own scrollback, top to bottom, and the
 * prompt is simply the last thing printed. On a fresh or short session that leaves the
 * prompt floating part-way up the window with empty rows below it, because a terminal
 * puts the cursor wherever printing ended and draws nothing under it. A run of blank rows
 * printed ABOVE the conversation pushes the whole thing down so the footer lands at the
 * bottom edge.
 *
 * Those blank rows go into `<Static>`, which prints each item exactly once — so the
 * fill's height is fixed the moment it is first printed and cannot change for that mount.
 * That is the trap this module exists to handle: the first render often runs before the
 * real terminal height is known (the size hook re-reads a moment later), so a fill sized
 * then is frozen too small, and the band of empty screen it was meant to remove stays at
 * the bottom until something forces a reprint.
 *
 * The rule is therefore not "size it once" but "grow it whenever the terminal turns out
 * taller than the fill assumed", remounting `<Static>` so the recent conversation is
 * reprinted with the footer back at the edge. Growing only, never shrinking: once the
 * conversation overflows the screen the footer sits at the bottom on its own, and
 * shrinking the fill then would reprint on every small drag for a void that is not there.
 */

/** Rows the live region occupies at rest: the blank separator, the input box, the tip. */
export const INLINE_LIVE_RESERVE = 5;

/** The fill's current height, and the terminal height it was sized against. */
export interface FillState {
  /** Blank rows printed above the first screen. */
  fill: number;
  /** The `rows` value `fill` was computed from. Zero before the first sizing. */
  basis: number;
}

/** The starting state, before anything has been sized. */
export const NO_FILL: FillState = { fill: 0, basis: 0 };

/** What a resize did to the fill, and whether `<Static>` has to be remounted for it. */
export interface FillDecision extends FillState {
  /**
   * True when the fill changed on a mount that has ALREADY printed, so the blank rows
   * only reach the screen if `<Static>` is remounted. False on the very first sizing —
   * nothing is on screen yet, and the first frame carries the new fill anyway.
   */
  remount: boolean;
}

/**
 * Decide the fill for this render (pure).
 *
 * Grows the fill when `rows` exceeds the height it was last sized for — the settle after
 * a wrong first read, or a window dragged taller — and leaves it alone otherwise. A
 * shorter terminal is deliberately ignored: the conversation already reaches the bottom
 * there, so the fill is moot and reprinting would be churn.
 *
 * @param reserve rows to leave for the live region; defaults to `INLINE_LIVE_RESERVE`.
 */
export function growFill(prev: FillState, rows: number, reserve = INLINE_LIVE_RESERVE): FillDecision {
  if (rows <= prev.basis) return { ...prev, remount: false };
  return {
    fill: Math.max(0, rows - reserve),
    basis: rows,
    // The first sizing (nothing printed yet) does not need a remount; a later grow does.
    remount: prev.basis !== 0,
  };
}
