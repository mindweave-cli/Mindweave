/**
 * restart.ts — handing the terminal to a newer copy of Mindweave without losing the
 * conversation.
 *
 * ## The shape, and why it is this one
 *
 * Node cannot replace its own process image; there is no `exec`. So "restart" always
 * means a second process, and the only real question is who owns the terminal while
 * both exist. The tempting answer — spawn the new one and exit — is the broken one: the
 * shell sees this process end, prints its prompt, and then two things are writing to the
 * same screen.
 *
 * So the old process stays alive as a shell of itself. It tears its own UI down, hands
 * the terminal over in a defined order, spawns the successor with the same stdio, and
 * then does nothing but wait and pass the exit code up. The shell sees one process from
 * start to finish.
 *
 * A supervisor wrapping every launch would be tidier and is what a long-lived design
 * would grow into. It is deliberately not that yet: it would put new code in the path of
 * EVERY launch to serve one that happens rarely, and a fault in it would reach everyone
 * rather than only the person who ran `/update`.
 *
 * ## The handover order is the whole risk
 *
 * Both processes can write to one terminal and both can want raw mode. The old one must
 * be completely out — rendering stopped, alternate screen left, mouse reporting off,
 * cursor and autowrap restored, stdin out of raw mode — BEFORE the new one starts, or
 * the result is two renderers fighting over a screen, which looks exactly like the
 * corruption this whole area has been chasing. That order lives in `relaunch` and
 * nowhere else.
 *
 * The decisions are pure and tested; the one impure function takes its spawn and its
 * teardown as arguments.
 */

/** How long a new process gets to prove it can start, in milliseconds. */
const START_GRACE_MS = 5_000;

/** What became of the process we handed the terminal to. */
export type ChildOutcome =
  /** It ran, and ended the way any session ends. */
  | { kind: "ok"; code: number }
  /** It died almost immediately: the new version cannot start on this machine. */
  | { kind: "failedStart"; code: number }
  /** It ran for a while and then failed, which is an ordinary crash, not a bad update. */
  | { kind: "crashed"; code: number };

/**
 * Read a child's exit as one of three things (pure).
 *
 * The distinction that matters is between a version that CANNOT START and a session
 * that ended badly much later. Only the first is the update's fault, and only the first
 * should send anyone back to a previous version. Time is the only evidence available:
 * a build that is broken on this machine fails during startup, long before anyone has
 * typed anything.
 */
export function classifyExit(code: number | null, signal: string | null, elapsedMs: number): ChildOutcome {
  // A signal is how a session is ENDED — Ctrl+C, a closed window — not how a bad
  // version behaves, whenever it arrives.
  if (signal !== null) return { kind: "ok", code: code ?? 0 };
  const exit = code ?? 0;
  if (exit === 0) return { kind: "ok", code: exit };
  return elapsedMs < START_GRACE_MS ? { kind: "failedStart", code: exit } : { kind: "crashed", code: exit };
}

/**
 * How to launch the copy installed at `packageRoot` (pure).
 *
 * The script is run through this process's own Node rather than through the installed
 * launcher. The launcher on Windows is a `.cmd`, and spawning one means going through a
 * shell, which means every path with a space in it becomes a quoting problem. Node is
 * already here, its path is known exactly, and it takes arguments as an array.
 */
export function relaunchArgv(
  execPath: string,
  packageRoot: string,
  sessionId?: string,
): { command: string; args: string[] } {
  const windows = /^[A-Za-z]:/.test(packageRoot) || packageRoot.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  const entry = `${packageRoot}${sep}dist${sep}index.js`;
  return { command: execPath, args: sessionId ? [entry, "--resume", sessionId] : [entry] };
}

/** What to say when the version just installed cannot start. */
export function failedStartMessage(previousVersion: string, prefix: string): string {
  return [
    "The updated version did not start.",
    "",
    `Nothing else was changed, and the previous version can be restored with:`,
    `  npm install -g --prefix ${prefix} mindweave@${previousVersion}`,
  ].join("\n");
}

/** Everything `relaunch` needs from the outside world. */
export interface RelaunchDeps {
  /**
   * Put the terminal back exactly as it was found, and stop rendering into it.
   *
   * Called before anything is spawned. Whatever this does not undo, the new process
   * inherits — a stray raw-mode stdin or an unclosed alternate screen is not something
   * it can detect or repair from its side.
   */
  teardown: () => void | Promise<void>;
  /** Start the successor and resolve when it ends. */
  spawn: (command: string, args: string[]) => Promise<{ code: number | null; signal: string | null }>;
  /** Write a line the user will read after everything has gone. */
  report: (text: string) => void;
  now?: () => number;
}

/**
 * Hand the terminal to the copy at `packageRoot` and wait for it.
 *
 * Resolves with the exit code this process should then use, so the shell that started
 * everything sees one process with one result.
 */
export async function relaunch(
  packageRoot: string,
  sessionId: string | undefined,
  previousVersion: string,
  prefix: string,
  deps: RelaunchDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  // Order matters and this is the line it matters on: the terminal is fully released
  // before anything else is allowed to touch it.
  await deps.teardown();

  const { command, args } = relaunchArgv(process.execPath, packageRoot, sessionId);
  const startedAt = now();
  const ended = await deps.spawn(command, args);
  const outcome = classifyExit(ended.code, ended.signal, now() - startedAt);

  if (outcome.kind === "failedStart") {
    deps.report(failedStartMessage(previousVersion, prefix));
  }
  return outcome.code;
}
