/**
 * checkpoints.ts — a per-turn undo net for file edits.
 *
 * Recoverability without git: whenever a mutating tool is about to change a file,
 * it first hands the file's ORIGINAL bytes here (once per file per turn — the
 * first touch wins, so we keep the true pre-turn state) along with the bytes it is
 * ABOUT TO WRITE (last write wins — that is the state we expect to find on disk).
 * At the end of a turn the engine `seal`s those into one restorable checkpoint.
 * `/undo` then rolls the last turn's file changes back.
 *
 * It's deliberately a shadow-copy in memory (bounded stack), not a shadow git
 * repo: cheap, dependency-free, and it works even when the project isn't a git
 * repo at all. Client-side state (holds file bytes), like the background shells —
 * absent in bare contexts, in which case edits simply aren't checkpointed.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP, all learned the hard way:
 *
 * 1. **Never destroy work we did not do.** If a file no longer matches what we
 *    wrote, somebody else changed it — the user, their editor, another process.
 *    Restoring would silently overwrite that. We report it and leave it alone.
 * 2. **A failed restore must stay retryable, but not forever.** The checkpoint is
 *    retired once every file settles — or once retrying stops being useful. Popping
 *    first and restoring after loses the checkpoint to one locked file; never
 *    retiring pins that checkpoint at the top and walls off every older turn.
 * 3. **Never say more than we did.** Anything `run_command` changed is invisible
 *    here, and a file too large to hold is not covered either. Both are reported
 *    rather than quietly folded into "the turn was undone".
 * 4. **Bounded in bytes, not just in turns.** Twenty checkpoints of large files is
 *    hundreds of megabytes resident. The count bound never was the real limit.
 */
import { promises as fs } from "node:fs";
import { writeFileAtomic } from "./atomicWrite.js";

/**
 * Per-file ceiling on what we will hold. We keep two copies of every checkpointed
 * file (the original, to restore; what we wrote, to detect someone else's edit), so
 * the real cost is double. A source file past this size is not something anyone is
 * hand-editing, and holding it would crowd out every ordinary file behind it.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling across the whole stack. Oldest checkpoints are evicted first when a new
 * one pushes past it — except that the most recent checkpoint is always kept, even
 * if it alone exceeds the budget. Undoing the last turn is the case that matters;
 * leaving a user with no undo at all to satisfy a memory bound is the wrong trade.
 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * How many times `/undo` re-tries a checkpoint that had files it could not write.
 *
 * Keeping a failed file for a retry is right — a lock from an editor or a dev server
 * usually clears. Keeping it FOREVER is not: a file that never becomes writable would
 * pin its checkpoint at the top of the stack permanently, and every older turn behind
 * it would be unreachable. So retry, then give up and let the user get on.
 */
const MAX_UNDO_ATTEMPTS = 2;

const byteLen = (s: string | null): number => (s === null ? 0 : Buffer.byteLength(s, "utf8"));

/** What we knew about one file when the turn touched it. */
export interface FileState {
  /** Bytes on disk before the turn. `null` = the file did not exist (undo deletes it). */
  original: string | null;
  /** Bytes we last wrote. Undo only proceeds if the file still matches this. */
  written: string;
}

/** One sealed checkpoint: the files a single turn changed, and their pre-turn state. */
export interface Checkpoint {
  label: string;
  at: number;
  files: Map<string, FileState>;
  /** Files this turn changed that were too large to hold — NOT undoable. */
  skipped: string[];
  /** The turn also ran shell commands, whose file effects are NOT captured here. */
  ranShell: boolean;
  /** Resident cost of `files`, for the byte budget. */
  bytes: number;
  /** How many times `/undo` has worked on this checkpoint (see MAX_UNDO_ATTEMPTS). */
  attempts: number;
}

export interface UndoResult {
  label: string;
  at: number;
  /** Files put back to their pre-turn state (or deleted, if the turn created them). */
  restored: string[];
  /** Changed on disk since we wrote them — left exactly as they are. */
  conflicts: string[];
  /** Could not be written (locked, permissions). */
  failed: string[];
  /** True when those failures are still queued — another `/undo` will try them again. */
  retryable: boolean;
  /** Changed by the turn but never checkpointed (too large), so still edited. */
  skipped: string[];
  /** The turn ran shell commands too, so this rollback is not the whole turn. */
  ranShell: boolean;
}

/** One line of `/undo list`. */
export interface CheckpointSummary {
  label: string;
  at: number;
  /** How many files this turn can put back. */
  files: number;
  skipped: number;
  ranShell: boolean;
}

/** What `undo` should do with one file, given what is on disk right now. */
export type UndoAction =
  /** Already in the desired end state — the turn created it and it is gone. */
  | "settled"
  /** Someone changed it after we did; restoring would destroy their work. */
  | "conflict"
  /** The turn created it, and it is still ours to remove. */
  | "delete"
  /** Put the pre-turn bytes back. */
  | "restore";

