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
 * ## Why it also writes the whole screen from time to time
 *
 * Diffing against a model of the terminal is only correct while the model is right, and
 * a wrong cell is never revisited, because as far as a diff can see nothing about it
 * changed. So the model is thrown away and the screen written in full on a schedule —
 * see `invalidate()`. That is what keeps a single stray row from becoming a session of
 * interleaved text, and it costs one Ink-sized frame every few seconds.
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

/**
 * How long the model and the real terminal may disagree during continuous work, in
 * milliseconds.
 *
 * Writing every cell costs about what Ink's own renderer cost on EVERY frame, so paying
 * it once every few seconds gives back almost none of the saving and puts a ceiling on
 * how wrong the screen can get. `0` writes in full every frame, which is Ink's original
 * behaviour and the thing to compare against when this is suspected.
 *
 * Read per wrapper rather than once at module load, so it is a property of the stream
 * being wrapped instead of of whichever import happened first.
 */
function fullRepaintMs(): number {
  const raw = Number(process.env["MINDWEAVE_FB_REPAINT_MS"]);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4000;
}

/**
 * How long after the last frame of a burst the screen is written in full.
 *
 * Short enough that a glitch is gone before it can be read, long enough that it never
 * lands mid-burst: every frame cancels and re-arms it.
 */
const IDLE_REPAINT_MS = 400;

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

  const repaintEvery = fullRepaintMs();
  /** When every cell was last written, which is what bounds how long a disagreement
   *  with the real terminal can survive. */
  let lastFull = 0;
  /** The pending after-the-burst repaint, cancelled and re-armed by each frame. */
  let idle: ReturnType<typeof setTimeout> | undefined;

  /**
   * Match the grids to the terminal. Returns true when the size changed, which the
   * caller answers with a full write.
   *
   * Resizing used to reset `onScreen` to blanks, on the reasoning that a blank model
   * would make every cell differ and force a full repaint. It does the opposite: the new
   * frame's blank regions are also blanks, so the diff finds them identical and writes
   * nothing for them, while the real terminal still holds whatever was in those cells
   * before. That is what fused an old line onto a new one, leaving rows like
   * `Tools(session)s, ask_user, create_skill,`.
   */
  function syncSize(): boolean {
    const w = real.columns ?? onScreen.width;
    const h = real.rows ?? onScreen.height;
    if (w === onScreen.width && h === onScreen.height) return false;
    onScreen.resize(w, h);
    pending.resize(w, h);
    return true;
  }

  /**
   * Forget what is on the terminal, so the next paint writes every cell.
   *
   * THIS IS THE RENDERER'S ONLY WAY BACK, and it is the reason the rest of the file is
   * safe. Everything here writes just the cells that changed between two frames, which
   * is correct exactly as long as the model and the terminal agree. When they stop
   * agreeing the error is PERMANENT: a cell the model has right but the terminal has
   * wrong is never rewritten, because as far as the diff can see nothing about it
   * changed. One stray row is enough to end a long session in interleaved text.
   *
   * There are several ways to lose that agreement — a row the terminal wrapped, a scroll
   * it performed, a write from outside this proxy — and no way to detect any of them
   * from in here. So this does not try to detect them. It gives a disagreement a
   * LIFETIME instead: on a resize, once every `FULL_REPAINT_MS` of continuous work, and
   * `IDLE_REPAINT_MS` after the last frame of a burst.
   *
   * Sentinel rather than an erase sequence. Filling the previous grid with a value no
   * real cell can equal makes every cell differ, so the paint that follows covers the
   * screen on its own. Erasing first would reach the same place with a blank flash in
   * between, and would depend on the terminal's erase honouring the current background.
   */
  function invalidate(): void {
    onScreen.invalidate();
    lastFull = Date.now();
  }

  /**
   * Re-assert the model onto the terminal outside of any frame.
   *
   * `pending` is scratch between frames — every frame rewrites it from scratch before
   * reading it — so it can hold the picture while `onScreen` becomes the grid that knows
   * nothing, and the two swap back exactly as they do on a normal frame.
   */
  function repaintNow(): void {
    if (onScreen.width === 0 || onScreen.height === 0) return;
    pending.copyFrom(onScreen);
    invalidate();
    const escape = paint(onScreen, pending, 1);
    const previous = onScreen;
    onScreen = pending;
    pending = previous;
    if (escape !== "") real.write(escape);
  }

  /** Arm the after-the-burst repaint. Unref'd: a screen touch-up must never be the
   *  reason the process is still alive. */
  function armIdleRepaint(): void {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = undefined;
      repaintNow();
    }, IDLE_REPAINT_MS);
    idle.unref?.();
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

      const bare = body.replace(ANY_ESCAPE, "");
      // Nothing at all once the escapes are gone: a pure control sequence, not a frame.
      // Forward verbatim — this is how the alternate screen is entered, the cursor
      // hidden, and frames wrapped in synchronized-update markers, none of which we may
      // swallow.
      if (bare === "") return real.write(data, callback);

      // Escapes plus nothing but CONTROL characters — in practice a stray newline.
      //
      // This used to pass through with the case above, because the test trimmed before
      // asking, and a trimmed "\n" is empty. A newline is not inert: written at the
      // bottom row it SCROLLS THE WHOLE SCREEN UP ONE LINE. Every row is then somewhere
      // the model does not think it is, and since the model is the only thing that knows
      // what is on screen, nothing ever corrects it — the banner ends up half under a
      // tool row (`●MWrite(docs.html)`, the `M` being all that survived of "Mindweave").
      //
      // Swallowed rather than forwarded. Vertical position here is decided entirely by
      // the absolute cursor moves `paint` emits, so a newline arriving from outside that
      // can only move the real screen out from under the model. Tested by SPACES, not by
      // whitespace: a frame of nothing but spaces is a real frame that clears the screen,
      // and trimming would have swallowed that too.
      if (bare.replace(/[\r\n\t\v\f\b]/g, "") === "") {
        callback?.(null);
        return true;
      }

      // A resize invalidates everything, and so does simply having gone a while without
      // writing in full. Both are answered the same way: by knowing nothing about the
      // screen, so that this frame draws all of it.
      if (syncSize() || Date.now() - lastFull >= repaintEvery) invalidate();

      // Build the new frame. Cleared first because a frame is a complete statement
      // about the rows it covers: a line that got shorter must leave blanks behind,
      // not the tail of what used to be there.
      pending.clear();
      parseFrame(pending, body);

      const escape = paint(onScreen, pending, 1);

      // Swap rather than copy. Both grids are the same shape and `pending` is fully
      // rewritten at the start of every frame, so the old on-screen grid is free to
      // become the next scratch buffer — no allocation, no memcpy.
      const previous = onScreen;
      onScreen = pending;
      pending = previous;

      onFrame?.({ inBytes: data.length, outBytes: escape.length });

      // Put the screen beyond doubt once this burst of frames stops. During a burst it
      // is only ever cancelled and re-armed, so it costs nothing until things settle.
      armIdleRepaint();

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
