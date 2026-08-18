/**
 * extractWorker.ts — the other side of isolation.ts.
 *
 * Runs as a forked CHILD PROCESS and calls the same treesitter entry points the host
 * does; the MINDWEAVE_TS_IN_WORKER env flag (set by the host at spawn) is what stops
 * those entry points from routing back into isolation — in here, "heavy" grammars run
 * in-process, which is the entire point: when one of them dies, it dies over here.
 *
 * ── WHY A PROCESS AND NOT A WORKER THREAD ───────────────────────────────────────
 *
 * This was a worker_thread first, and that could not work. The failure being contained
 * is a V8 **Zone** allocation failure, and V8 handles that by calling
 * `FatalProcessOutOfMemory`, which aborts the PROCESS. A worker thread shares the
 * process, so the abort took the host down anyway — measured: parsing two lines of
 * OCaml through the worker returned a correct result and then killed the host with
 * exit code 3, in the compiled build, with no teardown requested.
 *
 * `resourceLimits` do not help, because they bound the JS heap and the code range, and
 * a Zone is neither. That is also why the old "reproduction" case looked contained: an
 * 8 MB heap limit produces a *heap* OOM, which really is thread-local and really does
 * terminate just the worker. The two failures look alike in a stack trace and behave
 * completely differently.
 *
 * A separate process is the only boundary V8's fatal handler cannot cross.
 *
 * Protocol: { id, op: "extract" | "span", ...args } in, { id, result } out, over the
 * fork IPC channel. Any error is a null result — the caller's contract for the
 * fallback tier.
 */
import { treeSitterExtract, treeSitterSpan } from "./treesitter.js";
import { extractMarkup } from "./markup.js";

type Msg =
  | { id: number; op: "extract"; absPath: string; code: string }
  | { id: number; op: "markup"; absPath: string; code: string }
  | { id: number; op: "span"; absPath: string; code: string; name: string; nearLine?: number };

if (!process.send) throw new Error("extractWorker must run as a forked child process");

process.on("message", async (msg: Msg) => {
  let result: unknown = null;
  try {
    if (msg.op === "extract") {
      result = await treeSitterExtract(msg.absPath, msg.code);
    } else if (msg.op === "markup") {
      // The markup tier walks the tree itself, so it runs whole over here — only its
      // finished defs/refs travel back. A live tree cannot cross the channel.
      result = await extractMarkup(msg.absPath, msg.code);
    } else if (msg.op === "span") {
      result = await treeSitterSpan(msg.absPath, msg.code, msg.name, msg.nearLine);
    }
  } catch {
    result = null;
  }
  // The channel can be gone if the host gave up on us mid-parse; that is its right,
  // and there is nobody left to tell.
  try {
    // RSS rides along with every reply. The host bounds this process's memory but
    // cannot observe it from outside, and the thing being bounded is WASM memory that
    // no host-side proxy tracks — so the measurement has to be taken here, after the
    // work, and reported. See workerRssMb in isolation.ts.
    process.send!({ id: msg.id, result, rss: process.memoryUsage().rss });
  } catch {
    // Nothing to do — the host has already moved on.
  }
});
