/**
 * altScreen.ts — enter/exit the terminal's alternate screen buffer by hand.
 *
 * The installed Ink version (5.2.1) has no built-in `alternateScreen` render
 * option (that landed in Ink 7, which needs React 19 — a two-major-version
 * bump we're not taking just for this). The escape sequences themselves are
 * three lines and stable across every VT100-descended terminal, so we own
 * them directly instead.
 *
 * Must always be paired with `exitAltScreen()` before the process actually
 * dies, or the user's shell is left showing a blank alternate-screen buffer.
 * Covers the three ways this process ends: a clean exit, a signal (Ctrl+C /
 * kill), and an uncaught exception — each calls the same idempotent restore.
 */
const ENTER = "[?1049h";
const EXIT = "[?1049l";
const HIDE_CURSOR = "[?25l";
const SHOW_CURSOR = "[?25h";
// Wheel reporting is turned on while the app runs (see mouse.ts). Its own
// cleanup runs on unmount, but a signal or a crash skips React entirely — and a
// terminal left reporting mouse events spews escape codes into the next shell
// prompt, so the restore path below turns it off unconditionally.
const MOUSE_OFF = "[?1006l[?1000l";

let active = false;

/** Switches to the alternate screen and registers the restore-on-exit hooks.
 *  No-op outside a real TTY (piped output, CI) — same rule Ink itself uses
 *  for every terminal-control feature. */
export function enterAltScreen(): void {
  if (active || !process.stdout.isTTY) return;
  active = true;
  process.stdout.write(ENTER + HIDE_CURSOR);
  process.on("exit", exitAltScreen);
  process.on("SIGINT", () => {
    exitAltScreen();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    exitAltScreen();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    exitAltScreen();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

/** Restores the primary screen buffer and the cursor. Idempotent — safe to
 *  call from multiple exit paths without double-writing escape codes. */
export function exitAltScreen(): void {
  if (!active) return;
  active = false;
  process.stdout.write(MOUSE_OFF + EXIT + SHOW_CURSOR);
}
