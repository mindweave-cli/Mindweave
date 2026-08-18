/**
 * tempSweep.ts — remove the temp files and directories Mindweave leaves behind.
 *
 * Everything here writes to the system temp directory: screen captures, the file a
 * wrapped shell command reports its final cwd through, the `.bat` that wraps a command
 * on Windows, and every fixture the test suite builds. Each of those call sites cleans
 * up after itself when the run goes to plan, and that turned out to be the whole
 * problem: a crash, an abort, or a failed test skips the cleanup, and nothing ever
 * comes back for it.
 *
 * MEASURED on a developer machine: 41,828 abandoned directories, accumulated in under
 * two weeks, and a further 229 from a single pair of test runs. It is a steady drip,
 * not a backlog.
 *
 * So the policy is age, applied at startup, rather than a shutdown hook — a sweep can
 * clean up after a process that died badly, which is exactly the case a hook cannot
 * reach. That reasoning already existed here for captures; it was simply never applied
 * to anything else.
 *
 * Two classes, because they are kept for different reasons:
 *
 *   - a CAPTURE is content. The model may still be asked about a screenshot, the
 *     reference survives in the transcript, and compaction can bring the image back —
 *     so captures live for days.
 *   - SCRATCH is plumbing. A cwd hand-off file or a test fixture is meaningless the
 *     moment its process is gone, and is kept only long enough that a sweep can never
 *     delete one out from under a Mindweave running right now.
 *
 * Best-effort throughout. A sweep that cannot read the temp directory, or that races
 * another Mindweave deleting the same entry, must never keep the CLI from starting.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a capture is kept. One edit changes the policy. */
export const CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * How long scratch is kept.
 *
 * Nothing needs it after its process exits, so this is not a retention policy — it is
 * a safety margin. A concurrently running Mindweave (or test run) must never have its
 * live temp directory swept away by another instance starting up, and a day is far
 * longer than any single operation that uses one.
 */
export const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

/** Captures — content, kept for days. Checked BEFORE the general prefix below, which
 *  it also matches. */
const CAPTURE_PREFIX = "mindweave-shot-";

/**
 * Every prefix Mindweave puts in the system temp directory.
 *
 * Deliberately narrow: these name the product, so a match is ours. The age gate is the
 * second guard — between the two, a sweep cannot reach a stranger's files or a live
 * instance's working directory.
 */
const SCRATCH_PREFIXES = ["mindweave-", "mw-"] as const;

export type SweepClass = "capture" | "scratch";

/** Which class an entry belongs to, or null when it is not ours to touch (pure). */
export function classify(name: string): SweepClass | null {
  if (name.startsWith(CAPTURE_PREFIX)) return "capture";
  return SCRATCH_PREFIXES.some((p) => name.startsWith(p)) ? "scratch" : null;
}

/** How long an entry of this class is kept (pure). */
export function maxAgeFor(cls: SweepClass): number {
  return cls === "capture" ? CAPTURE_MAX_AGE_MS : SCRATCH_MAX_AGE_MS;
}

/**
 * Should an entry be removed, given its age? (pure)
 *
 * Split out from the I/O so the policy can be tested without fabricating timestamps
 * on a real filesystem, and so "how old is too old" is one comparison in one place.
 */
export function isExpired(mtimeMs: number, now: number, maxAgeMs: number): boolean {
  return now - mtimeMs > maxAgeMs;
}

/**
 * Remove expired Mindweave temp entries. Returns how many went.
 *
 * `dir` and `now` are parameters so tests drive a fabricated tree rather than the
 * real temp directory, where a stray match would delete a developer's actual files.
 * `ageScale` lets a test shorten both policies at once without pretending either
 * constant is something other than what ships.
 *
 * Files are swept as well as directories: the cwd hand-off file and the Windows `.bat`
 * wrapper are plain files, and they are stranded by exactly the same crashes.
 */
export async function sweepTemp(
  dir: string = tmpdir(),
  now: number = Date.now(),
  ageScale = 1,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // unreadable temp directory is not our problem to solve
  }

  for (const name of names) {
    const cls = classify(name);
    if (!cls) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!isExpired(info.mtimeMs, now, maxAgeFor(cls) * ageScale)) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Vanished under us, locked, or not ours to delete. Skip it.
    }
  }
  return removed;
}

/** Fire-and-forget sweep for startup: never awaited, never throws, never logs. */
export function sweepTempInBackground(): void {
  void sweepTemp().catch(() => {});
}
