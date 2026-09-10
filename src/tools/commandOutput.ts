/**
 * commandOutput.ts — where a command's output goes while it runs.
 *
 * A FILE, opened before the spawn and handed to the child as its stdout and stderr. The
 * child writes to it directly; the bytes never pass through this process at all.
 *
 * ## Why not pipes
 *
 * Pipes were the obvious thing and they carry three problems that a file does not.
 *
 * A pipe has a fixed kernel buffer, a few tens of kilobytes. It only drains while
 * something is reading, so the moment nothing is, the child BLOCKS on its next write —
 * not slowed, stopped, indefinitely, in a way that looks exactly like a hang. Every place
 * that detaches a reader has to remember to attach another one, and getting that wrong is
 * invisible until a chatty command deadlocks.
 *
 * Output also had to be held in memory, so a long build's scrollback was this process's
 * heap, and handing a command to the background meant handing over the job of draining it
 * forever.
 *
 * With a file, none of those exist. The child never blocks, memory is flat however much
 * it prints, backgrounding is just closing our end, and the output survives a crash.
 *
 * ## Both streams, one file
 *
 * stdout and stderr are given the SAME descriptor, so the two interleave in the order
 * they were actually written rather than being reassembled afterwards. On POSIX the file
 * is opened `O_APPEND`, which makes each write atomic — seek-to-end and write in one
 * step, so two streams cannot tear each other's lines apart.
 *
 * ## Reading it back
 *
 * Nothing here ever reads a whole file. A command that prints for ten minutes can leave
 * gigabytes; the head and the tail are what anyone wants and the middle is named rather
 * than loaded. Every read is a bounded range.
 */
import { promises as fs, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * `mindweave-` so the startup sweep collects anything a crash left behind — see
 * tempSweep.ts, which owns every prefix this process writes into the temp directory.
 */
const PREFIX = "mindweave-out-";

/** A file a command is writing into, and our handle on it. */
export interface OutputFile {
  path: string;
  /** The child's stdout and stderr. Closed by the caller once the child has its own dup. */
  handle: FileHandle;
}

/**
 * Open a fresh output file.
 *
 * The flags differ by platform and both are deliberate.
 *
 * POSIX gets `O_APPEND` so the two streams sharing this descriptor cannot interleave
 * mid-line, and `O_NOFOLLOW` so a symlink planted at the path cannot redirect a
 * command's output somewhere it should not go.
 *
 * Windows gets plain `w`. Opening for append there grants `FILE_APPEND_DATA` without
 * `FILE_WRITE_DATA`, and a process running under MSYS2 or Cygwin inspects the handle it
 * inherited, decides it is read-only, and discards everything it writes — silently, with
 * an empty output file and no error anywhere.
 */
export async function createOutputFile(): Promise<OutputFile> {
  const path = join(tmpdir(), `${PREFIX}${randomBytes(8).toString("hex")}.log`);
  const handle = await open(
    path,
    process.platform === "win32"
      ? "w"
      : // eslint-disable-next-line no-bitwise
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  return { path, handle };
}

/** Size in bytes, or 0 for a file that does not exist yet. */
export async function sizeOf(path: string): Promise<number> {
  try {
    const s: Stats = await fs.stat(path);
    return s.size;
  } catch {
    // Nothing written yet, or already cleaned up.
    return 0;
  }
}

/** Remove an output file. Best-effort: a leftover is swept at the next startup. */
export function removeOutputFile(path: string): void {
  void fs.rm(path, { force: true }).catch(() => {});
}

/**
 * Drop bytes at the front that are the tail of a character starting before them.
 *
 * Every range read here begins at an arbitrary byte offset, which lands mid-character
 * about as often as a build prints anything but ASCII. Decoding from there produces a
 * replacement character at the start of the text — a visible corruption on the first row
 * of every progress update, forever.
 *
 * A UTF-8 continuation byte is `10xxxxxx`; at most three can precede a start byte.
 */
function skipPartialLead(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i]! & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

/** Read a byte range and decode it, tolerating a boundary mid-character at either end. */
async function readRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    // A decoder rather than toString, so a character split across the END of the range is
    // held back instead of becoming a replacement character.
    const decoder = new StringDecoder("utf8");
    return decoder.write(skipPartialLead(buf.subarray(0, bytesRead)));
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The last `bytes` of the file, for a glance at what a running command is doing.
 *
 * A byte budget, not a line count, because the caller wants a bounded read and the file
 * may have no newlines at all. Trimming to whole lines is the caller's job.
 */
export async function tailOf(path: string, bytes: number): Promise<string> {
  const size = await sizeOf(path);
  const start = Math.max(0, size - bytes);
  return readRange(path, start, Math.min(bytes, size));
}

/** What a finished command produced, within a budget, and what was left out. */
export interface ComposedOutput {
  text: string;
  /** Bytes between the head and the tail that were not read. */
  dropped: number;
}

/**
 * The head and the tail of the file, with the middle named rather than loaded.
 *
 * Both ends, weighted toward the tail, because a build or a test run puts its banner and
 * its progress at the start and its diagnosis — the failing assertion, the stack, the
 * count — at the very end. Keeping only the first N characters throws away the half that
 * says what happened.
 *
 * The budgets are in BYTES here, where the caller thinks in characters. For anything but
 * ASCII a byte budget yields slightly fewer characters, which is the safe direction: the
 * read stays bounded and the caller is never handed more than it asked for.
 */
export async function composeFileOutput(path: string, headBytes: number, tailBytes: number): Promise<ComposedOutput> {
  const size = await sizeOf(path);
  if (size <= headBytes + tailBytes) {
    return { text: await readRange(path, 0, size), dropped: 0 };
  }
  const head = await readRange(path, 0, headBytes);
  const tail = await readRange(path, size - tailBytes, tailBytes);
  const dropped = size - headBytes - tailBytes;
  // The same wording the in-memory path used, because it is what the MODEL reads: a gap
  // named one way here and another way elsewhere is a difference it has to account for.
  // Bytes rather than characters, since bytes are what was actually skipped.
  return { text: `${head}\n… [${dropped.toLocaleString("en-US")} bytes omitted from the middle] …\n${tail}`, dropped };
}

/**
 * An incremental reader over one file, for a background shell.
 *
 * Holds a byte offset and a decoder. The decoder is the point: a read almost always ends
 * mid-character, and without one carrying those bytes to the next read every chunk
 * boundary would corrupt a character. It cannot be recreated per read for the same
 * reason.
 */
export class OutputReader {
  #offset = 0;
  #decoder = new StringDecoder("utf8");
  constructor(readonly path: string) {}

  /** Everything written since the last call. Empty when nothing is new. */
  async next(maxBytes: number): Promise<string> {
    const size = await sizeOf(this.path);
    if (size <= this.#offset) {
      // Truncated or replaced under us — start again rather than reading past the end.
      if (size < this.#offset) this.#offset = size;
      return "";
    }
    const length = Math.min(maxBytes, size - this.#offset);
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "r");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.#offset);
      this.#offset += bytesRead;
      return this.#decoder.write(buf.subarray(0, bytesRead));
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Skip to the end without returning anything — for a reader that only wants what is next. */
  async seekToEnd(): Promise<void> {
    this.#offset = await sizeOf(this.path);
  }

  /** How far this reader has got, in bytes. */
  get offset(): number {
    return this.#offset;
  }
}
