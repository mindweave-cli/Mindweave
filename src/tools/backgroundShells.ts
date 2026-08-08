/**
 * backgroundShells.ts — long-running commands that outlive a turn.
 *
 * When a command crosses its timeout (or the model asks for `run_in_background`),
 * run_command hands the LIVE process to this manager instead of killing it. The
 * manager owns the registry of background shells per session, buffers their output
 * (capped, so a chatty dev server never floods memory or the model's context), and
 * exposes:
 *
 *   - `read(id)`  — only the NEW output since the last read (incremental).
 *   - `kill(id)`  — whole-tree kill.
 *   - `list()`    — running + finished shells (for the UI and /shells).
 *
 * Two ONE-SHOT, self-cleaning event channels keep notifications from leaking
 * (avoiding the common footgun where finished jobs re-inject into the model forever):
 *   - `takeUiEvents()` — shells that came up or stopped, not yet shown in the chat.
 *   - `drainEvents()`  — the same for the MODEL, each with a tail of output, so it is
 *                        told once and then never again.
 *
 * Every event is delivered. What varies is whether it INTERRUPTS the session: a stop
 * the user caused arrives as background fact on the next turn rather than waking the
 * model, which is what stops it reopening an app somebody just closed.
 *
 * Client-side, like the alternator lanes: it holds live process handles, never
 * crosses the engine↔brain wire. All children are killed on process exit.
 */
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { killTree, killTreeSync } from "./killTree.js";

const MAX_BUFFER_CHARS = 5_000_000; // cap one shell's retained output (runaway server)
export const MAX_READ_CHARS = 30_000; // cap a single shell_output read
const TAIL_CHARS = 2_000; // how much trailing output rides on a completion note

/**
 * How long a server has to stay up before we treat its death as "someone stopped it"
 * rather than "it failed to start".
 *
 * This is the one honest way to tell the two apart, because the exit status cannot:
 * measured on Windows, a user closing an app reports `code 1`, and so does a server
 * that crashed because its port was taken. Duration separates them cleanly — a port
 * conflict dies in under a second, a session you close has been up for minutes.
 *
 * Borrowed from process supervisors, which hit this decades ago: supervisord counts a
 * program as failed-to-start if it exits before `startsecs` (default 1s) regardless of
 * its exit code. 10s is deliberately generous, since a dev server can take several
 * seconds to bind a port and fail.
 */
const STARTUP_GRACE_MS = 10_000;

/**
 * How long to wait after `exit` for `close` before finalizing anyway.
 *
 * `close` fires only once every stdio stream is closed, and a surviving grandchild can
 * hold the pipe open forever, which strands the entry as permanently "running".
 * `exit` fires when the process itself goes, so it is the backstop; the delay lets
 * `close` win normally so buffered output is not lost.
 */
const EXIT_GRACE_MS = 2_000;

export type ShellStatus = "running" | "exited" | "killed";

/**
 * What the caller wants to hear about, declared when the command is started.
 *
 * This replaces guessing from the command string. The old heuristic matched a list of
 * dev-server names, so `cargo run`, `docker compose up`, `flask run` and a plain path
 * to a binary were all mistaken for finite tasks. A caller knows which it is; a regex
 * can only ever know the names someone thought of.
 *
 *   - `on_finish`  — tell me when it ends, however it ends. Builds, tests, installs:
 *                    the result IS the point.
 *   - `on_failure` — tell me when it comes up, and if it never does. A normal stop is
 *                    silent, because someone closing their own app is not an event to
 *                    act on. Servers and apps.
 *   - `never`      — say nothing, ever. Start it and forget it.
 */
export type NotifyPolicy = "on_finish" | "on_failure" | "never";

/** Who stopped a shell, when somebody did. Absent means it ended on its own. */
export type StopActor = "agent" | "user";

/** The two things that can be worth telling the model about a background shell. */
export type ShellEventKind = "ready" | "ended";

