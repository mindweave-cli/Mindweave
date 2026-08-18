/**
 * workingSet.test.ts — the pure working-set core + an end-to-end buildWorkingSet over
 * a real temp dir (freshness + big-file localization), without a model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadRecord, ToolContext } from "../tools/types.js";
import {
  selectActiveFiles,
  numberedRange,
  renderWorkingFiles,
  buildWorkingSet,
  type PreparedFile,
} from "./workingSet.js";

// ── selection (LRU) ──────────────────────────────────────────────────────────────

test("selectActiveFiles returns the most-recently-touched files, capped", () => {
  const reads = new Map<string, ReadRecord>([
    ["/p/a.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }],
    ["/p/b.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 3 }],
    ["/p/c.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 2 }],
  ]);
  const active = selectActiveFiles(reads, 2);
  assert.deepEqual(active.map((a) => a.path), ["/p/b.ts", "/p/c.ts"]); // by recency, capped at 2
});

test("the read ledger's own order is NOT recency — always go through selectActiveFiles", () => {
  // The trap this helper exists for, written down. `ctx.reads` is a Map, and re-setting
  // an existing key does not move it: `touch()` mutates the record in place and
  // `recordWrite()` re-sets it, so neither reorders anything. Code that sliced the key
  // list to find "the files most recently worked on" got the files first SEEN instead,
  // which is how a file the model kept returning to dropped out of its own relevance
  // feed as soon as five others had been opened.
  const reads = new Map<string, ReadRecord>();
  reads.set("/p/first.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 1 });
  reads.set("/p/second.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 2 });
  reads.set("/p/first.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 3 }); // worked on again

  assert.deepEqual([...reads.keys()].slice(-1), ["/p/second.ts"], "insertion order is not recency");
  assert.equal(selectActiveFiles(reads, 1)[0]!.path, "/p/first.ts", "recency is what callers actually want");
});

// ── line numbering ───────────────────────────────────────────────────────────────

test("numberedRange numbers an inclusive, clamped slice", () => {
  const lines = ["a", "b", "c", "d"];
  assert.equal(numberedRange(lines, 2, 3), "2\tb\n3\tc");
  assert.equal(numberedRange(lines, 3, 99), "3\tc\n4\td"); // clamped
});

// ── budgeting + render ───────────────────────────────────────────────────────────

test("renderWorkingFiles keeps within budget and reports full paths", () => {
  const files: PreparedFile[] = [
    { path: "/p/a.ts", block: "AAA", tokens: 100, full: true, shown: [{ start: 1, end: 9 }] },
    { path: "/p/b.ts", block: "BBB", tokens: 100, full: false, shown: [{ start: 4, end: 8 }] },
    { path: "/p/c.ts", block: "CCC", tokens: 100, full: true, shown: [{ start: 1, end: 9 }] },
  ];
  const { text, fullPaths } = renderWorkingFiles(files, 250); // fits 2, evicts 1
  assert.match(text, /AAA/);
  assert.match(text, /BBB/);
  assert.doesNotMatch(text, /CCC/);
  // NAMED, not counted. The header tells the model these are the files it is working on
  // and not to re-read them, so an absence it cannot see the shape of is a false claim.
  assert.match(text, /c\.ts/, "an omitted file must be named, not reduced to a count");
  assert.ok(fullPaths.has("/p/a.ts"));
  assert.ok(!fullPaths.has("/p/b.ts")); // localized, not full
});

test("renderWorkingFiles always keeps at least the first file (over budget)", () => {
  const files: PreparedFile[] = [{ path: "/p/big.ts", block: "X", tokens: 9999, full: true, shown: [{ start: 1, end: 1 }] }];
  const { text } = renderWorkingFiles(files, 100);
  assert.match(text, /big\.ts|X/);
});

// ── end-to-end buildWorkingSet ───────────────────────────────────────────────────

function ctxWith(dir: string, reads: Map<string, ReadRecord>): ToolContext {
  return { cwd: dir, reads, todos: [] };
}

test("buildWorkingSet injects a small file's current content and marks it full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-"));
  const p = join(dir, "a.ts");
  await fs.writeFile(p, "export const x = 1;\nexport const y = 2;\n");
  const reads = new Map<string, ReadRecord>([[p, { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }]]);
  const ctx = ctxWith(dir, reads);

  const { text, fullPaths } = await buildWorkingSet(ctx);
  assert.match(text, /working on/);
  assert.match(text, /export const x = 1/); // current content, line-numbered
  assert.ok(fullPaths.has(p), "small file is included in full");
});

test("buildWorkingSet keeps ALL touched files (no fixed count cap), not just the most recent few", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-many-"));
  const reads = new Map<string, ReadRecord>();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, `f${i}.ts`);
    await fs.writeFile(p, `export const v${i} = ${i};\n`);
    reads.set(p, { mtimeMs: 0, size: 0, full: true, touchedAt: i + 1 });
  }
  const ctx = ctxWith(dir, reads);

  const { text, fullPaths } = await buildWorkingSet(ctx);
  for (let i = 0; i < 6; i++) {
    assert.match(text, new RegExp(`v${i} = ${i}`), `file f${i} should be present (would fail at a 3-file cap)`);
  }
  assert.equal(fullPaths.size, 6, "all small files fit and are shown in full");
});

test("buildWorkingSet reflects the LATEST content (no staleness) and skips vanished files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws2-"));
  const p = join(dir, "a.ts");
  await fs.writeFile(p, "old();\n");
  const reads = new Map<string, ReadRecord>([
    [p, { mtimeMs: 0, size: 0, full: true, touchedAt: 2 }],
    [join(dir, "gone.ts"), { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }],
  ]);
  const ctx = ctxWith(dir, reads);

  await fs.writeFile(p, "brandNew();\n"); // change on disk after the read was recorded
  const { text } = await buildWorkingSet(ctx);
  assert.match(text, /brandNew/); // fresh from disk
  assert.doesNotMatch(text, /old\(\)/);
  assert.doesNotMatch(text, /gone\.ts/); // missing file skipped, never throws
});

test("the file being actively worked on is held WHOLE even when it exceeds the per-file cap", async () => {
  // The budget note promises the active file is never the one squeezed out, but the
  // per-file cap was applied to it too — so on a project of 300-400 line pages (measured
  // at 8,900-9,900 tokens each) nothing was ever held whole, workingSetFull was always
  // empty, and read_file's short-circuit could never fire for the file being edited.
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const big = join(dir, "cart.html");
  // ~9,400 tokens once line-numbered: over PER_FILE_MAX_TOKENS, under WORKING_SET_TOKENS.
  const line = `            <a href="book-detail.html?id=12" class="book-card__link" data-book="12">`;
  await fs.writeFile(big, Array.from({ length: 366 }, () => line).join("\n"));

  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  const st = await fs.stat(big);
  ctx.reads.set(big, { mtimeMs: st.mtimeMs, size: st.size, full: true, touchedAt: 1 });

  const ws = await buildWorkingSet(ctx);
  assert.ok(ws.fullPaths.has(big), "the active file must be held whole, or every edit re-reads it");
});

test("a SECOND large file still pays the per-file cap", async () => {
  // The exemption is for the active file only; without that limit the budget ceiling
  // would mean nothing and the block would grow without bound.
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const line = `            <a href="book-detail.html?id=12" class="book-card__link" data-book="12">`;
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  for (const [i, name] of ["cart.html", "books.html"].entries()) {
    const p = join(dir, name);
    await fs.writeFile(p, Array.from({ length: 366 }, () => line).join("\n"));
    const st = await fs.stat(p);
    ctx.reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: true, touchedAt: 2 - i });
  }
  const ws = await buildWorkingSet(ctx);
  assert.equal(ws.fullPaths.size, 1, "only the most recent large file is held whole");
});

// ── the block must never lie about what it contains ──────────────────────────────
// Reproduced from a real session: with a 2,045-line stylesheet and a 1,381-line
// component both active, `<working_files>` carried ONE of them at 15,400 tokens against
// a 12,000 budget, dropped the other — the file being edited — and said nothing. The
// header meanwhile told the model these were the files it was working on and not to
// re-read them, so it obeyed a claim that was false and re-read the missing file instead.

/** A file of `lines` similar lines, registered in the ledger with an optional focus. */
async function seed(
  ctx: ToolContext,
  dir: string,
  name: string,
  lines: number,
  touchedAt: number,
  focus?: { start: number; end: number }[],
): Promise<string> {
  const p = join(dir, name);
  const body = Array.from({ length: lines }, (_, i) => `  .rule-${i} { color: var(--fg); padding: 0 8px; }`);
  await fs.writeFile(p, body.join("\n"));
  const st = await fs.stat(p);
  ctx.reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: !focus, touchedAt, ...(focus ? { focus } : {}) });
  return p;
}

