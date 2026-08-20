/**
 * writer.ts — sits between Ink and the terminal, and writes only what changed.
 *
 * Ink's contract with the terminal is "erase everything I drew last time, then draw
 * all of it again", on every render. That is tens of kilobytes per frame on a large
 * terminal, pushed through a write that blocks the event loop on Windows — which is
 * why typing and scrolling lag in proportion to how much is on screen rather than
 * how much actually changed.
 *
 * This replaces that contract with a framebuffer:
 *
 *     Ink renders a frame  ->  parse it into a cell grid  ->  diff against the grid
 *     already on screen  ->  emit only the cells that differ  ->  keep the new grid
 *
 * Ink is untouched, and so is every component. The interception is a PROXY STDOUT
 * handed to `render()`, not a patch of `process.stdout`: everything arriving here is
 * therefore known to be Ink's renderer output, where a global patch would also catch
 * unrelated writes and have to guess which was which.
 *
 * ## What is passed through untouched
 *
 * Only frame CONTENT can be diffed. Control sequences that are not a frame — entering
 * the alternate screen, hiding the cursor, the synchronized-update markers Ink wraps
 * frames in — carry no cells and are forwarded exactly as sent. The test is whether a
 * write contains anything printable once its escape sequences are removed.
 */
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";
import { paint } from "./paint.js";

/**
 * The prefix Ink puts before a frame to remove the previous one:
 * `\x1b[2K` (erase line) and `\x1b[1A` (cursor up) repeated, then `\x1b[G`.
 *
 * We drop it. The whole point of the framebuffer is that the previous frame is NOT
 * erased — the parts of it that are still correct stay on screen untouched, which is
 * exactly the work being saved.
 */
const ERASE_PREFIX = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

/** Any escape sequence, for deciding whether a write carries visible content. */
const ANY_ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z]|\x1b./g;

/** A stream Ink can render into. Structural, so the real `process.stdout` satisfies it. */
export interface OutputStream {
  columns?: number;
  rows?: number;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** How the framebuffer performed, for the perf log. */
export interface FrameStats {
  /** Bytes Ink asked to write. */
  inBytes: number;
  /** Bytes actually sent to the terminal. */
  outBytes: number;
}

/**
 * Wrap `real` so Ink's frames are diffed before they reach it.
 *
 * `onFrame` is called after each frame with what it cost, so the perf log can report
 * the saving without this module knowing anything about logging.
 */
export function framebufferStdout<T extends OutputStream>(real: T, onFrame?: (stats: FrameStats) => void): T {
  // The grid currently on the terminal, and the one being built for this frame. Two
  // long-lived buffers, swapped — never reallocated per frame, which is the whole
  // reason the cell data is in typed arrays.
  let onScreen = new Screen(real.columns ?? 80, real.rows ?? 24);
  let pending = new Screen(onScreen.width, onScreen.height);

  /**
   * Match the grids to the terminal. Returns true when the size changed, which the
   * caller must answer by erasing the real screen before it paints.
   *
   * The erase is the whole point and it used to be missing. Resizing reset `onScreen`
   * to blanks, on the reasoning that a blank model would make every cell differ and
   * force a full repaint. It does the opposite: the new frame's blank regions are also
   * blanks, so the diff finds them identical and writes nothing for them, while the real
   * terminal still holds whatever was in those cells before. That is what fused an old
   * line onto a new one, leaving rows like `Tools(session)s, ask_user, create_skill,`.
   *
   * Erasing for real is also the cheap fix rather than the expensive one. Filling the
   * model with a sentinel no cell can equal would work too, and would then write every
   * space on screen as an explicit character. One escape sequence costs four bytes and
   * leaves the diff free to stay minimal for the frame itself.
   */
  function syncSize(): boolean {
    const w = real.columns ?? onScreen.width;
    const h = real.rows ?? onScreen.height;
    if (w === onScreen.width && h === onScreen.height) return false;
    onScreen.resize(w, h);
    pending.resize(w, h);
    // Now TRUE rather than assumed: the model says blank, and the caller is about to
    // make the terminal blank to match.
    onScreen.clear();
    return true;
  }

  /**
   * Replaces `write` and nothing else.
   *
   * A hand-written object listing the members Ink "needs" was tried first and BROKE
   * THE APP: Ink reads `stdout.isTTY` in five places to decide whether it is driving
   * a terminal at all, the substitute did not have it, and Ink quietly took its
   * non-interactive path — a blank screen, no error. The tests did not catch it
   * because they pass a fake stdout that has no `isTTY` either, so both sides agreed
   * on the wrong thing.
   *
   * A Proxy is the fix that cannot have that class of bug again: every property, every
   * method, the prototype and `instanceof` all still resolve to the real stream, and
   * only `write` is ours. Nothing has to be enumerated, so nothing can be forgotten.
   */
  const fbWrite = (data: string, callback?: (err?: Error | null) => void): boolean => {
      const body = data.replace(ERASE_PREFIX, "");

      // No printable content: a control sequence, not a frame. Forward verbatim —
      // these are how the alternate screen is entered, the cursor hidden, and frames
      // wrapped in synchronized-update markers, none of which we may swallow.
      if (body.replace(ANY_ESCAPE, "").trim() === "") {
        return real.write(data, callback);
      }

      const resized = syncSize();

      // Build the new frame. Cleared first because a frame is a complete statement
      // about the rows it covers: a line that got shorter must leave blanks behind,
      // not the tail of what used to be there.
      pending.clear();
      parseFrame(pending, body);

      // `[2J` erases the display, `[H` homes the cursor. Sent only on a resize,
      // to bring the real screen into line with the freshly blanked model above.
      const escape = (resized ? "[2J[H" : "") + paint(onScreen, pending, 1);

      // Swap rather than copy. Both grids are the same shape and `pending` is fully
      // rewritten at the start of every frame, so the old on-screen grid is free to
      // become the next scratch buffer — no allocation, no memcpy.
      const previous = onScreen;
      onScreen = pending;
      pending = previous;

      onFrame?.({ inBytes: data.length, outBytes: escape.length });

      if (escape === "") {
        // Nothing changed. Writing zero bytes is the correct output, but the caller
        // may be waiting on the callback, so it still has to be settled.
        callback?.(null);
        return true;
      }
      return real.write(escape, callback);
  };

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "write") return fbWrite;
      const value = Reflect.get(target, prop, target);
      // Methods are bound to the REAL stream, not to the proxy. A stream's own
      // methods reach into its internal state, and calling them with the proxy as
      // `this` would have them look for that state on the wrong object.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
