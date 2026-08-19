/**
 * readBudget.test.ts — a whole-file read of a large file returns its shape, not its text.
 *
 * The habit being broken, measured: a session answered "why does the wishlist disappear?"
 * by reading a 47,836-character stylesheet whole. That content then rode in every later
 * request of the turn, and when the provider's cache expired at the next turn boundary
 * the whole conversation — stylesheet included — was re-billed at full price in one call.
 * One careless read cost several times its own length.
 *
 * The fix is not an error. An error saying "use offset and limit" cannot be acted on,
 * because the model does not yet know which lines it wants — that is precisely why it
 * asked for the whole file. An outline answers the question the read was really asking,
 * and makes the follow-up a range instead of another guess.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { CodeChassis } from "../alternator/chassis/index.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-budget-")));
  return { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
}

/** A file comfortably past the ~8k-token budget (~28k characters). */
async function bigFile(ctx: ToolContext, name = "big.ts"): Promise<string> {
  const body = Array.from({ length: 1_700 }, (_, i) => `export function fn${i}() { return ${i}; }`).join("\n");
  await fs.writeFile(join(ctx.cwd, name), body);
  return name;
}

test("a whole read of a large file does NOT return its contents", async () => {
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const r = await readFile.execute({ paths: [name] }, ctx);
  assert.doesNotMatch(r.output, /export function fn900/, "the file body came back anyway");
  assert.match(r.output, /1700 lines/, "the reply must say how big it is");
});

test("with a code map, the reply IS the file's structure", async () => {
  // The main path, and the reason this beats a bare error. "Use offset and limit" alone
  // is advice the model cannot take — not knowing which lines it wants is exactly why it
  // asked for the whole file. An outline answers that, with line numbers to aim at.
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const chassis = new CodeChassis(ctx.cwd, { lsp: false }); // tree-sitter tier only
  await chassis.build();
  (ctx as { chassis?: unknown }).chassis = chassis;

  const r = await readFile.execute({ paths: [name] }, ctx);
  assert.match(r.output, /fn900/, "the outline must name the symbols the file defines");
  assert.doesNotMatch(r.output, /return 900;/, "but not their bodies");
  assert.match(r.output, /offset/, "the ranged follow-up must be named");
  assert.match(r.output, /read_symbol/, "so must the by-name route");
  await chassis.dispose?.();
});

test("without a code map, it still says how to proceed", async () => {
  // A language tree-sitter cannot parse gets no outline. Naming read_symbol here would
  // be pointing at a tool that cannot answer either, so the reply offers only what works.
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const r = await readFile.execute({ paths: [name] }, ctx);
  assert.match(r.output, /offset/, "the follow-up must be named");
  assert.match(r.output, /too large/);
});

test("a small file is unaffected", async () => {
  // The budget must not change ordinary reading. Most files are small and reading one
  // whole is the right thing to do.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "small.ts"), "export const a = 1;\nexport const b = 2;\n");
  const r = await readFile.execute({ paths: ["small.ts"] }, ctx);
  assert.match(r.output, /export const a = 1;/);
  assert.doesNotMatch(r.output, /too large/);
});

test("a RANGE of a large file is never budgeted", async () => {
  // Asking for specific lines is already the careful behaviour. Second-guessing it would
  // cost a round trip and teach the model that being precise is punished.
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const r = await readFile.execute({ paths: [name], offset: 900, limit: 3 }, ctx);
  assert.match(r.output, /export function fn899/, "a ranged read must return the lines asked for");
  assert.doesNotMatch(r.output, /too large/);
});

test("a large file is not recorded as fully read", async () => {
  // The presence flag is the read-dedup's whole basis and unlocks editing. Marking a
  // file the model never saw as "read" would let a later re-read be answered "unchanged
  // since you last read it" for content it was never shown.
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const chassis = new CodeChassis(ctx.cwd, { lsp: false });
  await chassis.build();
  (ctx as { chassis?: unknown }).chassis = chassis;

  const r = await readFile.execute({ paths: [name] }, ctx);
  assert.match(r.output, /fn900/, "guard: this must be the outline path, not the no-map fallback");
  assert.equal(r.fullContentOf, undefined, "an outlined file must not claim its content was sent");
  assert.equal(ctx.reads.get(join(ctx.cwd, name))?.full, undefined, "nor record itself as fully read");
  await chassis.dispose?.();
});

test("the outlined reply is far smaller than the file it stands in for", async () => {
  // The entire point is the size difference. If the structure cost as much as the text,
  // this would be ceremony.
  const ctx = freshCtx();
  const name = await bigFile(ctx);
  const onDisk = (await fs.readFile(join(ctx.cwd, name), "utf8")).length;
  const r = await readFile.execute({ paths: [name] }, ctx);
  assert.ok(r.output.length < onDisk / 2, `reply was ${r.output.length} against a ${onDisk}-char file`);
});
