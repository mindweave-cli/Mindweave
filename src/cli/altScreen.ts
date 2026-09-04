/**
 * altScreen.ts — enter/exit the terminal's alternate screen buffer by hand.
 *
 * Ink has an `alternateScreen` render option, but the sequences are owned here instead:
 * they have to be paired with the wheel-reporting teardown and written from signal
 * handlers Ink knows nothing about, so a second owner of the same modes would only
 * create a way for the two to disagree. They are three lines and stable across every
 * VT100-descended terminal.
 *
 * Must always be paired with `exitAltScreen()` before the process actually dies, or the
 * user's shell is left showing a blank alternate-screen buffer. Covers the ways this
 * process ends that still run code: a clean exit, a signal (Ctrl+C, kill, or the
 * terminal window closing), and an uncaught exception — each calls the same idempotent
 * restore.
 *
 * The ways it ends that do NOT run code — a V8 fatal out-of-memory, SIGKILL, a
 * force-quit — cannot be covered from in here at all. That is what
 * `mindweave --reset-terminal` is for; see `terminalRestore.ts`.
 */
import { TERMINAL_RESTORE } from "./terminalRestore.js";

const ENTER = "\x1b[?1049h";
const HIDE_CURSOR = "\x1b[?25l";

/**
 * Autowrap off (DECAWM).
 *
 * With it on, a row one column too long does not fail visibly — the terminal quietly
 * continues it on the next row and pushes everything below it down, and on the bottom
 * row it scrolls the whole screen. The renderer addresses the terminal as a fixed grid
 * and writes only the cells it believes changed (see `framebuffer/`), so a row that
 * moved is a row nothing will ever correct: the text stays on screen, in the wrong
 * place, for the rest of the session.
 *
 * Off, an over-long row is clipped at the right margin instead. Losing a character at
 * the edge is a visible, local, self-correcting fault; a wrap is an invisible one that
 * spreads. The layout still aims to fit every row, and this is what makes a miss cost
 * one character rather than the screen.
 */
const AUTOWRAP_OFF = "\x1b[?7l";

let active = false;

/** Switches to the alternate screen and registers the restore-on-exit hooks.
 *  No-op outside a real TTY (piped output, CI) — same rule Ink itself uses
 *  for every terminal-control feature. */
export function enterAltScreen(): void {
  if (active || !process.stdout.isTTY) return;
  active = true;
  process.stdout.write(ENTER + HIDE_CURSOR + AUTOWRAP_OFF);
  process.on("exit", exitAltScreen);
  process.on("SIGINT", () => {
    exitAltScreen();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    exitAltScreen();
    process.exit(143);
  });
  // The terminal window being closed. Node raises this on Windows too, and without a
  // listener the default action kills the process outright, skipping the restore — which
  // matters because the same terminal program is usually reopened onto the same profile.
  process.on("SIGHUP", () => {
    exitAltScreen();
    process.exit(129);
  });
  process.on("uncaughtException", (err) => {
    exitAltScreen();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

/** Restores the primary screen buffer, the cursor, and wheel reporting. Idempotent —
 *  safe to call from multiple exit paths without double-writing escape codes.
 *
 *  Wheel reporting is turned on separately (see mouse.ts) and has its own cleanup on
 *  unmount, but a signal or a crash skips React entirely, so it is turned off here
 *  unconditionally rather than being left to a component that may never unmount. */
export function exitAltScreen(): void {
  if (!active) return;
  active = false;
  process.stdout.write(TERMINAL_RESTORE);
}