/**
 * Guess a notify policy from the command, for callers that did not declare one.
 *
 * This is a FALLBACK, not the decision. The policy is declared at call time; this only
 * picks a default when nothing was said, so a caller that forgets does not regress to
 * "reopen the app the user just closed". Being a list of names, it is wrong for
 * everything nobody thought of (`cargo run`, `docker compose up`, `flask run`, a plain
 * path to a binary) — which is exactly why it is no longer the authority.
 */
export function guessNotifyPolicy(command: string): NotifyPolicy {
  return isInteractiveServerCommand(command) ? "on_failure" : "on_finish";
}

/**
 * Is this command a dev server / interactive app — something that runs until stopped,
 * where "it exited" means the USER closed it, NOT that a task finished? (pure/tested)
 *
 * Only used now to pick a default (see `guessNotifyPolicy`). A finite task (build,
 * test, lint) that finishes IS a result worth surfacing, but a dev server exiting is
 * just the user closing their app, and reacting to it makes the model reopen the thing
 * they just closed. `build` variants are finite tasks, so they're excluded even though
 * they share a runner name.
 */
export function isInteractiveServerCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/\bbuild\b/.test(c)) return false; // `next build`, `tauri build`, `vite build` — finite
  // Package-runner dev/serve/start/preview scripts: `npm run dev`, `pnpm start`, `yarn serve`.
  if (/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(dev|serve|start|preview)\b/.test(c)) return true;
  // Dev servers / desktop-app runners invoked directly.
  return /\b(tauri|vite|next|nuxt|remix|astro|nodemon|electron|expo|ng|http-server|live-server|serve|webpack-dev-server|watchexec)\b/.test(
    c,
  );
}

/**
 * Should a finished shell INTERRUPT the user with a turn? (pure/tested)
 *
 * Note the narrow question. This does NOT decide whether the model is told: it is
 * always told (see `drainEvents`). Swallowing the event was the real defect — the
 * model could not say "your app stopped", and if asked why the app was down it had
 * nothing. This decides only whether the stop is worth breaking into the session for.
 *
 * The rule, in the user's words: don't reopen something they closed, unless it
 * crashed before they ever got to see it.
 *
 *   - `never` → nothing is ever worth interrupting for
 *   - somebody killed it → the agent or the user did that on purpose, so they know
 *   - `on_finish` → the result is the point, always interrupt
 *   - a signal ended it → someone stopped it deliberately
 *   - otherwise → interrupt ONLY if it never came up, because then the user never saw
 *     it running and cannot know it failed
 *
 * Deliberately NOT consulted: the exit code and the duration. Exit status cannot tell
 * these cases apart — measured on Windows, a closed app and a port conflict both report
 * code 1, and a signalled process reports none at all. `cameUp` is the fact that
 * actually separates them, and it is established in ONE place (the readiness timer)
 * rather than recomputed here from a second set of numbers.
 */
export function shouldWakeOnEnd(end: {
  notify: NotifyPolicy;
  killed: boolean;
  signal: string | null;
  cameUp: boolean;
}): boolean {
  if (end.notify === "never") return false;
  if (end.killed) return false;
  if (end.notify === "on_finish") return true;
  if (end.signal) return false;
  return !end.cameUp;
}

/**
 * Is `command` already running as one of these shells? (pure/tested) Matches on the
 * normalized command string, so launching the very same server a second time is caught
 * — the failure where the model fires `npm run tauri dev` twice, the copies collide on
 * the port, and it then fights the conflict it created. Distinct servers (a frontend and
 * a backend) don't match each other, so running both is still fine.
 */
export function findRunningDuplicate(
  running: readonly ShellInfo[],
  command: string,
): ShellInfo | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(command);
  return running.find((s) => norm(s.command) === target);
}