test("a file that cannot fit is NAMED, never silently absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  // Enough large files that the budget cannot possibly hold them all, so the question
  // "what happens to the ones that don't fit" is actually asked.
  const names = Array.from({ length: 14 }, (_, i) => `s${String(i).padStart(2, "0")}.css`);
  for (const [i, name] of names.entries()) {
    await seed(ctx, dir, name, 2045, names.length - i, [{ start: 1, end: 2000 }]);
  }

  const ws = await buildWorkingSet(ctx);
  // The invariant, not a count: every active file is either SHOWN (its own `###` header)
  // or NAMED in the omission note. Silence is the failure — the block tells the model
  // these are the files it is working on and not to re-read them, so a file that is
  // neither shown nor named is a claim the model obeys and a file it re-reads blind.
  const note = ws.text.slice(ws.text.indexOf("NOT shown here"));
  for (const name of names) {
    const shown = ws.text.includes(`### ${name}`);
    const named = ws.text.includes("NOT shown here") && note.includes(name);
    assert.ok(shown || named, `${name} is neither shown nor named:\n${ws.text.slice(-400)}`);
  }
  assert.ok(ws.text.includes("### s00.css"), "the most recent file must be shown, not merely named");
});

test("the rendered block stays inside its budget, with content in it", async () => {
  const { WORKING_SET_TOKENS } = await import("./workingSet.js");
  const { estimateTokens } = await import("./compaction.js");
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  await seed(ctx, dir, "a.css", 2045, 3, [{ start: 1, end: 2000 }]);
  await seed(ctx, dir, "b.css", 2045, 2, [{ start: 1, end: 2000 }]);
  await seed(ctx, dir, "c.css", 2045, 1, [{ start: 1, end: 2000 }]);

  const ws = await buildWorkingSet(ctx);
  const size = estimateTokens(ws.text);
  // Both halves matter. Unbounded, one file localized past the whole budget; bounded but
  // dropping what does not fit, the block comes in under budget by being EMPTY.
  assert.ok(
    size <= WORKING_SET_TOKENS * 1.05,
    `block is ${size} tokens against a ${WORKING_SET_TOKENS} budget — one file took the lot`,
  );
  assert.match(ws.text, /\.rule-\d+ \{/, `the block came in under budget by carrying nothing:\n${ws.text.slice(0, 300)}`);
});

test("localizing never costs more than showing the whole file", async () => {
  // Unbounded, localization cost MORE than the file it stood in for: a fat outline on top
  // of focus regions that already spanned the file measured 15,354 tokens against a
  // 12,060-token file. Bounding it by the share makes that impossible by construction —
  // this is the assertion that keeps it impossible.
  const { estimateTokens } = await import("./compaction.js");
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  await seed(ctx, dir, "recent.css", 60, 2);
  const p = await seed(ctx, dir, "styles.css", 900, 1, [{ start: 1, end: 900 }]);
  ctx.chassis = {
    outline: async () =>
      Array.from({ length: 400 }, (_, i) => ({ kind: "class", name: `rule-${i}-with-a-long-name`, line: i + 1 })),
  } as unknown as ToolContext["chassis"];

  const ws = await buildWorkingSet(ctx);
  const at = ws.text.indexOf("### styles.css");
  assert.ok(at >= 0, `styles.css was not carried at all:\n${ws.text.slice(0, 300)}`);
  const block = ws.text.slice(at);
  const whole = await fs.readFile(p, "utf8");
  const wholeCost = estimateTokens(whole.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
  assert.ok(
    estimateTokens(block) < wholeCost,
    `localized to ${estimateTokens(block)} tokens for a ${wholeCost}-token file — paying more for less`,
  );
});

test("a localized block states exactly which lines it holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  await seed(ctx, dir, "big.css", 3000, 1, [{ start: 100, end: 140 }]);

  const ws = await buildWorkingSet(ctx);
  assert.match(ws.text, /holding lines 98-142 of 3000/, `coverage not stated:\n${ws.text.slice(0, 300)}`);
});

test("the block is reused when nothing on disk changed, and never when it did", async () => {
  // Skipping the rebuild must not cost the freshness guarantee. `run_command` can write
  // files with no tool the engine could hook, so the reuse test is a stat of the file
  // itself, not a "was anything mutated" flag — a flag would be wrong exactly there.
  const dir = await mkdtemp(join(tmpdir(), "mw-ws-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  const p = join(dir, "a.ts");
  await fs.writeFile(p, "export const before = 1;\n");
  const st = await fs.stat(p);
  ctx.reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: true, touchedAt: 1 });

  const first = await buildWorkingSet(ctx);
  const second = await buildWorkingSet(ctx);
  assert.equal(second, first, "an unchanged working set should be reused, not rebuilt");

  await new Promise((r) => setTimeout(r, 12)); // mtime resolution
  await fs.writeFile(p, "export const after = 2;\n");
  const third = await buildWorkingSet(ctx);
  assert.match(third.text, /after = 2/, "a file changed behind our back must still be picked up");
  assert.doesNotMatch(third.text, /before = 1/);
});
