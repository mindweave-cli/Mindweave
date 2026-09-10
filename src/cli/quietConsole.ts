/**
 * quietConsole.ts — nothing but the renderer writes to the screen while the UI is up.
 *
 * A full-screen terminal app owns every cell of the terminal, and the framebuffer owns
 * the record of what is in them. Anything that prints outside that record — a dependency
 * logging a warning, a stray `console.log`, Node announcing a deprecation — lands on the
 * screen the renderer believes it already knows, and at the bottom row it SCROLLS: every
 * row moves up one, and the model now describes a screen that no longer exists.
 *
 * What that looks like is a single character stranded in the middle of an unrelated line,
 * because a scrolled row is only visible where the new content is shorter than the old.
 * A tool row reading `● Tools(sessions)` picks up the last surviving letter of whatever
 * used to be above it.
 *
 * Ink's own answer, `patchConsole`, is worse rather than better: it routes console output
 * INTO the frame stream, where the framebuffer parses it as a frame and writes the foreign
 * text into the model itself. A wrong cell in the model is never revisited, because as far
 * as a diff can see nothing about it changed, so that one survives every later frame.
 * Written straight to the terminal it at least heals on the next full repaint.
 *
 * So neither: while the UI is mounted the console goes nowhere. Errors reach the user
 * through the app's own surfaces, which can render them where they belong.
 */

/** The methods that print. `assert` and `trace` print too, and both go through `error`. */
const SILENCED = ["log", "info", "warn", "error", "debug", "trace", "dir", "table", "group", "groupEnd"] as const;

type Silenced = (typeof SILENCED)[number];

/**
 * Silence the console, returning a function that puts it back.
 *
 * Restoring matters as much as silencing: `/update` hands the terminal over to an
 * installer after the UI unmounts, and a crash report is printed after the alternate
 * screen has been left. Both need a console again.
 */
export function silenceConsole(target: Partial<Record<Silenced, unknown>> = console): () => void {
  const saved = new Map<Silenced, unknown>();
  for (const name of SILENCED) {
    if (typeof target[name] !== "function") continue;
    saved.set(name, target[name]);
    target[name] = () => {};
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, fn] of saved) target[name] = fn;
  };
}
