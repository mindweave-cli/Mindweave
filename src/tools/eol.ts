/**
 * eol.ts — line-ending helpers so Mindweave's write tools respect a file's (or a
 * project's) existing style instead of imposing LF.
 *
 * The model always emits LF in tool arguments (it can't see a CR). Left alone,
 * write_file would turn a Windows (CRLF) project into a mix of CRLF and LF files,
 * and a multi-line `old_string` would fail to match raw CRLF bytes. These
 * helpers keep the bytes on disk consistent with what's already there.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type Eol = "\r\n" | "\n";

/** The dominant line ending of a text blob: CRLF if any CRLF is present, else LF. */
export function detectEol(sample: string): Eol {
  return sample.includes("\r\n") ? "\r\n" : "\n";
}

/** Re-encode content to `eol` (normalize to LF first so it's idempotent). */
export function applyEol(content: string, eol: Eol): string {
  const lf = content.replace(/\r\n/g, "\n");
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

/** The line ending an EXISTING file uses (reads it; LF if unreadable/unknown). */
export async function fileEol(path: string): Promise<Eol> {
  try {
    return detectEol(await fs.readFile(path, "utf8"));
  } catch {
    return "\n";
  }
}

/**
 * Best-effort line ending for a NEW file: match a sibling text file in the same
 * directory, else LF. Bounded and fail-safe so it never blocks or slows a write.
 */
export async function dirEol(dir: string): Promise<Eol> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.slice(0, 20)) {
      if (!e.isFile()) continue;
      try {
        const buf = await fs.readFile(join(dir, e.name));
        const head = buf.subarray(0, 8192).toString("utf8");
        if (head.includes("\n")) return detectEol(head);
      } catch {
        // Unreadable sibling — try the next one.
      }
    }
  } catch {
    // No directory yet (or unreadable) — fall through to the default.
  }
  return "\n";
}
