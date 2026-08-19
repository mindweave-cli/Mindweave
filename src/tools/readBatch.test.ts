/**
 * readBatch.test.ts — read_file taking a list of files.
 *
 * The reason this shape exists is a measurement, not a preference. A real session read
 * four files as four separate model calls, and each call re-sends the whole conversation
 * to the provider — so those four reads cost several times what one read of four files
 * costs, and took four times as long. The prompt asks the model to batch, in two places,
 * in plain language, and it did not once in twenty-three consecutive tool calls. So the
 * batching moved into the tool, where it does not depend on the model agreeing.
 *
 * What is defended here: the list actually works, one bad path cannot destroy the good
 * results (that would cost the extra round trip this exists to avoid), a range still
 * means one file, and a session resumed from the old single-path schema still runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-readbatch-")));
  return { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
}

async function seed(ctx: ToolContext, names: string[]): Promise<void> {
  for (const n of names) await fs.writeFile(join(ctx.cwd, n), `content of ${n}\nsecond line\n`);
}

test("one call reads several files, each labelled", async () => {
  const ctx = freshCtx();
  await seed(ctx, ["a.ts", "b.ts", "c.ts"]);
  const r = await readFile.execute({ paths: ["a.ts", "b.ts", "c.ts"] }, ctx);
  assert.equal(r.isError, undefined);
  for (const n of ["a.ts", "b.ts", "c.ts"]) {
    assert.match(r.output, new RegExp(`=+ ${n} =+`), `${n} is not labelled in the output`);
    assert.match(r.output, new RegExp(`content of ${n}`), `${n}'s content is missing`);
  }
  assert.match(r.summary ?? "", /3 files/);
});

test("every file in a batch is recorded as read, so all three can be edited", async () => {
  // The read ledger is what unlocks editing. If a batch recorded only the first file,
  // editing the other two would be refused and the model would re-read them one by one —
  // turning the saving straight back into the round trips it was meant to remove.
  const ctx = freshCtx();
  await seed(ctx, ["a.ts", "b.ts", "c.ts"]);
  const r = await readFile.execute({ paths: ["a.ts", "b.ts", "c.ts"] }, ctx);
  assert.equal(ctx.reads.size, 3, "not every file in the batch entered the read ledger");
  assert.equal((r.fullContentOf ?? []).length, 3, "presence must name every whole file sent");
});

test("one bad path does not throw away the good results", async () => {
  // Failing the whole call would cost another full round trip to recover the three files
  // that were read perfectly well — the precise cost this tool exists to avoid.
  const ctx = freshCtx();
  await seed(ctx, ["a.ts", "b.ts"]);
  const r = await readFile.execute({ paths: ["a.ts", "nope.ts", "b.ts"] }, ctx);
  assert.match(r.output, /content of a\.ts/);
  assert.match(r.output, /content of b\.ts/);
  assert.match(r.output, /File not found: nope\.ts/);
  assert.match(r.summary ?? "", /1 failed/);
});

test("a single path keeps its old output exactly — no header, no count", async () => {
  // A batch of one must not become a different-looking result. The row, the summary and
  // the body are what every other tool and test already expects.
  const ctx = freshCtx();
  await seed(ctx, ["a.ts"]);
  const r = await readFile.execute({ paths: ["a.ts"] }, ctx);
  assert.doesNotMatch(r.output, /=====/, "a single read gained a header it never had");
  assert.match(r.summary ?? "", /^read a\.ts \(/);
});

test("a range means ONE file, and asking for both is refused", async () => {
  // offset/limit name lines. Spread across a list they would return a different slice of
  // each file, which looks like an answer and is not one.
  const ctx = freshCtx();
  await seed(ctx, ["a.ts", "b.ts"]);
  const r = await readFile.execute({ paths: ["a.ts", "b.ts"], offset: 2 }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /single path/);
});

test("a range still works on one file", async () => {
  const ctx = freshCtx();
  await seed(ctx, ["a.ts"]);
  const r = await readFile.execute({ paths: ["a.ts"], offset: 2, limit: 1 }, ctx);
  assert.match(r.output, /second line/);
  assert.doesNotMatch(r.output, /content of a\.ts/);
});

test("the batch is capped rather than pulling the repository into context", async () => {
  const ctx = freshCtx();
  const names = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
  await seed(ctx, names);
  const r = await readFile.execute({ paths: names }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /at most/);
});

test("RESUME: a tool call made under the old single-path schema still runs", async () => {
  // A resumed session replays calls the model made before this change. Refusing them
  // would turn every /continue on an older session into a wall of errors.
  const ctx = freshCtx();
  await seed(ctx, ["a.ts"]);
  const r = await readFile.execute({ path: "a.ts" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /content of a\.ts/);
});

test("no paths at all is a clear error, not an empty success", async () => {
  const ctx = freshCtx();
  const r = await readFile.execute({ paths: [] }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /required/);
});
