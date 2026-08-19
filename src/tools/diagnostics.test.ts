/**
 * diagnostics.test.ts — the diagnostics tool + its pure formatter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadRecord, ToolContext } from "./types.js";
import type { Chassis, CodeDiagnostic } from "../alternator/chassis/types.js";
import { MAX_WORKING_SET, diagnosticsTool, formatDiagnostics } from "./diagnostics.js";

function chassisWith(diags: CodeDiagnostic[]): Chassis {
  return {
    async outline() { return []; },
    async definition() { return { symbols: [], confidence: "name-level" }; },
    async references() { return { refs: [], confidence: "name-level" }; },
    async dependents() { return []; },
    async span() { return []; },
    async directorySummary() { return null; },
    async diagnostics() { return diags; },
    status() { return { ready: true, files: 0, symbols: 0, resolvedLanguages: [] }; },
  };
}

function ctx(chassis: Chassis, reads: string[] = []): ToolContext {
  return { cwd: "/proj", reads: new Map(reads.map((r) => [r, {} as never])), todos: [], chassis };
}

test("formatDiagnostics lists errors before warnings, with location", () => {
  const out = formatDiagnostics([
    { file: "a.ts", line: 10, column: 2, severity: "warning", message: "unused var" },
    { file: "a.ts", line: 3, column: 5, severity: "error", message: "type mismatch", source: "ts" },
  ]);
  const lines = out.split("\n");
  assert.match(lines[0]!, /a\.ts:3:5 error: type mismatch \(ts\)/);
  assert.match(lines[1]!, /a\.ts:10:2 warning: unused var/);
});

test("diagnostics tool reports a file's errors via its chassis", async () => {
  const c = chassisWith([{ file: "/proj/a.ts", line: 3, column: 5, severity: "error", message: "boom" }]);
  const res = await diagnosticsTool.execute({ path: "a.ts" }, ctx(c));
  assert.equal(res.isError, undefined);
  assert.match(res.output, /a\.ts:3:5 error: boom/);
  assert.match(res.summary!, /1 error, 0 warnings/);
});

test("diagnostics tool reports a clean file", async () => {
  const res = await diagnosticsTool.execute({ path: "a.ts" }, ctx(chassisWith([])));
  assert.match(res.output, /No diagnostics/);
});

test("diagnostics tool with no path falls back to the recent working set", async () => {
  const c = chassisWith([{ file: "/proj/b.ts", line: 1, column: 1, severity: "warning", message: "w" }]);
  const res = await diagnosticsTool.execute({}, ctx(c, ["/proj/b.ts"]));
  assert.match(res.output, /b\.ts:1:1 warning: w/);
});

// ── What "no diagnostics" is actually worth ──────────────────────────────────
// The whole point of this tool is to stop the model shipping code it just broke.
// Every test below exists because some way of NOT noticing the breakage was
// indistinguishable from a clean file.

/** A chassis that answers per-file, so "which file did it check" is observable. */
function chassisPerFile(byFile: Record<string, CodeDiagnostic[]>): Chassis {
  return { ...chassisWith([]), async diagnostics(abs: string) { return byFile[abs] ?? []; } };
}