/** Plain, serializable view of a background shell (what tools/UI see). */
export interface ShellInfo {
  id: number;
  command: string;
  cwd: string;
  status: ShellStatus;
  exitCode: number | null;
  /** The signal that ended it, when one did. A signalled process has NO exit code, so
   *  without this it reads as "exited null" — which is what a stopped app looked like. */
  signal?: string;
  startedAt: number;
  finishedAt: number | null;
  /** What this shell's caller asked to be told about. */
  notify: NotifyPolicy;
  /** Who stopped it, when somebody did. Absent means it ended on its own — which is
   *  what lets the model say "you closed it" instead of assuming it crashed. */
  stoppedBy?: StopActor;
  /** It survived the startup grace, so it is up rather than merely spawned. */
  ready: boolean;
  /**
   * The retained buffer overflowed and older output was dropped.
   *
   * Set when a chatty process pushes past MAX_BUFFER_CHARS. It was recorded and then
   * never shown anywhere, which made the loss invisible: a reader gets the bytes that
   * survived and no indication that anything is missing. Surfaced so an incomplete log
   * reads as incomplete rather than as the whole story.
   */
  truncated?: boolean;
}

export interface AdoptOptions {
  command: string;
  cwd: string;
  /** What to tell the model about. Defaults to `guessNotifyPolicy(command)`. */
  notify?: NotifyPolicy;
  /** Output already collected before the hand-off (foreground → background). */
  initial?: string;
  /** A temp cwd-file from run_command to clean up when the process ends. */
  cwdFile?: string;
  /**
   * A temp script file from run_command to clean up when the process ends.
   *
   * The `cmd` path materialises a `.bat`, because cmd.exe runs only the first line
   * of a multi-line `/c` string. The foreground paths delete it themselves, but a
   * command that gets BACKGROUNDED outlives them, so without this every backgrounded
   * cmd run left its script in the temp directory permanently.
   */
  tempFile?: string;
}

interface Entry extends ShellInfo {
  child: ChildProcess | null;
  buffer: string; // retained output (capped)
  readOffset: number; // chars already handed out by read()
  truncated: boolean;
  reported: boolean; // end told to the model yet?
  uiNotified: boolean; // end shown in the chat yet?
  wakeOnEnd: boolean; // is that ending worth interrupting the session for?
  readyReported: boolean; // "it came up" told to the model yet?
  readyUiNotified: boolean; // "it came up" shown in the chat yet?
  readyTimer: ReturnType<typeof setTimeout> | null;
  cwdFile?: string;
  tempFile?: string;
}

const active = new Set<BackgroundShells>();
let cleanupRegistered = false;

export class BackgroundShells {
  private seq = 0;
  private shells = new Map<number, Entry>();
  private onChange: (() => void) | null = null;

  constructor() {
    active.add(this);
    registerCleanup();
  }

