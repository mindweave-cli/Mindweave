/**
 * overlay.ts — a hook for tinting a frame after it is built.
 *
 * The renderer's job is to put React's output on the terminal. A selection highlight is
 * not part of that output and must never become part of it: it belongs to the pointer,
 * it changes while nothing else does, and routing it through the layout would mean a
 * React render (and a chance to reflow the screen) every time the mouse moved a column.
 *
 * So it goes on afterwards. A frame is parsed into the grid as usual, and an overlay is
 * given the chance to change cells before the diff runs. Cells in, cells out; the
 * renderer never learns what a selection is, and the selection never learns what a React
 * tree is.
 *
 * The second half of the problem is that a drag produces no new frame at all. Nothing in
 * the layout changed, so Ink writes nothing, so there is no frame to tint. `onRepaint`
 * lets the owner of a selection ask for the current frame to be re-tinted and re-diffed
 * without React being involved.
 */
import type { Screen } from "./screen.js";

/** Changes cells on a built frame. Called with the frame about to be painted. */
export type FrameOverlay = (screen: Screen) => void;

let overlay: FrameOverlay | null = null;
let repaint: (() => void) | null = null;
let latest: Screen | null = null;

/**
 * Install the overlay, or clear it with null.
 *
 * While none is installed the renderer keeps no extra copy of the frame and does no extra
 * work, so the cost of this feature to a session that never drags the mouse is nothing.
 */
export function setFrameOverlay(fn: FrameOverlay | null): void {
  overlay = fn;
}

/** Whether anything wants to tint frames. Read by the renderer on the hot path. */
export function hasFrameOverlay(): boolean {
  return overlay !== null;
}

/** Run the overlay over a frame, if one is installed. */
export function applyFrameOverlay(screen: Screen): void {
  overlay?.(screen);
}

/** Called by the renderer to offer a way of re-tinting the current frame. */
export function setOverlayRepaint(fn: (() => void) | null): void {
  repaint = fn;
}

/** Re-tint and re-diff the frame already on screen. A no-op with no renderer attached. */
export function repaintOverlay(): void {
  repaint?.();
}

/** Called by the renderer with the grid that is now on the terminal. */
export function publishScreen(screen: Screen): void {
  latest = screen;
}

/**
 * The grid currently on the terminal, or null before the first frame.
 *
 * This is how a selection reads what it covers: the characters on screen are the
 * characters the user dragged across, whatever produced them.
 */
export function latestScreen(): Screen | null {
  return latest;
}
