/**
 * quietFailures.test.ts — which failures the user sees, and which the model fixes alone.
 *
 * A tool call whose ARGUMENTS are malformed is not news. The model wrote the call wrong,
 * gets told exactly what was wrong, and rewrites it on the next step with no user
 * involvement. Painting a red row for that teaches the user to ignore red rows, which
 * costs them the ones that matter. So those results are marked `quiet`: the model still
 * receives the full error, the transcript still records it, and the UI drops the row.
 *
 * The same line is drawn from the other side by schema validation, which collapses
 * to a flat "Invalid tool parameters" on screen while the model gets the detail and a
 * schema hint. Their own comment beside it: the model is not great at generating valid
 * input. It is routine, not an incident.
 *
 * What is defended here: the argument-shape rejections are quiet AND still complete for
 * the model, and the failures that are real news stayed visible. The second half is the
 * one that can rot — quieting is easy to over-apply, and a silently swallowed refusal is
 * far worse than a noisy one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { globDef } from "./glob.js";
import { todoWrite } from "./todo.js";
import { web } from "./web.js";
import { saveMemoryTool } from "./saveMemory.js";
import { listDir } from "./listDir.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-quiet-")));
  return { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
}

/** Every malformed-argument rejection, whatever the tool, behaves the same way. */
const ARG_REJECTIONS: [string, Tool, Record<string, unknown>][] = [
  ["read_file with no paths", readFile, { paths: [] }],
  ["write_file with no content", writeFile, { path: "a.ts" }],
  ["glob with no pattern", globDef, {}],
  ["todo_write given a string", todoWrite, { todos: "not an array" }],
  ["web asked for both at once", web, { query: "a", url: "https://example.com" }],
  ["web asked for neither", web, {}],
  ["save_memory with an unknown type", saveMemoryTool, { name: "n", body: "b", type: "nonsense" }],
];

for (const [what, tool, args] of ARG_REJECTIONS) {
  test(`${what} is quiet, and the model still gets the reason`, async () => {
    const r = await tool.execute(args, freshCtx());
    assert.equal(r.isError, true, "still a failure for the model");
    assert.equal(r.quiet, true, "an argument mistake must not paint a red row");
    // The whole point of quieting is that it is a DISPLAY decision. If the reason were
    // thinned out too, the model would lose what it needs to correct itself.
    assert.match(r.output, /^Error: .+/, "the model must still be told what was wrong");
    assert.ok((r.summary ?? "").length > 0, "the transcript still records a reason");
  });
}

test("a missing directory is real news and stays visible", async () => {
  // Not the model's call being malformed — a fact about the project the user may want to
  // know. Quieting this class is the failure mode this test exists to catch.
  const ctx = freshCtx();
  const r = await listDir.execute({ path: "no-such-dir" }, ctx);
  assert.equal(r.isError, true);
  assert.notEqual(r.quiet, true, "a missing directory was hidden from the user");
});

test("the read-before-overwrite gate stays visible", async () => {
  // A protection firing is news. The model can resolve it (by reading first), but the
  // user should see that an overwrite was stopped.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "exists.ts"), "original\n");
  const r = await writeFile.execute({ path: "exists.ts", content: "replaced" }, ctx);
  assert.equal(r.isError, true);
  assert.notEqual(r.quiet, true, "a blocked overwrite was hidden from the user");
  assert.equal(await fs.readFile(join(ctx.cwd, "exists.ts"), "utf8"), "original\n");
});
