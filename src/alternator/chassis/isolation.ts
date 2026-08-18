/**
 * isolation.ts — run oversized tree-sitter grammars where they cannot kill us.
 *
 * The OCaml grammar's parser tables are large enough that compiling its WASM can
 * fail V8's internal zone allocation — `Fatal process out of memory: Zone` — and
 * that failure is not an exception: it takes the whole process down. The suite
 * previously CONTAINED this with heap headroom (--max-old-space-size) and test
 * sequencing, which protects the test runner and does nothing for a user whose
 * repository simply contains .ml files. objc's grammar is half again bigger, so
 * the same fuse is lit under a language nobody has tripped yet.
 *
 * The cure is isolation, not headroom: grammars past a size threshold are loaded and
 * parsed inside a separate CHILD PROCESS. When one dies, the extraction call resolves
 * to null, which is already the contract every caller handles (tree-sitter is the
 * fallback tier; null means "defer to grep/read"). A crash that used to be fatal
 * becomes a degraded answer.
 *
 * ── WHY A PROCESS, NOT A WORKER THREAD ──────────────────────────────────────────
 *
 * This was a worker_thread with `resourceLimits`, on the reasoning that V8 terminates
 * a worker which exceeds them and leaves the host untouched. That reasoning is right
 * for the wrong failure. MEASURED, in the compiled build, with no teardown requested:
 * parsing two lines of OCaml returned a CORRECT result and then killed the host with
 * exit code 3.
 *
 * The distinction that matters is which allocator runs out:
 *   - a JS HEAP overrun is thread-local; V8 kills the worker cleanly
 *     (`ERR_WORKER_OUT_OF_MEMORY`) and the host carries on. This is what the old
 *     "reproduction" test exercised by shrinking the heap to 8 MB, which is why the
 *     containment looked like it worked.
 *   - a ZONE overrun — the arena V8 uses while compiling — calls
 *     `FatalProcessOutOfMemory`, which ABORTS THE PROCESS. It is not thread-local and
 *     `resourceLimits` do not govern it, because a Zone is neither the heap nor the
 *     code range.
 *
 * The OCaml grammar hits the second one. A thread shares the process with its host, so
 * no thread-level mechanism can contain a process-level abort; a separate process is
 * the only boundary V8's fatal handler cannot cross. Verified by construction: the
 * child aborting is now an ordinary non-zero exit that this module observes.
 *
 * Mechanics worth knowing:
 *   - The child imports treesitter.ts itself and calls the SAME entry points; an env
 *     flag stops it recursing into isolation. No extraction logic is duplicated.
 *   - One child serves all heavy grammars, spawned on first need, respawned after a
 *     crash a bounded number of times. A grammar in flight when the child dies is
 *     POISONED: further requests for it return null immediately rather than
 *     re-crashing a fresh child on the same input forever.
 *   - Requests carry a deadline. A wedged child (stuck, not crashed) is killed and
 *     treated exactly like a crash. The host never waits on it unboundedly.
 *   - The child's stdio is discarded. When it dies it prints a V8 crash dump, and that
 *     is our normal degraded path — not something to spray across the user's terminal.
 *
 * Everything configurable reads the environment at spawn/call time, so tests can shrink
 * the limits to reproduce the original crash condition and prove the host survives it.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Extraction } from "./treesitter.js";
import type { LineSpan } from "../../tools/spanCore.js";

/** Set in the child by the host at spawn. It is what stops the entry points the child
 *  calls from routing straight back out into isolation. */
export const IN_WORKER = process.env.MINDWEAVE_TS_IN_WORKER === "1";

/** Child heap ceiling. Generous for one grammar + one file; small enough that a
 *  pathological compile dies over there instead of paging the machine. Secondary to
 *  the process boundary itself, which is what actually contains a Zone abort. */
function workerHeapMb(): number {
  return envInt("MINDWEAVE_TS_WORKER_HEAP_MB", 768);
}
/**
 * Retire the worker once its RSS passes this, and start a fresh one on the next call.
 *
 * This is the containment that matters in practice, and it exists because of a
 * measurement, not a theory: `parse()` followed by `tree.delete()` retains memory that
 * never comes back. On a 54 KB JSX-heavy file that is ~57-70 MB PER PARSE, and it is
 * WASM linear memory, which by specification can grow and never shrink. Indexing 120
 * ordinary source files (960 KB in total) peaked at 1.9 GB.
 *
 * There is no version of this we can fix upstream today: the current runtime is pinned
 * to `web-tree-sitter` 0.20.x to match `tree-sitter-wasms`' grammar ABI, and the newest
 * runtime refuses those grammars outright (verified by loading one into it).
 *
 * So memory is bounded the one way that does not depend on understanding the leak: the
 * child is watched and replaced. RSS is read in the CHILD and reported with every reply
 * — the host cannot see a child's memory, and a proxy like "bytes parsed" does not
 * track it (a clean 1.4 MB file costs 107 MB; a 54 KB JSX one costs more).
 *
 * The cost of a retirement is re-forking and recompiling the grammar wasm on the next
 * call, so this wants to be high enough not to thrash and low enough to stay far from
 * any commit limit.
 */