/**
 * The whole undo decision, as a pure function of what we recorded and what is on
 * disk. Split out because this is where the judgement lives — the caller does only
 * I/O around it, and the two failure modes that matter (clobbering someone else's
 * edit, and mishandling a file that vanished) are decided here where they can be
 * tested exhaustively.
 *
 * `currentBytes` is null when the file is not on disk, for any reason.
 */
export function undoAction(state: FileState, currentBytes: string | null): UndoAction {
  if (state.original === null && currentBytes === null) return "settled";
  if (currentBytes !== state.written) return "conflict";
  return state.original === null ? "delete" : "restore";
}

/** How `/undo`'s argument was meant. Pure, so the parsing is testable on its own. */
export type UndoCommand =
  | { kind: "undo"; count: number }
  | { kind: "list" }
  | { kind: "error"; message: string };

/**
 * Parse what follows `/undo`: nothing (roll back the last turn), `list` (show what
 * is available), or a count (roll back that many turns, newest first).
 */
export function parseUndoArg(arg: string): UndoCommand {
  const text = arg.trim().toLowerCase();
  if (text === "") return { kind: "undo", count: 1 };
  if (text === "list" || text === "ls") return { kind: "list" };
  if (/^\d+$/.test(text)) {
    const count = Number(text);
    if (count < 1) return { kind: "error", message: "How many turns? /undo 1 rolls back the last one." };
    return { kind: "undo", count };
  }
  return { kind: "error", message: `I don't understand "${arg.trim()}". Use /undo, /undo list, or /undo <number>.` };
}

/**
 * What the MODEL is told after an undo. Pure.
 *
 * Without this the rollback is invisible to it: the transcript still says the edits
 * were made, so the next turn reasons about code that is no longer on disk. The
 * conversation is deliberately NOT rewound — only the facts are corrected, which is
 * the smallest honest fix for the two drifting apart.
 */
export function undoNotice(results: readonly UndoResult[], display: (path: string) => string): string {
  const list = (paths: string[]) => paths.map(display).join(", ");
  const gather = (pick: (r: UndoResult) => string[]) => [...new Set(results.flatMap(pick))];

  const labels = results.map((r) => `"${r.label}"`).join(", ");
  const lines = [
    `The user ran /undo. The file changes from ${labels} were rolled back on disk.`,
  ];

  const restored = gather((r) => r.restored);
  const conflicts = gather((r) => r.conflicts);
  const failed = gather((r) => r.failed);
  const skipped = gather((r) => r.skipped);

  if (restored.length > 0) {
    lines.push(`Back to their pre-turn state: ${list(restored)}. Your edits to these are gone.`);
  }
  if (conflicts.length > 0) {
    lines.push(`Left as they are, because they changed after you wrote them: ${list(conflicts)}.`);
  }
  if (failed.length > 0) {
    lines.push(`Could not be rolled back and are still in their edited state: ${list(failed)}.`);
  }
  if (skipped.length > 0) {
    lines.push(`Too large to checkpoint, so still in their edited state: ${list(skipped)}.`);
  }
  if (results.some((r) => r.ranShell)) {
    lines.push("Shell commands also ran; whatever those changed was not rolled back.");
  }
  lines.push("Re-read any of these before editing them again.");
  return lines.join(" ");
}

export class Checkpoints {
  private current = new Map<string, FileState>();
  private currentBytes = 0;
  private currentSkipped = new Set<string>();
  private shellRan = false;
  private stack: Checkpoint[] = [];
  private resumed = false;
  constructor(private readonly max = 20) {}

  /**
   * Record a file's pre-change content the first time it's touched this turn, and
   * the content being written now. `original` is the exact bytes on disk (or null
   * for a not-yet-existing file); `written` is what the tool is about to put there.
   *
   * A file too large to hold is recorded as SKIPPED rather than dropped silently —
   * `/undo` then says it wasn't covered instead of implying it was.
   */
  backup(absPath: string, original: string | null, written: string): void {
    const prior = this.current.get(absPath);
    if (prior) {
      // A later touch in the same turn moves only `written`; `original` is the
      // pre-turn truth and never changes.
      const grown = byteLen(original) + byteLen(written);
      if (grown > MAX_FILE_BYTES) {
        // It has outgrown what we can hold. Drop it wholesale rather than keep a
        // half-record we would have to reason about at restore time.
        this.currentBytes -= byteLen(prior.original) + byteLen(prior.written);
        this.current.delete(absPath);
        this.currentSkipped.add(absPath);
        return;
      }
      this.currentBytes += byteLen(written) - byteLen(prior.written);
      prior.written = written;
      return;
    }

    const cost = byteLen(original) + byteLen(written);
    if (cost > MAX_FILE_BYTES || this.currentBytes + cost > MAX_TOTAL_BYTES) {
      this.currentSkipped.add(absPath);
      return;
    }
    this.current.set(absPath, { original, written });
    this.currentBytes += cost;
  }

  /** Note that this turn ran a shell command, whose effects we cannot capture. */
  noteShell(): void {
    this.shellRan = true;
  }

