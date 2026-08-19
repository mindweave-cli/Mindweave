/**
 * searchPrecision.test.ts — the affordances that let a search LOCATE something.
 *
 * These exist because of a measured habit, not a wishlist. Sessions showed the model
 * answering "where is this handled?" by reading whole files, and the search tool was
 * part of why: a capped result could only say "narrow the search", so when the model
 * could not narrow it — a common identifier, a broad question — its remaining move was
 * to open files and read. Reading a file costs its whole length, on every later request,
 * forever; a located line costs a line.
 *
 * Three gaps, each closed here and each checked against the behaviour rather than the
 * schema: paging past the cap, asymmetric context, and matching across line breaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { grepDef } from "./grep.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-search-")));
  return { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
}

const run = (args: Record<string, unknown>, ctx: ToolContext) => grepDef.execute(args, ctx);

test("a capped search says how to reach the next page, not just to give up", () => {
  // The behaviour this replaces told the model to "narrow the search" and nothing else.
  // When it could not narrow, it read whole files instead.
  const ctx = freshCtx();
  return (async () => {
    await fs.writeFile(join(ctx.cwd, "many.ts"), Array.from({ length: 40 }, (_, i) => `const hit${i} = 1;`).join("\n"));
    const r = await run({ pattern: "hit", output_mode: "content", head_limit: 10 }, ctx);
    assert.match(r.output, /offset: 10/, "a capped result must name the offset that continues it");
    assert.equal(r.output.split("\n").filter((l) => /const hit/.test(l)).length, 10);
  })();
});

test("offset actually returns the NEXT results, not the same ones again", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "many.ts"), Array.from({ length: 40 }, (_, i) => `const hit${i} = 1;`).join("\n"));
  const first = await run({ pattern: "hit", output_mode: "content", head_limit: 5 }, ctx);
  const second = await run({ pattern: "hit", output_mode: "content", head_limit: 5, offset: 5 }, ctx);
  assert.match(first.output, /hit0\b/);
  assert.doesNotMatch(second.output, /hit0\b/, "paging returned the first page again");
  assert.match(second.output, /hit5\b/);
});

test("an offset past the end says so instead of looking like no matches", async () => {
  // "No matches found" here would be a lie the model acts on — it would conclude the
  // string is absent when it simply paged too far.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), "const hit = 1;\n");
  const r = await run({ pattern: "hit", output_mode: "content", offset: 500 }, ctx);
  assert.match(r.output, /past the/);
  assert.doesNotMatch(r.output, /No matches found/);
});

test("`after` returns what FOLLOWS a match, which is the usual question", async () => {
  // "What is this thing" is answered by the lines after a declaration. A symmetric
  // window spends half its budget on the end of whatever came before.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), ["before2", "before1", "function target() {", "  body1;", "  body2;"].join("\n"));
  const r = await run({ pattern: "function target", output_mode: "content", after: 2 }, ctx);
  assert.match(r.output, /body1/);
  assert.match(r.output, /body2/);
  assert.doesNotMatch(r.output, /before1/, "`after` must not pull in preceding lines");
});

test("`before` is independent of `after`", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), ["before2", "before1", "TARGET", "after1", "after2"].join("\n"));
  const r = await run({ pattern: "TARGET", output_mode: "content", before: 2 }, ctx);
  assert.match(r.output, /before1/);
  assert.match(r.output, /before2/);
  assert.doesNotMatch(r.output, /after1/);
});

test("`context` still sets both sides when neither is given", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), ["before1", "TARGET", "after1"].join("\n"));
  const r = await run({ pattern: "TARGET", output_mode: "content", context: 1 }, ctx);
  assert.match(r.output, /before1/);
  assert.match(r.output, /after1/);
});

test("multiline finds a construct that is not on one line", async () => {
  // Without this the only way to find "the handler that calls save" is to read the file,
  // because the two halves of the fact are on different lines.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), "function handler() {\n  save();\n}\n");
  const off = await run({ pattern: "function handler[\\s\\S]*?save", output_mode: "content" }, ctx);
  assert.match(off.output, /No matches found/, "a line-bound search cannot span the break");
  const on = await run({ pattern: "function handler.*?save", output_mode: "content", multiline: true }, ctx);
  assert.doesNotMatch(on.output, /No matches found/, "multiline must cross the line break");
});

test("head_limit: 0 means no limit rather than no results", async () => {
  // Zero is a real value here and must not collapse into the default.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "a.ts"), Array.from({ length: 20 }, (_, i) => `hit${i}`).join("\n"));
  const r = await run({ pattern: "hit", output_mode: "content", head_limit: 0 }, ctx);
  assert.equal(r.output.split("\n").filter((l) => /hit\d/.test(l)).length, 20);
});
