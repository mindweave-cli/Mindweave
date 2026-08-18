/**
 * atomicWrite.ts — replace a file's contents without ever leaving it torn.
 *
 * Every file-mutating tool used to call `fs.writeFile` straight onto the real
 * path. That call TRUNCATES the destination and then streams the new bytes in,
 * so between those two moments the file on disk is empty or half-written. A
 * crash, an OOM kill, or a power loss inside that window destroys the user's
 * file, and it destroys it SILENTLY: the tool never returned, so the agent
 * believes the edit landed and carries on reasoning about content that no longer
 * exists. The window is small; the loss is total and unrecoverable.
 *
 * The cure is the standard write-temp-then-rename dance:
 *   1. write the complete new content to a sibling temp file,
 *   2. fsync it, so the bytes are on the physical device and not merely in the
 *      page cache (without this a power loss can land a renamed file full of
 *      zeroes — the rename outlives the data it points at),
 *   3. rename it over the destination.
 *
 * Rename within a directory is atomic on POSIX, and Node maps it to
 * MoveFileEx(REPLACE_EXISTING) on Windows. So a reader of the destination at ANY
 * instant sees either the old file, whole, or the new file, whole. There is no
 * third state to observe and no window to lose the file in.
 *
 * A sibling temp file, not the system temp directory: rename is only atomic
 * WITHIN a filesystem, and /tmp is very often a different mount. A cross-device
 * rename fails outright (EXDEV), and "fix" it by copying and you are back to a
 * torn destination with extra steps.
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Windows lets another process hold a handle that blocks our rename: an editor
 * with the file open, a search indexer, antivirus reading what we just wrote.
 * The block is transient — those holders release in milliseconds — so a short
 * retry converts a spurious hard failure into a normal write. POSIX renames over
 * open files without complaint, so this path never engages there.
 */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 40;

/** Errors that mean "someone else is holding the destination, briefly". */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

function errCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A temp name beside the destination, unique across concurrent writers.
 *
 * The pid alone is not enough: two sessions in the same repo are two processes,
 * but one process running parallel tool calls is ONE pid writing several files at
 * once. Random bytes make each attempt distinct regardless. Leading dot so a
 * temp file that somehow outlives us stays out of the user's way.
 */
function tempPathFor(filePath: string): string {
  const unique = `${process.pid}.${randomBytes(6).toString("hex")}`;
  return join(dirname(filePath), `.${basename(filePath)}.${unique}.tmp`);
}

/**
 * The destination's current permission bits, or undefined if it does not exist.
 *
 * A fresh temp file is born with default permissions, so replacing an executable
 * script would silently strip its execute bit and the next run of it fails with
 * "permission denied" — a change nobody asked for, caused by a tool that was
 * only supposed to edit text.
 */
async function existingMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode;
  } catch {
    return undefined;
  }
}

/** Rename, tolerating Windows' transient holders. Throws if it never succeeds. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const retryable = IS_WINDOWS && TRANSIENT.has(errCode(error));
      if (!retryable || attempt >= RENAME_ATTEMPTS) throw error;
      await sleep(RENAME_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Write `content` to `filePath` so the destination is never observed torn.
 *
 * Drop-in for `fs.writeFile(path, content, "utf8")`. Parent directories are NOT
 * created here — callers that need that already do it, and doing it silently
 * would hide a typo'd path behind a freshly invented tree.
 *
 * On any failure the destination is left exactly as it was and the temp file is
 * cleaned up, so a failed write is a no-op rather than a partial one.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = tempPathFor(filePath);
  const mode = await existingMode(filePath);

  try {
    // Explicit handle rather than fs.writeFile's `flush` option: that option only
    // exists from Node 20.10, and this package allows >=20. On an older 20.x it
    // would be accepted and ignored, leaving us with no fsync and no error — the
    // exact silent-durability-loss this module exists to prevent.
    const handle = await fs.open(tempPath, "w", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open`'s mode argument is masked by the process umask, so an existing file's
    // bits are re-applied here to survive it. Permission bits only: the type bits
    // in stat.mode are not ours to copy.
    if (mode !== undefined) await fs.chmod(tempPath, mode & 0o777);
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    // Never leave litter behind: the destination still holds the old content, so
    // the temp file is pure garbage at this point.
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  // Durability of the RENAME itself (as opposed to the bytes) needs the parent
  // directory synced too, or a power loss can resurrect the old directory entry
  // pointing at a file we already unlinked. Best-effort: Windows cannot open a
  // directory as a file, and some filesystems refuse the fsync. A failure here
  // costs durability across a power cut, never correctness of the write.
  if (!IS_WINDOWS) {
    let dir;
    try {
      dir = await fs.open(dirname(filePath), "r");
      await dir.sync();
    } catch {
      // Nothing to do: the data is written and the rename has already happened.
    } finally {
      await dir?.close().catch(() => {});
    }
  }
}
