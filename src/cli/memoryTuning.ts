/**
 * memoryTuning.ts — bias V8 toward a smaller footprint.
 *
 * A coding agent spends almost all of its time waiting: for a keystroke, for a model, for
 * a command. It is I/O-bound, not compute-bound, so the CPU that V8's speed-first defaults
 * buy is spent on nothing here, while the memory those defaults reserve is real and shows
 * up in every process listing.
 *
 * `--optimize-for-size` flips that trade: V8 prefers memory over speed in its garbage
 * collection and code-generation heuristics from this point on. It is applied at runtime
 * rather than as a launch flag on purpose — the alternative is re-executing the process
 * with the flag set, and re-exec on a program that owns a terminal is a real hazard (the
 * child inherits a raw-mode stdin and an alternate screen mid-handoff). Setting it in
 * process is the same effect without that risk.
 *
 * Gated by an env var so a machine that would rather have the speed can opt out, and so a
 * measurement can compare the two without editing code.
 */
import { setFlagsFromString } from "node:v8";

/** Apply the footprint bias unless `MINDWEAVE_NO_MEM_TUNING` is set. Best-effort. */
export function tuneMemory(): void {
  if (process.env["MINDWEAVE_NO_MEM_TUNING"]) return;
  try {
    setFlagsFromString("--optimize-for-size");
  } catch {
    // A build of Node that does not accept the flag at runtime; nothing to do.
  }
}
