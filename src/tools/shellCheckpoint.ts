/**
 * shellCheckpoint.ts — bringing shell-caused file changes into /undo.
 *
 * `run_command` was the one mutation path that bypassed checkpoints entirely. The
 * write tools snapshot a file before they touch it, so /undo can put it back; a shell
 * command that rewrites the same file through a formatter, a codemod, or an improvised
 * one-off script left nothing to restore. The turn was flagged as "a shell ran" and the
 * user was told, in effect, that some unspecified part of it could not be undone.
 *
 * That gap matters more than it looks, because improvisation via run_command is a
 * FEATURE — a capable model covers missing capabilities by writing a script, and the
 * tool-trimming work leans on that being possible. Every capability reached that way was
 * landing outside the safety net that the equivalent dedicated tool sits inside.
 *
 * ── WHAT THIS CAN AND CANNOT DO, PRECISELY ──────────────────────────────────────
 *
 * Undo needs the bytes from BEFORE the change, and after a command has run they are
 * gone. So the only honest fix is to snapshot first, and snapshotting the whole working
 * tree before every command is not affordable.
 *
 * The bounded thing that IS affordable is the read ledger: the files this session has
 * actually opened. That set is capped, usually small, and warm in the OS cache — and it
 * is overwhelmingly the set an improvised script aims at, because the model writes the
 * script about the files it has been working on. So those files get a real, restorable
 * checkpoint.
 *
 * Files the session never read are not covered, and that is not papered over: they are
 * counted and reported, so /undo says what it did not cover rather than implying it
 * covered everything. An honest gap beats a silent one.
 */
import { promises as fs } from "node:fs";
import type { ToolContext } from "./types.js";

/** Per-file ceiling for a pre-command snapshot. Above this, skip rather than stall. */
const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
/** Total ceiling across one snapshot, so a big ledger cannot pause a command. */
const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;

/** What the ledger's files held immediately before a command ran. */
export type ShellSnapshot = Map<string, { content: string | null; mtimeMs: number; size: number }>;

/**
 * Commands that cannot change files, so the snapshot is skipped entirely.
 *
 * Deliberately a SMALL allow-list of obviously-read-only starts, not an attempt to
 * classify shell commands in general. Getting this wrong in the permissive direction
 * silently drops undo coverage, so anything unrecognised is treated as mutating and
 * pays for a snapshot it may not need. A wasted stat is cheap; a lost file is not.
 */
const READ_ONLY_STARTS = [
  "cat", "head", "tail", "less", "more", "ls", "dir", "pwd", "echo", "which", "type",
  "git status", "git log", "git diff", "git show", "git branch",
  "node --version", "npm --version", "npm ls", "npm list",
];

export function looksReadOnly(command: string): boolean {
  const c = command.trim().toLowerCase();
  // Anything chaining or redirecting can write, whatever it starts with.
  if (/[>|;&]/.test(c)) return false;
  return READ_ONLY_STARTS.some((p) => c === p || c.startsWith(`${p} `));
}

/**
 * Capture the ledger's files before a command runs.
 *
 * Failures are silent per file: a file that vanished or cannot be read is simply not
 * covered, which is the same outcome as not being in the ledger. This must never be
 * the reason a command does not run.
 */
export async function snapshotBeforeCommand(ctx: ToolContext): Promise<ShellSnapshot> {
  const snapshot: ShellSnapshot = new Map();
  if (!ctx.checkpoints || ctx.reads.size === 0) return snapshot;

  let total = 0;
  for (const absPath of ctx.reads.keys()) {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      if (total + stat.size > MAX_SNAPSHOT_TOTAL_BYTES) break;
      const content = await fs.readFile(absPath, "utf8");
      snapshot.set(absPath, { content, mtimeMs: stat.mtimeMs, size: stat.size });
      total += stat.size;
    } catch {
      // Gone, unreadable, or binary — not coverable, and not worth failing over.
    }
  }
  return snapshot;
}

/** What a command turned out to have changed. */
export interface ShellChanges {
  /** Files given a real, restorable checkpoint. */
  captured: string[];
  /** Files seen to change that could not be captured (no pre-image). */
  uncaptured: string[];
}

/**
 * Compare the tree against the snapshot and check in whatever the command changed.
 *
 * Mtime AND size are both compared, for the same reason the edit-freshness gate does:
 * a coarse filesystem clock hides a fast rewrite, and a same-size change (a flipped
 * boolean, a renamed identifier) hides from a size check. Either signal alone misses
 * real cases.
 */
export async function captureAfterCommand(ctx: ToolContext, before: ShellSnapshot): Promise<ShellChanges> {
  const captured: string[] = [];
  const uncaptured: string[] = [];
  if (!ctx.checkpoints) return { captured, uncaptured };

  for (const [absPath, prior] of before) {
    let now: { content: string | null; changed: boolean };
    try {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs === prior.mtimeMs && stat.size === prior.size) continue;
      now = { content: await fs.readFile(absPath, "utf8"), changed: true };
    } catch {
      // Deleted by the command: still a change, and one undo can reverse by writing
      // the old bytes back.
      now = { content: null, changed: true };
    }
    if (!now.changed) continue;
    if (now.content === prior.content) continue; // touched but identical: nothing to undo

    ctx.checkpoints.backup(absPath, prior.content, now.content ?? "");
    captured.push(absPath);
  }

  // Anything the session had never read is outside the snapshot by construction. We
  // cannot enumerate it without walking the tree, so it is reported as a category
  // rather than a list — see noteShell, which still fires for exactly this reason.
  return { captured, uncaptured };
}
