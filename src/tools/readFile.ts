/**
 * readFile.ts — Mindweave's first tool: read a text file.
 *
 * The smallest useful, fully read-only capability — it proves the whole
 * tool loop end-to-end without any risk of changing the user's files.
 *
 * Design borrows the proven essentials from mature agents (line-numbered
 * output, optional offset/limit range, a size cap that nudges toward ranged
 * reads, binary refusal, a friendly not-found). It deliberately does NOT carry
 * "read surgically / how to investigate" guidance — that is the model's
 * judgment, not the tool's job.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolResult } from "./types.js";
import { foreignAgentReason, protectedPathReason } from "./guard.js";
import { requestAgentDataAccess } from "./approval.js";
import { relativize, resolvePath, nextTouch, touch } from "./paths.js";
import { addFocus, coversSpan } from "./focus.js";

// Caps protect the model's context window, not the disk. They are deliberately
// MODEL-AGNOSTIC fixed defaults, not derived from any one model's context window —
// so they stay correct as other models are added.
//   - MAX_BYTES: refuse a whole-file read of a file this large; use a range.
//   - MAX_LINES: a default read returns at most this many lines (the model pages
//     with offset for more). This is the big BYOK-cost lever — a 5000-line file
//     costs one bounded read, not 5000 lines every time.
//   - MAX_OUTPUT_CHARS: final safety truncation (e.g. minified long lines).
const MAX_BYTES = 256 * 1024;
const MAX_LINES = envInt("MINDWEAVE_READ_MAX_LINES", 2000);
const MAX_OUTPUT_CHARS = 120_000;

// Returned instead of re-sending identical content when a file is unchanged
// since the model last read it — pure token savings on a re-read.
const FILE_UNCHANGED =
  "This file is unchanged since you last read it in this conversation — the " +
  "earlier read is still current, use that instead of re-reading.";

// Returned when a file is already in the live working set (its current content is in
// the <working_files> block) — the model should read it from there, not re-fetch it.
const WORKING_SET_HELD =
  "This file's current content is already shown in the <working_files> block above, " +
  "kept up to date automatically — use that instead of re-reading.";

export const readFile: Tool = {
  name: "read_file",
  readOnly: true,
  // The description states the tool's CONTRACT, not just its happy path, because two
  // of its outcomes are easy to misread as failures and one of its roles is invisible
  // from here. Every claim below is checked against the behaviour in `execute`; if that
  // changes, this changes with it.
  description:
    `Read a text file and return its contents with line numbers. Reads up to ` +
    `${MAX_LINES} lines from the start by default; pass \`offset\` (and optionally ` +
    `\`limit\`) to read a specific range of a longer file. A file larger than ` +
    `${Math.round(MAX_BYTES / 1024)} KB must be read with \`limit\` set rather than whole. ` +
    `Very long output is truncated at the end, and says so. ` +
    `Reading is also what unlocks editing: edit, replace_symbol_body ` +
    `and overwriting an existing file with write_file all require that file to have ` +
    `been read this session (read_symbol counts too). ` +
    `TWO REPLIES MEAN YOU ALREADY HAVE THE FILE and should not read it again: one says ` +
    `its content is in the <working_files> block, which is kept up to date for you; the ` +
    `other says it is unchanged since your earlier read in this conversation. Both are ` +
    `successful reads, and both satisfy the edit requirement above. ` +
    `When you only want one function, class or type, prefer read_symbol, which returns ` +
    `just that symbol instead of pulling in a large file to look at a small part of it.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file, absolute or relative to the working directory.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-based line number to start at. Only for large files.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description:
          "Number of lines to read from `offset`. Only for large files.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return fail("`path` is required.");

    const filePath = resolvePath(ctx, rawPath);
    const blocked = protectedPathReason(filePath);
    if (blocked) {
      return fail(`Refusing to read ${rawPath}: it is ${blocked}.`);
    }
    // Another tool's data: ask the user rather than helping ourselves to it.
    const otherTool = foreignAgentReason(filePath);
    if (otherTool) {
      const denied = await requestAgentDataAccess(ctx, otherTool, `Reading ${rawPath}`);
      if (denied) return denied;
    }
    const offset = toPositiveInt(args.offset);
    const limit = toPositiveInt(args.limit);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return fail(`File not found: ${rawPath}`);
    }
    if (stat.isDirectory()) {
      return fail(`${rawPath} is a directory, not a file.`);
    }

    const full = offset === undefined && limit === undefined;
    const prior = ctx.reads.get(filePath);
    const unchanged = prior !== undefined && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size;

    // Working-set short-circuit: this file's CURRENT full content is already in the
    // <working_files> block, kept fresh — don't re-send it. Covers ranged reads too
    // (the whole file is there). Bumps recency so it stays in the working set.
    if (unchanged && ctx.workingSetFull?.has(filePath)) {
      touch(ctx, filePath);
      return { output: WORKING_SET_HELD, summary: `read ${relativize(ctx, filePath)} (in working set)` };
    }

    // Read-dedup: if the model already read this whole file, it hasn't changed since
    // (same mtime + size), and that earlier read is STILL IN the transcript, don't
    // re-send the content. The presence half is derived per turn rather than read off
    // the ledger: microcompaction can clear the earlier result's body at any time, and
    // a stored "you have it" bit would then be a lie the model obeys. No presence set
    // (a subagent, a test) means no dedup — a wasted read, never a phantom one.
    if (full && prior?.full && unchanged && ctx.transcriptFull?.has(filePath)) {
      touch(ctx, filePath);
      return { output: FILE_UNCHANGED, summary: `read ${relativize(ctx, filePath)} (unchanged)` };
    }

    if (limit === undefined && stat.size > MAX_BYTES) {
      return fail(
        `File is large (${formatBytes(stat.size)}). Read a range with ` +
          `\`offset\` and \`limit\` instead of the whole file.`,
      );
    }

    const buf = await fs.readFile(filePath);
    if (looksBinary(buf)) {
      return fail(`${rawPath} looks like a binary file; cannot read as text.`);
    }

    // Split on CRLF or LF so a Windows file doesn't show a trailing \r on every
    // line — the model can't see it, would omit it from an edit's old_string, and
    // the edit would then fail to match. The edit tool normalizes line endings too.
    const allLines = buf.toString("utf8").split(/\r?\n/);
    const totalLines = allLines.length;
    const start = offset ?? 1;
    if (start > totalLines) {
      return fail(
        `offset ${start} is past the end of the file (${totalLines} lines).`,
      );
    }
    // A read with no explicit limit still stops after MAX_LINES — the default
    // read is bounded, and the model pages with offset for the rest.
    const effectiveLimit = limit ?? MAX_LINES;
    const end = Math.min(totalLines, start - 1 + effectiveLimit);

    // Ranged-read dedup, for the case the two checks above cannot reach: a LARGE file
    // is not in `workingSetFull` (it is localized to its focus regions rather than
    // rendered whole), and a ranged read is not `full`, so neither gate fires and the
    // same lines come back every time they are asked for. Measured on a real session:
    // `app.js` read four separate times while its regions sat in <working_files>.
    //
    // Compared against what the working set actually PUT ON SCREEN this turn, never
    // against the read ledger — the ledger says what was read once, not what is still
    // visible, and a sub-agent has no working set at all. Same reasoning as read_symbol.
    if (!full && unchanged && coversSpan(ctx.workingSetSpans?.get(filePath), start, end)) {
      touch(ctx, filePath, { start, end });
      return {
        output:
          `${relativize(ctx, filePath)} lines ${start}-${end} are already in your <working_files> ` +
          `block, unchanged. Read them there rather than requesting them again.`,
        summary: `read ${relativize(ctx, filePath)} (in working set)`,
      };
    }

    const slice = allLines.slice(start - 1, end);

    // Line numbers, right-aligned to the widest number in the slice.
    const width = String(end).length;
    let body = slice
      .map((line, i) => `${String(start + i).padStart(width)}\t${line}`)
      .join("\n");

    // Tell the model when the default cap hid the rest of the file.
    if (limit === undefined && end < totalLines) {
      body += `\n… (showing lines ${start}-${end} of ${totalLines}; pass offset to read further)`;
    }
    const charTruncated = body.length > MAX_OUTPUT_CHARS;
    if (charTruncated) {
      body =
        body.slice(0, MAX_OUTPUT_CHARS) +
        "\n… (truncated — read a smaller range with offset/limit)";
    }

    // "Whole file" means the whole file ACTUALLY WENT OUT, not merely that the caller
    // asked for no range. A 2500-line file read with no offset stops at the MAX_LINES
    // cap, and recording that as full let a later re-read be answered "unchanged since
    // you last read" for 500 lines the model was never shown. Same for the character
    // cap. The flag is the dedup's whole basis, so it has to mean what it says.
    const wholeFileSent = full && end >= totalLines && !charTruncated;

    // Record the read so edit / write_file know this file has been seen, so a
    // later identical read can be deduped, and so it enters the working set (recency +
    // the focused range for a partial read, used to localize a large file).
    ctx.reads.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      full: wholeFileSent,
      touchedAt: nextTouch(),
      focus: !wholeFileSent ? addFocus(prior?.focus, { start, end }) : prior?.focus,
    });

    const shown = relativize(ctx, filePath);
    const ranged = offset !== undefined || limit !== undefined;
    const summary = ranged
      ? `read ${shown} lines ${start}-${end}`
      : `read ${shown} (${slice.length} lines)`;

    // Presence, recorded as a FACT at the moment it is true, keyed by the absolute path
    // this call actually resolved to. Re-deriving it later by re-resolving these
    // arguments would be a guess: `cd` moves the working directory mid-session, so the
    // same recorded "a.ts" can resolve to a different file than it did when read.
    return { output: body, summary, ...(wholeFileSent ? { fullContentOf: filePath } : {}) };
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

/** A positive integer from an env var, or `fallback`. Lets caps be tuned without
 *  baking any one model's limits into the code. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toPositiveInt(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** A NUL byte in the first chunk is a reliable, cheap "this isn't text" signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
