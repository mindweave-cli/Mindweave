/**
 * screenShell.ts — putting the terminal into one shell or the other.
 *
 * `screenMode.ts` decides WHICH; this does it. Three things move together and the order
 * they move in is the whole content of this file, because getting it wrong leaves the
 * terminal in a state that is neither shell: the alternate screen buffer, mouse
 * reporting, and whether the framebuffer is diffing frames or standing aside.
 *
 * ## Going inline, the framebuffer stands down FIRST
 *
 * It is the thing between Ink and the terminal. While it is still diffing, every write
 * is being reinterpreted as a full-screen frame — including the escape that leaves the
 * alternate screen. Standing it down first means everything after this point reaches the
 * terminal exactly as Ink wrote it, which is what the inline shell needs and what the
 * leave sequence itself needs.
 *
 * ## Coming back, it goes up LAST
 *
 * For the mirror reason. The screen has to be the alternate buffer, and the cursor and
 * autowrap have to be set, before anything starts diffing against a model of them.
 * Switching it on also throws that model away (see `setFramebufferEnabled`), because
 * while it was off the terminal was scrolling on its own and nothing the model remembers
 * is still true.
 *
 * ## Mouse reporting is not optional either way
 *
 * On, a terminal sends a report for every movement while a button is held. Nothing reads
 * them in the inline shell, so they arrive at the input as text: the stray letters and
 * digits that a mouse press used to leave in the prompt. Off is not a tidy-up, it is
 * what stops the pointer typing.
 */
import { setAltScreen, setCursorVisible } from "./altScreen.js";
import { setFramebufferEnabled } from "./framebuffer/writer.js";
import { enableMouse } from "./mouse.js";
import type { ScreenMode } from "./screenMode.js";

/** Turns mouse reporting off again. Null when it is already off. */
let mouseOff: (() => void) | null = null;

/**
 * Put the terminal into `mode`. Safe to call with the mode it is already in.
 *
 * `enableMouse` is injected so a test can drive the sequence without a terminal; the
 * default is the real one.
 */
export function applyScreenMode(
  mode: ScreenMode,
  deps: {
    setAltScreen?: (on: boolean) => void;
    setFramebufferEnabled?: (on: boolean) => void;
    enableMouse?: () => () => void;
    setCursorVisible?: (on: boolean) => void;
  } = {},
): void {
  const alt = deps.setAltScreen ?? setAltScreen;
  const framebuffer = deps.setFramebufferEnabled ?? setFramebufferEnabled;
  const mouse = deps.enableMouse ?? enableMouse;
  const cursor = deps.setCursorVisible ?? setCursorVisible;

  if (mode === "inline") {
    framebuffer(false);
    mouseOff?.();
    mouseOff = null;
    alt(false);
    // Leaving the alternate screen restores the cursor, and the inline shell does not
    // want it: it draws its own caret in the input, and the real one would sit below
    // everything as a second one. After the leave, or the restore would undo this.
    cursor(false);
    return;
  }

  alt(true);
  mouseOff ??= mouse();
  framebuffer(true);
}

/** Forget any mouse subscription, for a test that runs the sequence more than once. */
export function resetScreenShell(): void {
  mouseOff = null;
}
