/**
 * search.test.ts — the merged search tool: which underlying search a call means, and
 * that neither it nor the task list ever reaches the screen.
 *
 * `grep` and `glob` were two tools answering one question ("where is it?"), differing
 * only in which half of a file they looked at. What is pinned here is the routing —
 * the part a merge can get subtly wrong — and the third case that did not previously
 * exist as one call: contents searched only within files matching a path glob.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search } from "./search.js";
import { todoWrite } from "./todo.js";
import type { ToolContext } from "./types.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-search-")));
  return { cwd: dir, reads: new Map(), todos: [] };
}

async function seed(ctx: ToolContext) {
  await fs.mkdir(join(ctx.cwd, "src"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "src/a.ts"), "export const a = 1;\n// TODO: fix\n");
  await fs.writeFile(join(ctx.cwd, "src/b.ts"), "export const b = 2;\n");
  await fs.writeFile(join(ctx.cwd, "readme.md"), "# hi\nTODO later\n");
}

test("`files` alone searches by PATH", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await search.execute({ files: "**/*.ts" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.match(r.output, /src\/b\.ts/);
  assert.doesNotMatch(r.output, /readme\.md/, "a path search must not match by content");
});

test("`pattern` alone searches file CONTENTS", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await search.execute({ pattern: "TODO", output_mode: "content" }, ctx);
  assert.match(r.output, /src\/a\.ts:2:/);
  assert.match(r.output, /readme\.md:2:/, "contents search spans file types");
});

test("both together: contents, restricted to files matching the path glob", async () => {
  // The case the merge exists for. It was reachable before only by knowing that grep
  // had its own `glob` argument — otherwise it took two calls and a decision.
  const ctx = freshCtx();
  await seed(ctx);
  const r = await search.execute({ pattern: "TODO", files: "*.ts", output_mode: "content" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.doesNotMatch(r.output, /readme\.md/, "`files` must narrow the contents search");
});

test("neither argument LISTS — one level, directories marked", async () => {
  // The old third tool. Asking for nothing to match by means "show me what is here",
  // which is what a model reaching for a listing wanted; there is no longer a call
  // shape that does nothing.
  const ctx = freshCtx();
  await seed(ctx);
  await fs.mkdir(join(ctx.cwd, "src/nested"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "src/nested/c.ts"), "export const c = 3;\n");

  const r = await search.execute({ path: "src" }, ctx);
  assert.match(r.output, /a\.ts/);
  // Only a listing does these two things, so a path-glob fallback cannot pass here:
  // a directory shown as an ENTRY with a trailing slash, and its contents NOT walked.
  assert.match(r.output, /nested\//, "a directory is an entry, marked with a slash");
  assert.doesNotMatch(r.output, /c\.ts/, "one level only — the subdirectory is not descended");
});

test("listing reports the DISK, so it still shows what the searches cannot reach", async () => {
  // The property that made list_dir worth keeping: it is the only way to learn that a
  // file exists but is not searchable. Folding it in must not quietly lose that.
  const ctx = freshCtx();
  await seed(ctx);
  await fs.mkdir(join(ctx.cwd, "node_modules/pkg"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "node_modules/pkg/index.ts"), "hidden\n");

  const listed = await search.execute({}, ctx);
  assert.match(listed.output, /node_modules/, "the listing must show what search skips");
  const searched = await search.execute({ files: "**/*.ts" }, ctx);
  assert.doesNotMatch(searched.output, /node_modules/, "…while the search still skips it");
});

test("an invalid regex is reported, not thrown", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await search.execute({ pattern: "(" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /invalid regular expression/i);
});

test("search NEVER renders a row, whichever way it is called", async () => {
  // The user's call: searching is how the agent finds its way around, not work done to
  // the project. Asserted on every path, including the error, because a row that only
  // appears when something went wrong is the one most likely to slip back in.
  const ctx = freshCtx();
  await seed(ctx);
  for (const args of [{ files: "**/*.ts" }, { pattern: "TODO" }, { pattern: "(" }, {}, { path: "src" }]) {
    const r = await search.execute(args, ctx);
    assert.equal(r.quiet, true, `must be quiet for ${JSON.stringify(args)}`);
  }
});

test("the task list is kept for the model and never rendered", async () => {
  const ctx = freshCtx();
  const r = await todoWrite.execute(
    {
      todos: [
        { content: "one", activeForm: "doing one", status: "in_progress" },
        { content: "two", activeForm: "doing two", status: "pending" },
      ],
    },
    ctx,
  );
  assert.equal(r.quiet, true, "the checklist must not reach the stream");
  // Silent to the user, unchanged for the model: it still stores the list and still
  // hands back the full text. Hiding it must not turn it into a no-op.
  assert.equal(ctx.todos?.length, 2, "the list must still be stored");
  assert.match(r.output, /one/);
  assert.match(r.output, /two/);
});
