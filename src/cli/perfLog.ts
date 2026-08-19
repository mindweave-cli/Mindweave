/**
 * perfLog.ts — frame timings from the REAL terminal, on the user's machine.
 *
 * Every performance number this UI has been tuned against so far came from a probe
 * writing to a fake stdout, where the terminal write costs exactly zero and Yoga runs
 * on a machine that is not the one complaining. That is how a fix got shipped twice
 * that measured beautifully and felt no different: the probe could not see the part
 * that was slow.
 *
 * So this writes what actually happened, to a file, from the running app:
 *
 *   - how long the terminal took to accept each write, and how big it was
 *   - how many blocks exist versus how many were handed to the renderer, which is the
 *     one fact that says whether virtualization is engaging at all
 *   - the gap between frames, which is what the user actually perceives as lag
 *
 * Off unless `MINDWEAVE_PERF` is set, and when off it costs one boolean read per frame
 * and touches nothing else. It must never write to stdout: this is an alt-screen TUI,
 * and a stray line would corrupt the frame it is trying to measure.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PATH = process.env.MINDWEAVE_PERF ?? "";
const ON = PATH !== "" && PATH !== "0";

/** Whether frame instrumentation is on. */
export function perfEnabled(): boolean {
  return ON;
}

let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Record one line. Buffered and flushed on a timer rather than written immediately —
 * a synchronous file write per frame would itself become the slowest thing in the
 * frame, and an instrument that changes what it measures is worse than none.
 */
export function perf(line: string): void {
  if (!ON) return;
  buffer.push(`${Date.now()} ${line}`);
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1000);
  flushTimer.unref?.();
}

/** Write everything buffered so far. Safe to call when there is nothing to write. */
export function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!ON || buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    appendFileSync(PATH, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // An instrument must never take the app down with it.
  }
}

/**
 * Wrap `stdout.write` so every frame the renderer emits is timed and sized.
 *
 * This is the measurement that no probe could make. Ink erases and rewrites the drawn
 * region on every state change, and how long the terminal takes to accept that is a
 * property of the terminal — conhost, Windows Terminal, VS Code's, WSL — not of the
 * code. If this number is large, no amount of layout work will fix the lag and the
 * answer is to write less, less often.
 */
export function instrumentStdout(stream: NodeJS.WriteStream): void {
  if (!ON) return;
  const original = stream.write.bind(stream);
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = (chunk: any, ...rest: any[]) => {
    const t0 = performance.now();
    const result = original(chunk, ...rest);
    const ms = performance.now() - t0;
    const size = typeof chunk === "string" ? chunk.length : (chunk?.length ?? 0);
    // Only the frames worth looking at. A TUI emits many tiny cursor moves and
    // logging every one buries the writes that actually cost something.
    if (size > 200 || ms > 1) perf(`write bytes=${size} ms=${ms.toFixed(2)} n=${++n}`);
    return result;
  };
}