function workerRssMb(): number {
  return envInt("MINDWEAVE_TS_WORKER_RSS_MB", 800);
}
/** Per-request deadline. Parsing one file is fast; anything past this is wedged. */
function requestTimeoutMs(): number {
  return envInt("MINDWEAVE_TS_WORKER_TIMEOUT_MS", 15_000);
}
/** How many times a dead worker is replaced before extraction goes dark for the
 *  session. Two respawns tolerates a transient; a third death is a pattern. Reads the
 *  environment like every other limit here, so a test can shrink it far enough to
 *  actually reach exhaustion instead of asserting around it. */
function maxRespawns(): number {
  return envInt("MINDWEAVE_TS_MAX_RESPAWNS", 2);
}
/** With nothing in flight, the worker shuts itself down after this quiet period
 *  and respawns on demand. Two reasons: it returns the grammar's sizeable WASM
 *  heap when a burst of .ml work ends, and it guarantees the worker can never
 *  hold the host process open at exit — `unref()` is not sufficient under every
 *  loader (the tsx bootstrap holds a ref the parent cannot shed).
 *
 *  30 seconds, not 3: a respawn re-pays worker startup AND recompiling the
 *  grammar wasm, so a short window turns interleaved heavy/light work (the test
 *  suite is exactly this shape) into respawn thrash. Half a minute keeps bursts
 *  warm; a session that touches .ml once still gets its memory back promptly. */
function idleShutdownMs(): number {
  return envInt("MINDWEAVE_TS_WORKER_IDLE_MS", 30_000);
}
let idleTimer: NodeJS.Timeout | null = null;

function armIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker && pending.size === 0) retire(worker);
  }, idleShutdownMs());
  idleTimer.unref?.();
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

// ── the worker host ──────────────────────────────────────────────────────────
type Pending = {
  resolve: (v: unknown) => void;
  grammarFile: string;
  timer: NodeJS.Timeout;
  /** The worker this request was posted to. A dying worker sweeps ONLY its own
   *  requests — a stale exit event must never null out work on its replacement. */
  child: ChildProcess;
};

let worker: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const poisoned = new Set<string>();
let respawns = 0;
/** The worker that has crossed its memory budget, retired as soon as it goes idle.
 *  Held as the CHILD, not a boolean, so a flag raised against one worker can never
 *  retire its replacement. */
let overBudget: ChildProcess | null = null;
/** Replies served by the CURRENT worker. A worker that has done real work and then
 *  dies is a fresh incident, not a continuing crash loop — see `respawns`. */
let served = 0;
/** Replies after which the current worker counts as healthy and the crash history
 *  clears. Low, because the failure this guards against (a fatal input crashing every
 *  replacement) reproduces on the FIRST request every time. */
const HEALTHY_REPLIES = 5;

/** Visible for tests: how many workers this process has started, lost, and replaced
 *  deliberately. `retirements` is the planned kind and must never count as a crash. */
export const isolationStats = { spawns: 0, crashes: 0, retirements: 0 };

/** Shut a worker down deliberately: strip its listeners FIRST so the exit it is about
 *  to emit is not read as a crash (no respawn charged, no grammar poisoned). Shared by
 *  the idle timer and the memory budget, which differ only in what prompts them. */
function retire(w: ChildProcess): void {
  if (worker === w) worker = null;
  if (overBudget === w) overBudget = null;
  served = 0;
  w.removeAllListeners();
  w.kill();
}

/**
 * Which file the child runs, and how.
 *
 * `fork` inherits the parent's `execArgv` by default, and that one fact removes the
 * whole bootstrap this needed as a thread. Under tsx (tests, dev from source) the
 * parent already carries tsx's loader flags, so the child gets them too and resolves
 * the `.ts` entry and every transitive `.js`→`.ts` import exactly as the parent does.
 * Under the compiled build there are no extra flags and the child runs the `.js`
 * directly. No `eval` shim, no loader registration, no divergence between the two.
 */
function workerEntry(): { entry: string; execArgv: string[]; env: NodeJS.ProcessEnv } {
  const here = import.meta.url;
  const file = here.endsWith(".ts") ? "./extractWorker.ts" : "./extractWorker.js";
  return {
    entry: fileURLToPath(new URL(file, here)),
    // Bound the child's heap as a secondary guard. It is NOT what contains the Zone
    // abort — the process boundary is — but it stops a pathological compile from
    // eating the machine before it dies.
    execArgv: [...process.execArgv, `--max-old-space-size=${workerHeapMb()}`],
    env: { ...process.env, MINDWEAVE_TS_IN_WORKER: "1" },
  };
}