  /**
   * Mark this as a resumed session. Undo history lives in memory, so a resumed
   * session starts empty even though earlier turns really did change files — the
   * difference matters when telling the user why there is nothing to undo.
   */
  noteResumed(): void {
    this.resumed = true;
  }

  /** Whether this session was resumed (so earlier turns' undo history is gone). */
  wasResumed(): boolean {
    return this.resumed;
  }

  /** Close this turn's edits into a restorable checkpoint. No-op if nothing happened. */
  seal(label: string): void {
    // A turn whose only file changes were too large still gets a checkpoint: it has
    // nothing to restore, but it has something to SAY, and saying it is the point.
    if (this.current.size === 0 && this.currentSkipped.size === 0) {
      this.shellRan = false;
      return;
    }
    this.stack.push({
      label: label || "(edits)",
      at: Date.now(),
      files: this.current,
      skipped: [...this.currentSkipped],
      ranShell: this.shellRan,
      bytes: this.currentBytes,
      attempts: 0,
    });
    this.current = new Map();
    this.currentBytes = 0;
    this.currentSkipped = new Set();
    this.shellRan = false;
    this.evict();
  }

  /** Trim the stack to both bounds: the turn count, then the byte budget. */
  private evict(): void {
    while (this.stack.length > this.max) this.stack.shift();
    let total = this.stack.reduce((n, cp) => n + cp.bytes, 0);
    // `length > 1` keeps the newest checkpoint whatever it costs — see MAX_TOTAL_BYTES.
    // Currently unreachable, because `backup` already refuses once a single turn's
    // held bytes would pass the budget, so no lone checkpoint can exceed it. Kept
    // anyway: it is one condition, and it is what stops that in-turn cap from
    // becoming load-bearing in a way nobody would notice if it were relaxed.
    while (total > MAX_TOTAL_BYTES && this.stack.length > 1) {
      total -= this.stack.shift()!.bytes;
    }
  }

  /** Whether there's a sealed checkpoint to undo. */
  hasUndo(): boolean {
    return this.stack.length > 0;
  }

  /** The label of the checkpoint that `undo()` would restore, if any. */
  nextUndoLabel(): string | undefined {
    return this.stack[this.stack.length - 1]?.label;
  }

  /** What is available to undo, newest first. */
  list(): CheckpointSummary[] {
    return [...this.stack]
      .reverse()
      .map((cp) => ({
        label: cp.label,
        at: cp.at,
        files: cp.files.size,
        skipped: cp.skipped.length,
        ranShell: cp.ranShell,
      }));
  }

  /**
   * Restore the most recent sealed checkpoint. Files that no longer match what we
   * wrote are reported as conflicts and left untouched; files that fail to write
   * are reported and KEPT in the checkpoint so a second `/undo` retries just those.
   * The checkpoint retires when nothing is left in it, or when retrying it has
   * stopped being useful.
   */
  async undo(): Promise<UndoResult | null> {
    const cp = this.stack[this.stack.length - 1];
    if (!cp) return null;

    const restored: string[] = [];
    const conflicts: string[] = [];
    const failed: string[] = [];

    for (const [path, state] of [...cp.files]) {
      let currentBytes: string | null;
      try {
        currentBytes = await fs.readFile(path, "utf8");
      } catch {
        currentBytes = null; // not on disk (deleted, or never created)
      }

      const action = undoAction(state, currentBytes);
      if (action === "settled") {
        cp.files.delete(path); // nothing to do, nothing worth reporting
        continue;
      }
      if (action === "conflict") {
        conflicts.push(path);
        cp.files.delete(path); // reported once; their copy stands
        continue;
      }

      try {
        if (action === "delete") await fs.rm(path, { force: true });
        // ATOMIC, like every other write to a user's file. Writing straight onto the
        // destination truncates it first, so a crash inside that window destroys the
        // file — during the one operation whose entire purpose is to save it. Undo is
        // the recovery mechanism; it must not be the thing that loses the work.
        else await writeFileAtomic(path, state.original as string);
        restored.push(path);
        cp.files.delete(path);
      } catch {
        failed.push(path); // left in place so the next /undo can try again
      }
    }

    cp.attempts++;
    const retired = cp.files.size === 0 || cp.attempts >= MAX_UNDO_ATTEMPTS;
    if (retired) this.stack.pop();

    return {
      label: cp.label,
      at: cp.at,
      restored,
      conflicts,
      failed,
      retryable: failed.length > 0 && !retired,
      skipped: cp.skipped,
      ranShell: cp.ranShell,
    };
  }

  /**
   * Undo up to `count` checkpoints, newest first — the coherent way to go back more
   * than one turn, since a later turn's edits sit on top of an earlier one's. Stops
   * early if the stack runs out, or if a checkpoint is left retryable (pressing on
   * past a file we could not write would unwind state the user thinks is still here).
   */
  async undoMany(count: number): Promise<UndoResult[]> {
    const results: UndoResult[] = [];
    for (let i = 0; i < count; i++) {
      const result = await this.undo();
      if (!result) break;
      results.push(result);
      if (result.retryable) break;
    }
    return results;
  }
}
