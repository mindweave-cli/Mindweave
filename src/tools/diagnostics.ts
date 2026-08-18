/**
 * diagnostics.ts — surface compiler/linter errors from the language servers.
 *
 * Mindweave already runs language servers (for def/ref); this reads their *diagnostics*
 * — the type errors, syntax errors, and warnings they publish — so the model can
 * check what it just wrote and fix it, instead of editing blind. Rather than running
 * diagnostics automatically after every edit, here it's an explicit tool the model calls
 * after changing code, plus prompt guidance to do so.
 *
 * Read-only: it only reads what the servers report. Degrade-safe: no server for the
 * language (or none reported) → a clean "no diagnostics" result.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { CodeDiagnostic } from "../alternator/chassis/types.js";
import { chassisForPath } from "./chassisMux.js";
import { relativize, resolvePath } from "./paths.js";
import { selectActiveFiles } from "../memory/workingSet.js";

/** When no path is given, check this many of the most-recently-touched files.
 *  Exported so the number quoted in the description is pinned to the real value. */
export const MAX_WORKING_SET = 3;
const MAX_SHOWN = 50;
/** Full caret context is built for at most this many diagnostics (errors first) —
 *  reading source lines and drawing a caret for all 50 shown would bury the ones
 *  that matter under a wall of low-value warnings. */