function ensureWorker(): ChildProcess | null {
  if (worker) return worker;
  if (respawns > maxRespawns()) return null;
  const { entry, execArgv, env } = workerEntry();
  isolationStats.spawns++;
  served = 0;
  const w = fork(entry, [], {
    execArgv,
    env,
    // Discard the child's output. A dying grammar prints a V8 crash dump, and that is
    // this module's ordinary degraded path — the user should see a missing outline,
    // not a stack trace they cannot act on. `ipc` is what `fork` talks over.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  w.unref(); // never keep the host process alive for us
  w.channel?.unref(); // nor the IPC channel, which refs the loop independently
  w.on("message", (msg: { id: number; result: unknown; rss?: number }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg.result ?? null);

    // A worker that has answered a few times is working, whatever it does later. Without
    // this, three unrelated crashes spread across a long session would exhaust the
    // respawn budget and silently switch code intelligence off for good — which matters
    // far more now that EVERY grammar depends on this worker, not just the exotic ones.
    if (++served >= HEALTHY_REPLIES) respawns = 0;

    // The child measures itself; see workerRssMb for why this is read over there and
    // why it is memory rather than a proxy for it.
    if (typeof msg.rss === "number" && msg.rss > workerRssMb() * 1024 * 1024) overBudget = w;

    if (pending.size !== 0) return;
    // Retire only once nothing is in flight, so a request never dies for a reason that
    // has nothing to do with it.
    if (overBudget === w) {
      isolationStats.retirements++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      retire(w);
      return;
    }
    armIdleShutdown();
  });
  const dead = () => {
    if (worker === w) worker = null;
    if (overBudget === w) overBudget = null;
    served = 0;
    isolationStats.crashes++;
    respawns++;
    // Whatever was in flight ON THIS CHILD is the likely culprit — poison it so the
    // next spawn is not fed the same fatal input, and resolve those waiters with the
    // null that "fallback tier unavailable" has always meant. Requests already running
    // on a replacement child are untouched.
    for (const [id, p] of pending) {
      if (p.child !== w) continue;
      poisoned.add(p.grammarFile);
      clearTimeout(p.timer);
      p.resolve(null);
      pending.delete(id);
    }
  };
  w.on("error", dead);
  w.on("exit", (code, signal) => {
    // A Zone abort arrives here as an ordinary non-zero exit (or a signal), which is
    // the entire point of the process boundary: the thing that used to kill us is now
    // an event we handle.
    if (code !== 0 || signal) dead();
    else if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

/** Run one op in the isolation worker. Null on poison, crash, timeout, or when
 *  respawns are exhausted — never a throw, never a host crash. */
async function callWorker<T>(
  grammarFile: string,
  op: "extract" | "span" | "markup",
  payload: Record<string, unknown>,
): Promise<T | null> {
  if (poisoned.has(grammarFile)) return null;
  const w = ensureWorker();
  if (!w) return null;
  const id = nextId++;
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      // Wedged, not crashed: kill it and let the exit handler do the rest — including
      // resolving THIS promise via the pending sweep.
      w.kill("SIGKILL");
    }, requestTimeoutMs());
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    pending.set(id, { resolve: resolve as (v: unknown) => void, grammarFile, timer, child: w });
    w.send({ id, op, ...payload });
  });
}

/** Extraction for a heavy grammar, isolated. Same contract as treeSitterExtract. */
export function isolatedExtract(
  grammarFile: string,
  absPath: string,
  code: string,
): Promise<Extraction | null> {
  return callWorker<Extraction>(grammarFile, "extract", { absPath, code });
}

/**
 * HTML/CSS extraction, isolated. Same contract as extractMarkup.
 *
 * The markup tier walks the parse tree directly rather than running a tag query, and a
 * live tree cannot cross a process boundary — so the whole extraction runs in the
 * child and only the finished defs/refs come back. Until now this tier had no guard of
 * any kind, not even the grammar-size one, while parsing exactly the sort of large
 * nested files that cost the most.
 *
 * Poison is keyed on the HTML grammar for both, since a stylesheet embedded in a page
 * is parsed by the same worker and a crash cannot be attributed to one of the two.
 */
export function isolatedMarkup(absPath: string, code: string): Promise<Extraction | null> {
  return callWorker<Extraction>("tree-sitter-html.wasm", "markup", { absPath, code });
}

/** Span lookup for a heavy grammar, isolated. Same contract as treeSitterSpan. */
export function isolatedSpan(
  grammarFile: string,
  absPath: string,
  code: string,
  name: string,
  nearLine?: number,
): Promise<LineSpan | null> {
  return callWorker<LineSpan>(grammarFile, "span", { absPath, code, name, nearLine });
}

/** Test hook: forget crash history and poison so a fresh scenario starts clean. */
export function resetIsolationForTests(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) {
    worker.removeAllListeners();
    worker.kill("SIGKILL");
  }
  worker = null;
  overBudget = null;
  served = 0;
  respawns = 0;
  poisoned.clear();
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
  isolationStats.spawns = 0;
  isolationStats.crashes = 0;
  isolationStats.retirements = 0;
}
