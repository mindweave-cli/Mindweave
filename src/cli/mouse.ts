/**
 * mouse.ts — wheel scrolling in the alternate screen.
 *
 * The alternate screen has no scrollback of its own, so the terminal's own wheel
 * does nothing: the rows on screen are all there is, and reaching for the wheel
 * to look back at what scrolled away simply does not respond. Keyboard paging is
 * not a substitute either — on Windows consoles those keys are frequently
 * consumed by the console host before the app ever sees them.
 *
 * So the app asks the terminal to report wheel events, and scrolls itself.
 *
 * The catch, and it is the whole reason `stripMouse` exists: once reporting is
 * on, those reports arrive as ordinary stdin bytes. They reach the wheel reader
 * AND Ink's key parser, which has no notion of a mouse report and passes the
 * bytes along as though they had been typed — so every scroll dumped
 * `[<64;25;26M` into the prompt. Anything reading typed input must strip them
 * first.
 *
 * The trade this makes, stated plainly: while wheel reporting is on, dragging to
 * select text is captured by the app instead of the terminal. Every terminal
 * worth using keeps selection available on Shift+drag, the same deal vim, htop,
 * and every other full-screen tool strikes.
 */

import { MOUSE_OFF } from "./terminalRestore.js";

/** Report wheel/button presses (1000) using SGR encoding (1006), the only
 *  encoding that stays correct past column 223. */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";

/**
 * An SGR mouse report: `ESC [ < button ; col ; row (M|m)`.
 *
 * The ESC is optional because the same bytes reach us two ways: raw off stdin
 * with the ESC intact, and again through Ink's key parser, which strips it. Both
 * spellings have to match or the stripped one lands in the input box.
 */
const SGR = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

export type WheelDirection = "up" | "down";

/**
 * Every wheel event in a chunk of terminal input, in order (pure).
 *
 * A single flick can deliver several reports in one chunk, and each is a notch
 * the user turned — dropping the extras makes scrolling feel like it is ignoring
 * you, so they are all returned rather than collapsed.
 */
export function readWheel(data: string): WheelDirection[] {
  const out: WheelDirection[] = [];
  for (const match of data.matchAll(SGR)) {
    const button = Number(match[1]);
    // Bit 6 (64) marks a wheel event; bit 0 then separates up (0) from down (1).
    if ((button & 64) === 0) continue;
    out.push((button & 1) === 0 ? "up" : "down");
  }
  return out;
}

/**
 * The same input with every mouse report removed (pure).
 *
 * Used by anything that treats stdin as typed text. Also drops a trailing
 * fragment of a report — a chunk boundary can split one, and half a report is
 * still not something the user typed.
 */
export function stripMouse(data: string): string {
  return data.replace(SGR, "").replace(/\x1b?\[<[\d;]*$/, "");
}

/** Turn wheel reporting on, returning a function that turns it back off.
 *  A no-op off a TTY, matching how altScreen.ts gates itself. */
export function enableMouse(): () => void {
  if (!process.stdout.isTTY) return () => {};
  process.stdout.write(MOUSE_ON);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    process.stdout.write(MOUSE_OFF);
  };
}