test("with no path, the file edited LAST is checked even if it was read first", async () => {
  // Reproduces a real defect: targets came from Map insertion order, and re-setting an
  // existing key does not move it. A file read early and edited last kept its old
  // position, fell outside the window, and the model was told "No diagnostics" about
  // files it had never looked at while the file it had just broken went unchecked.
  const reads = new Map<string, ReadRecord>();
  for (const [i, name] of ["a", "b", "c", "d"].entries()) {
    reads.set(`/proj/${name}.ts`, { mtimeMs: 0, size: 0, full: true, touchedAt: i + 1 });
  }
  // The edit to a.ts: same key, new recency stamp, unchanged Map position.
  reads.set("/proj/a.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 99 });

  const c = chassisPerFile({
    "/proj/a.ts": [{ file: "/proj/a.ts", line: 1, column: 1, severity: "error", message: "broke it" }],
  });
  const res = await diagnosticsTool.execute({}, { cwd: "/proj", reads, todos: [], chassis: c } as unknown as ToolContext);

  assert.match(res.output, /a\.ts:1:1 error: broke it/, "the just-edited file was not checked");
});

test("the no-path window is capped, and the description quotes the real cap", async () => {
  const reads = new Map<string, ReadRecord>();
  for (let i = 0; i < MAX_WORKING_SET + 3; i++) {
    reads.set(`/proj/f${i}.ts`, { mtimeMs: 0, size: 0, full: true, touchedAt: i });
  }
  const seen: string[] = [];
  const c = { ...chassisWith([]), async diagnostics(abs: string) { seen.push(abs); return []; } } as Chassis;
  await diagnosticsTool.execute({}, { cwd: "/proj", reads, todos: [], chassis: c } as unknown as ToolContext);

  assert.equal(seen.length, MAX_WORKING_SET, "more files were checked than the cap allows");
  // Files beyond the cap are silently unchecked, so the number has to be stated.
  assert.ok(
    diagnosticsTool.description.includes(`only the ${MAX_WORKING_SET} files`),
    "the description must quote the real cap",
  );
});

test("a path that cannot be read is reported exactly like a clean file", async () => {
  // Not a bug to fix here — the language server returns nothing for an unreadable
  // file and the tool cannot tell that apart from silence. It IS a claim the
  // description has to make, because otherwise a typo'd path reads as a pass.
  const res = await diagnosticsTool.execute({ path: "does/not/exist.ts" }, ctx(chassisWith([])));
  assert.match(res.output, /No diagnostics/);
  assert.match(
    diagnosticsTool.description,
    /does not exist or cannot be read/i,
    "the description must say an unreadable path looks clean",
  );
});

// ── The compiler-caret detail block (UI-only, reads the real source line) ──────

test("detail draws a caret under the exact failing token, using the server's end column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-diag-"));
  const abs = join(dir, "a.ts");
  const line1 = "if (isInteractiveServerCommand(command) && ctx.backgroundShells) {";
  const line2 = "  const dup = findRunningDuplicate(ctx.backgroundShells.running(), command);";
  await writeFile(abs, `${line1}\n${line2}\nif (dup) {\n`, "utf8");

  const token = "findRunningDuplicate";
  const col = line2.indexOf(token) + 1;
  const endCol = col + token.length;

  const c = chassisWith([
    { file: abs, line: 2, column: col, endColumn: endCol, severity: "error", message: "Cannot find name 'findRunningDuplicate'.", source: "ts" },
  ]);
  const res = await diagnosticsTool.execute({ path: abs }, { cwd: dir, reads: new Map(), todos: [], chassis: c } as unknown as ToolContext);

  const detail = res.detail!;
  assert.match(detail, /a\.ts:2:\d+/);
  assert.ok(detail.includes(`│ 1: ${line1}`), "the line before should give context");
  assert.ok(detail.includes(`│ 2: ${line2}`), "the failing line itself should be shown");
  assert.ok(detail.includes(`⎿ ts: Cannot find name 'findRunningDuplicate'.`));

  // The caret line: same gutter width as "│ 2: ", then (col-1) spaces, then
  // exactly token.length tildes — under the token, not its first letter alone.
  const caretRow = detail.split("\n").find((l) => l.includes("~"));
  assert.ok(caretRow, "a caret row should exist");
  assert.equal(caretRow!.replace(/^\s+/, ""), "~".repeat(token.length));
});

test("detail falls back to a single ^ when the server gave no end column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-diag-"));
  const abs = join(dir, "a.ts");
  await writeFile(abs, "const x = 1\n", "utf8");
  const c = chassisWith([{ file: abs, line: 1, column: 7, severity: "error", message: "oops" }]);
  const res = await diagnosticsTool.execute({ path: abs }, { cwd: dir, reads: new Map(), todos: [], chassis: c } as unknown as ToolContext);
  const caretRow = res.detail!.split("\n").find((l) => l.trim() === "^");
  assert.ok(caretRow, "should fall back to a bare caret, not a tilde span it has no width for");
});

test("a diagnostic on an unreadable path is silently dropped from detail, not a crash", async () => {
  const c = chassisWith([{ file: "/does/not/exist.ts", line: 1, column: 1, severity: "error", message: "boom" }]);
  const res = await diagnosticsTool.execute({ path: "/does/not/exist.ts" }, ctx(c));
  assert.equal(res.detail, "");
  assert.match(res.output, /boom/, "the model still gets the finding even without a caret");
});

test("more than MAX_CARETS diagnostics: the rest are counted, not silently dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-diag-"));
  const abs = join(dir, "a.ts");
  await writeFile(abs, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), "utf8");
  const diags: CodeDiagnostic[] = Array.from({ length: 8 }, (_, i) => ({
    file: abs,
    line: i + 1,
    column: 1,
    severity: "error" as const,
    message: `err ${i}`,
  }));
  const c = chassisWith(diags);
  const res = await diagnosticsTool.execute({ path: abs }, { cwd: dir, reads: new Map(), todos: [], chassis: c } as unknown as ToolContext);
  assert.match(res.detail!, /\(\+3 more/);
});

test("the description warns that a broken CALLER will not be seen", () => {
  // The costliest false pass: rename a symbol, check the file you edited, get a clean
  // answer, and the errors are all in files you never named.
  assert.match(diagnosticsTool.description, /caller/i);
  assert.match(diagnosticsTool.description, /references/);
});