const MAX_CARETS = 5;

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  readOnly: true,
  // Written against the failure this tool is supposed to PREVENT: the model edits,
  // asks for diagnostics, is told "no diagnostics", and moves on with broken code.
  // Three things made that possible and none of them were in the text — the check is
  // per-file so a broken CALLER is never seen, a clean answer is not proof (no server,
  // a slow server, and an unreadable path all render identically), and the no-path
  // form only reaches a few files.
  description:
    "Report compiler and linter diagnostics (type errors, syntax errors, warnings) for " +
    "a file, from its language server. It re-syncs the file from disk first, so it " +
    "reflects what you actually just wrote, not a stale copy. Call it after editing " +
    "code, and fix what it reports before moving on.\n" +
    "SCOPE: it checks the FILES YOU NAME and nothing else. Diagnostics are per-file, " +
    `so if you omit path it checks only the ${MAX_WORKING_SET} files you touched most ` +
    "recently. A change that breaks code elsewhere — you renamed a symbol, changed a " +
    "signature, altered an exported type — will NOT show up here, because the broken " +
    "file is the CALLER. After that kind of edit, find the callers with `references` " +
    "and check those paths too.\n" +
    "A clean result is weaker evidence than it looks: you also get \"no diagnostics\" " +
    "when no language server handles that file type, when the server is too slow to " +
    "answer, and when the path does not exist or cannot be read. So it confirms " +
    "problems, it does not prove their absence. Treat a clean answer on code you " +
    "expected to be broken as a reason to check the path and verify another way " +
    "(build it, run the tests) rather than as a passing grade.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File to check. Omit to check the most recently read/edited files.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const targets = pickTargets(ctx, typeof args.path === "string" ? args.path.trim() : "");
    if (targets.length === 0) {
      return { output: "No file to check — edit or read a file first, or pass a `path`.", summary: "no target" };
    }

    const results = await Promise.all(
      targets.map(async (abs) => {
        const chassis = chassisForPath(ctx, abs);
        const diags = chassis ? await chassis.diagnostics(abs) : [];
        return { abs, diags };
      }),
    );

    const all: CodeDiagnostic[] = [];
    for (const r of results) all.push(...r.diags);
    if (all.length === 0) {
      const label = targets.map((t) => relativize(ctx, t)).join(", ");
      // Silent when it finds nothing. A model runs this in a burst right after editing,
      // and a row per file saying "no diagnostics" is a wall of rows reporting the
      // absence of news. The model still gets the answer; the user gets the screen back.
      return { output: `No diagnostics for ${label}.`, summary: "no diagnostics", quiet: true };
    }

    const output = formatDiagnostics(all.map((d) => ({ ...d, file: relativize(ctx, d.file) })));
    const errors = all.filter((d) => d.severity === "error").length;
    const warnings = all.filter((d) => d.severity === "warning").length;
    return {
      output,
      summary: `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
      detail: await buildCaretDetail(all, ctx),
      // Named for what it IS. "Check(app.ts)" reads as a routine step that happened to
      // return something; the caret block under it is a compiler error, and the header
      // should say so before the user has read a single line of it.
      displayName: errors > 0 ? "Build Error" : "Check",
    };
  },
};

/**
 * The UI-only compiler-caret block — never sent to the model (`formatDiagnostics`'s
 * flat text is what the model sees). Reads each diagnostic's own source line fresh
 * from disk (never sent, so a fetch failure just drops that one caret rather than
 * failing the tool) and draws a `~~~~~~~~` under the exact failing token when the
 * server gave us an end column (see CodeDiagnostic.endColumn).
 */
async function buildCaretDetail(all: CodeDiagnostic[], ctx: ToolContext): Promise<string> {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  const sorted = [...all].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const shown = sorted.slice(0, MAX_CARETS);

  const blocks = await Promise.all(shown.map((d) => caretBlock(d, ctx)));
  const parts = blocks.filter((b): b is string => b !== null);
  const hidden = sorted.length - shown.length;
  if (hidden > 0) parts.push(`(+${hidden} more — see the full list above)`);
  return parts.join("\n\n");
}

/** One diagnostic's caret block, or null if its source line couldn't be read. */
async function caretBlock(d: CodeDiagnostic, ctx: ToolContext): Promise<string | null> {
  const lines = await readLines(d.file);
  if (!lines) return null;
  const line = lines[d.line - 1];
  if (line == null) return null;

  const rel = relativize(ctx, d.file);
  const lineLabel = `${d.line}: `;
  const out: string[] = [`${rel}:${d.line}:${d.column}`];

  const prev = lines[d.line - 2];
  if (prev != null) out.push(`│ ${String(d.line - 1).padStart(lineLabel.length - 2)}: ${prev}`);
  out.push(`│ ${lineLabel}${line}`);
  out.push(caretLine(d, lineLabel.length));

  const codeLabel = d.source ? `${d.source}: ` : "";
  out.push(`⎿ ${codeLabel}${d.message}`); // same branch glyph ToolLine/SubagentView use, not the mockup's literal "└─"
  return out.join("\n");
}

/** The `~~~~~~~~` (or `^` when no end column is known) aligned under the failing
 *  token, indented to match the `│ N: ` gutter the source line itself sits under. */
function caretLine(d: CodeDiagnostic, gutterWidth: number): string {
  const indent = " ".repeat(2 + gutterWidth + Math.max(0, d.column - 1));
  const width = d.endColumn != null ? Math.max(1, d.endColumn - d.column) : 1;
  return indent + (d.endColumn != null ? "~".repeat(width) : "^");
}

/** The file's lines, or null if it can't be read — a caret is a nice-to-have, not
 *  worth failing the whole diagnostics call over. */
async function readLines(absPath: string): Promise<string[] | null> {
  try {
    return (await fs.readFile(absPath, "utf8")).split("\n");
  } catch {
    return null;
  }
}

/**
 * The absolute paths to check: the given path, else the most recently touched files.
 *
 * This used to read `reads.keys()` in Map order, which is INSERTION order — and
 * `reads.set()` on a key that already exists does not move it. So a file read early
 * and edited last kept its original position and fell outside the window, and the tool
 * answered "No diagnostics" for files it had never looked at while the file just
 * edited was broken. `touchedAt` is the recency stamp that survives a re-touch, and
 * `selectActiveFiles` is the same ordering the working set already uses.
 */
function pickTargets(ctx: ToolContext, rawPath: string): string[] {
  if (rawPath) return [resolvePath(ctx, rawPath)];
  return selectActiveFiles(ctx.reads, MAX_WORKING_SET).map((f) => f.path);
}

/** Render diagnostics as `file:line:col severity: message`, errors first. Pure. */
export function formatDiagnostics(diags: CodeDiagnostic[]): string {
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  const sorted = [...diags].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const shown = sorted.slice(0, MAX_SHOWN);
  const lines = shown.map(
    (d) => `${d.file}:${d.line}:${d.column} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ""}`,
  );
  if (sorted.length > shown.length) lines.push(`… (${sorted.length - shown.length} more)`);
  return lines.join("\n");
}