  /** Subscribe to state changes (start / finish / kill) — the UI re-renders. */
  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }

  /** Take ownership of a live child process and start buffering its output. */
  adopt(child: ChildProcess, opts: AdoptOptions): ShellInfo {
    const id = ++this.seq;
    const entry: Entry = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      child,
      buffer: "",
      readOffset: 0,
      truncated: false,
      notify: opts.notify ?? guessNotifyPolicy(opts.command),
      ready: false,
      reported: false,
      uiNotified: false,
      wakeOnEnd: false,
      readyReported: false,
      readyUiNotified: false,
      readyTimer: null,
      cwdFile: opts.cwdFile,
      tempFile: opts.tempFile,
    };
    this.shells.set(id, entry);
    if (opts.initial) this.append(entry, opts.initial);

    // The readiness signal. A server that is still alive after the startup grace has
    // come up, and that is the one positive event worth reporting for something that
    // never "finishes". Without it the model was told to promise a report it could not
    // give: the only event it could ever receive was the end, which for a server is
    // deliberately suppressed. Tasks don't need it — their event is completion.
    if (entry.notify === "on_failure") {
      entry.readyTimer = setTimeout(() => {
        entry.readyTimer = null;
        if (entry.status !== "running") return;
        entry.ready = true;
        this.emit();
      }, STARTUP_GRACE_MS);
      entry.readyTimer.unref?.();
    }

    const collect = (chunk: Buffer) => this.append(entry, chunk.toString("utf8"));
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    // `signal` is captured, not dropped: a process ended by SIGTERM/SIGINT reports
    // `code === null`, and without the signal there is no way to tell that from a
    // crash.
    child.on("close", (code, signal) => this.onClose(entry, code, signal, false));
    child.on("error", () => this.onClose(entry, null, null, false));
    // Backstop for a `close` that never arrives because a surviving grandchild still
    // holds the stdio pipe. Without this the entry stays "running" for the rest of the
    // session: the UI shows a dead shell, and `runningCount()` is permanently wrong.
    child.on("exit", (code, signal) => {
      const timer = setTimeout(() => this.onClose(entry, code, signal, false), EXIT_GRACE_MS);
      timer.unref?.();
    });

    this.emit();
    return view(entry);
  }

  private append(entry: Entry, text: string): void {
    entry.buffer += text;
    if (entry.buffer.length > MAX_BUFFER_CHARS) {
      // Keep the tail — the recent output is what matters for tests/errors.
      entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS);
      entry.readOffset = Math.min(entry.readOffset, entry.buffer.length);
      entry.truncated = true;
    }
  }

  private onClose(
    entry: Entry,
    code: number | null,
    signal: string | null,
    killed: boolean,
    by?: StopActor,
  ): void {
    if (entry.status !== "running") return;
    entry.status = killed ? "killed" : "exited";
    entry.exitCode = code;
    if (signal) entry.signal = signal;
    entry.finishedAt = Date.now();
    entry.child = null;
    if (by) entry.stoppedBy = by;
    if (entry.readyTimer) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = null;
    }
    // A pending "it's up" must not fire after the thing has already stopped. Note this
    // clears the PENDING notice, not `entry.ready`: whether it ever came up is the fact
    // the wake decision below is built on, and it has to survive.
    entry.readyReported = true;
    entry.readyUiNotified = true;
    // Whether this ending is worth interrupting for. It is NOT marked reported here:
    // the model is always told (drainEvents), it just isn't always interrupted. Marking
    // it reported is what used to delete the event outright, leaving the model unable
    // to say the app had stopped at all.
    entry.wakeOnEnd = shouldWakeOnEnd({
      notify: entry.notify,
      killed,
      signal,
      cameUp: entry.ready,
    });
    if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
    if (entry.tempFile) void fs.rm(entry.tempFile, { force: true }).catch(() => {});
    this.emit();
  }

  /** New output since the last read of this shell, plus its current status. */
  async read(id: number): Promise<{ info: ShellInfo; chunk: string } | null> {
    const entry = this.shells.get(id);
    if (!entry) return null;
    let chunk = entry.buffer.slice(entry.readOffset);
    entry.readOffset = entry.buffer.length;
    if (chunk.length > MAX_READ_CHARS) {
      chunk = `… (earlier output omitted)\n${chunk.slice(chunk.length - MAX_READ_CHARS)}`;
    }
    return { info: view(entry), chunk };
  }

  /**
   * Kill a running shell (whole tree). Returns false if it isn't running.
   *
   * `by` records WHO stopped it. Neither actor is woken about it, since both already
   * know, but the difference is kept so the model can say "you stopped it" rather than
   * guessing that it crashed.
   */
  kill(id: number, by: StopActor = "agent"): boolean {
    const entry = this.shells.get(id);
    if (!entry || entry.status !== "running" || !entry.child) return false;
    killTree(entry.child.pid);
    this.onClose(entry, null, null, true, by);
    return true;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map(view);
  }
  running(): ShellInfo[] {
    return this.list().filter((s) => s.status === "running");
  }
  runningCount(): number {
    return this.running().length;
  }
  /**
   * Events worth INTERRUPTING for: a shell that just came up, or one that ended in a
   * way the user cannot already know about.
   *
   * This is deliberately narrower than "events not yet told". A stop the user caused
   * still gets delivered on the next turn (see `drainEvents`); it just doesn't break
   * into the session, which is what stops the agent reopening a closed app.
   */
  pendingCount(): number {
    return [...this.shells.values()].filter(
      (e) => (e.status !== "running" && !e.reported && e.wakeOnEnd) || (e.ready && !e.readyReported),
    ).length;
  }

  /** One-shot for the UI: shells that came up or stopped and aren't in the chat yet. */
  takeUiEvents(): { info: ShellInfo; kind: ShellEventKind }[] {
    const out: { info: ShellInfo; kind: ShellEventKind }[] = [];
    for (const entry of this.shells.values()) {
      if (entry.ready && !entry.readyUiNotified) {
        entry.readyUiNotified = true;
        out.push({ info: view(entry), kind: "ready" });
      }
      if (entry.status !== "running" && !entry.uiNotified) {
        entry.uiNotified = true;
        out.push({ info: view(entry), kind: "ended" });
      }
    }
    return out;
  }

  /**
   * One-shot for the MODEL: EVERYTHING it hasn't been told, each with a tail of output.
   *
   * Every ending is delivered, including the ones not worth interrupting for. Those
   * used to be deleted, which left the model unable to say an app had stopped, or to
   * answer why it was down. `wake` carries whether this was the interrupting kind, so
   * the caller can word it as news or as background fact.
   *
   * Both kinds go through this single channel, and both mark themselves so nothing is
   * ever injected twice. That one-shot property is the whole reason background jobs
   * don't slowly eat the context window, and it must survive any change here.
   */
  async drainEvents(): Promise<
    { info: ShellInfo; kind: ShellEventKind; tail: string; wake: boolean }[]
  > {
    const out: { info: ShellInfo; kind: ShellEventKind; tail: string; wake: boolean }[] = [];
    const tailOf = (entry: Entry) => entry.buffer.slice(Math.max(0, entry.buffer.length - TAIL_CHARS));
    for (const entry of this.shells.values()) {
      if (entry.ready && !entry.readyReported) {
        entry.readyReported = true;
        out.push({ info: view(entry), kind: "ready", tail: tailOf(entry), wake: true });
      }
      if (entry.status !== "running" && !entry.reported) {
        entry.reported = true;
        out.push({ info: view(entry), kind: "ended", tail: tailOf(entry), wake: entry.wakeOnEnd });
      }
    }
    return out;
  }

  /**
   * Kill every running shell and drop the registry (session swap / exit).
   *
   * `sync` is required when disposing from a process-exit handler: the default
   * kill spawns `taskkill` asynchronously, and Node runs no async work during
   * exit, so the shells would outlive us. Measured, not assumed.
   */
  dispose(sync = false): void {
    for (const entry of this.shells.values()) {
      // Kill by CHILD PRESENT, not by recorded status. A shell we have marked
      // "ended" only means its WRAPPER exited, and on POSIX that says nothing about
      // its descendants: kill the `sh -c` and the program it started is orphaned and
      // keeps running, still holding the stdio pipes. MEASURED on Linux, where the
      // orphan outlived the whole test process and stopped it from ever exiting.
      // The group kill still reaches it, because a process group survives its leader
      // as long as it has members. Signalling an already-dead pid is a harmless
      // no-op, so there is nothing to lose by not consulting the status first.
      if (entry.child) {
        if (sync) killTreeSync(entry.child.pid);
        else killTree(entry.child.pid);
      }
      if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
      if (entry.tempFile) void fs.rm(entry.tempFile, { force: true }).catch(() => {});
    }
    this.shells.clear();
    active.delete(this);
  }

  private emit(): void {
    this.onChange?.();
  }
}

function view(e: Entry): ShellInfo {
  return {
    id: e.id,
    command: e.command,
    cwd: e.cwd,
    status: e.status,
    exitCode: e.exitCode,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    notify: e.notify,
    ready: e.ready,
    ...(e.signal ? { signal: e.signal } : {}),
    ...(e.stoppedBy ? { stoppedBy: e.stoppedBy } : {}),
    ...(e.truncated ? { truncated: true } : {}),
  };
}

/** Kill any background processes still running when the process exits. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    // Synchronous kill: an async one never reaches the OS from here.
    for (const mgr of active) mgr.dispose(true);
  });
}
