/**
 * captureSweep.ts — clear out screenshots that have outlived their usefulness.
 *
 * `screenshot` writes each capture to its own temp directory so the model can be
 * handed the file and compaction can drop and restore the reference. Nothing removed
 * them, so every window ever photographed stayed on disk indefinitely — and unlike
 * the rest of the agent's temp files, a capture holds whatever happened to be on
 * screen at the time.
 *
 * Deleting immediately after sending was considered and rejected: the reference
 * survives in the transcript, compaction can bring an image back, and a capture the
 * model may still be asked about should not be a dangling path. So they live for a
 * few days and are swept by age at startup, which also catches anything left behind
 * by a crash — the case a shutdown hook would miss.
 *
 * Best-effort throughout. A sweep that cannot read the temp directory, or that races
 * another Mindweave deleting the same folder, must never keep the CLI from starting.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a capture is kept. One edit changes the policy. */
export const CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Temp directory prefixes this sweep owns. Must match what creates them. */
export const SWEPT_PREFIXES = ["mindweave-shot-"] as const;

/** Does this directory name belong to us? (pure) */
export function isSweptName(name: string): boolean {
  return SWEPT_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Should an entry be removed, given its age? (pure)
 *
 * Split out from the I/O so the policy can be tested without fabricating timestamps
 * on a real filesystem, and so "how old is too old" is one comparison in one place.
 */
export function isExpired(mtimeMs: number, now: number, maxAgeMs = CAPTURE_MAX_AGE_MS): boolean {
  return now - mtimeMs > maxAgeMs;
}

/**
 * Remove expired capture directories. Returns how many went.
 *
 * `dir` and `now` are parameters so tests drive a fabricated tree rather than the
 * real temp directory, where a stray match would delete a developer's actual files.
 */
export async function sweepCaptures(
  dir: string = tmpdir(),
  now: number = Date.now(),
  maxAgeMs: number = CAPTURE_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // unreadable temp directory is not our problem to solve
  }

  for (const name of names) {
    if (!isSweptName(name)) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isDirectory()) continue;
      if (!isExpired(info.mtimeMs, now, maxAgeMs)) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Vanished under us, locked, or not ours to delete. Skip it.
    }
  }
  return removed;
}

/** Fire-and-forget sweep for startup: never awaited, never throws, never logs. */
export function sweepCapturesInBackground(): void {
  void sweepCaptures().catch(() => {});
}
