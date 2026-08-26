/**
 * projectMemory.test.ts — MINDWEAVE.md is bounded, and refreshing it is not free.
 *
 * Two separate problems, both about the CACHED system prefix rather than correctness:
 *
 *  - the file was read whole with no cap, while the prompt simultaneously told the
 *    model to keep it short and to update it at every stopping point. Only one of
 *    those is enforceable, so the file could only grow.
 *  - it was re-read at the start of every turn. When the bytes changed, the system
 *    prompt string changed, and the entire cached prefix (base prompt, tool schemas,
 *    project snapshot, governance) was discarded and rewritten at 1.25x input rate.
 *
 * These tests pin the fix for both: the render is capped and says so when it cuts,
 * and a refresh only happens when something actually changed AND asked for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadProjectMemory } from "./session.js";
import type { Session } from "./types.js";

async function projectWith(body: string): Promise<{ cwd: string; session: Session }> {
  const cwd = await mkdtemp(join(tmpdir(), "mw-pm-"));
  await fs.writeFile(join(cwd, "MINDWEAVE.md"), body, "utf8");
  // Only the fields this code path touches; the rest of a Session is irrelevant here.
  return { cwd, session: { cwd, projectMemory: "" } as unknown as Session };
}

test("a normal-sized MINDWEAVE.md is served whole", async () => {
  const { session } = await projectWith("# Facts\n\nThis project uses pnpm.");
  await reloadProjectMemory(session, { force: true });
  assert.equal(session.projectMemory, "# Facts\n\nThis project uses pnpm.");
});

test("an oversized MINDWEAVE.md is truncated, and SAYS it was truncated", async () => {
  // A silent cut is the dangerous version: the model acts confidently on half a
  // document with no way to know the rest exists.
  const huge = Array.from({ length: 4000 }, (_, i) => `- fact number ${i}`).join("\n");
  const { session } = await projectWith(huge);
  await reloadProjectMemory(session, { force: true });

  assert.ok(session.projectMemory.length < huge.length, "the cap must actually bite");
  assert.ok(session.projectMemory.length < 20_000, "and bound the result");
  assert.match(session.projectMemory, /truncated/i, "the model has to be told it is not seeing all of it");
  assert.match(session.projectMemory, /Read the file directly/i, "and how to get the rest");
  assert.ok(session.projectMemory.startsWith("- fact number 0"), "the beginning is kept, not the end");
});

test("a missing MINDWEAVE.md is empty, not an error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mw-pm-none-"));
  const session = { cwd, projectMemory: "stale" } as unknown as Session;
  await reloadProjectMemory(session, { force: true });
  assert.equal(session.projectMemory, "");
});

test("CACHE CONTRACT: a reload does nothing unless the file was marked stale", async () => {
  // This is the whole point. An unconditional re-read looked free and was not: it
  // rewrites the system prompt string and voids the cached prefix.
  const { cwd, session } = await projectWith("original");
  await reloadProjectMemory(session, { force: true });
  assert.equal(session.projectMemory, "original");

  // The file changes, but nothing has told the session about it.
  await fs.writeFile(join(cwd, "MINDWEAVE.md"), "rewritten", "utf8");
  await reloadProjectMemory(session);
  assert.equal(session.projectMemory, "original", "the frozen copy must survive an unflagged turn");
});

test("once marked stale, the next reload picks the file up and clears the flag", async () => {
  const { cwd, session } = await projectWith("original");
  await reloadProjectMemory(session, { force: true });

  await fs.writeFile(join(cwd, "MINDWEAVE.md"), "rewritten", "utf8");
  session.projectMemoryStale = true;
  await reloadProjectMemory(session);

  assert.equal(session.projectMemory, "rewritten");
  assert.equal(session.projectMemoryStale, false, "a consumed flag must not refresh again next turn");
});

/**
 * Which tool calls mark the project memory stale.
 *
 * This is the hinge of the whole "the agent maintains its own notes" loop. A false
 * negative here means the edit the model just made is silently dropped from the next
 * session's context, and nothing anywhere reports it — the file on disk is right and
 * the agent starts the next session not knowing what it wrote.
 *
 * `/init` makes this sharper than it used to be: MINDWEAVE.md is now routinely CREATED
 * mid-session, by write_file, in a session that started without one.
 */
test("creating MINDWEAVE.md mid-session counts, not just editing it", async () => {
  const { touchesProjectMemory } = await import("../dynamo/engine.js");
  // The /init path: the file did not exist when the session started.
  assert.equal(touchesProjectMemory("write_file", { path: "MINDWEAVE.md" }), true);
  assert.equal(touchesProjectMemory("edit", { path: "MINDWEAVE.md" }), true);
  assert.equal(touchesProjectMemory("replace_symbol_body", { path: "MINDWEAVE.md" }), true);
});

test("it is found however the model spells the path", async () => {
  const { touchesProjectMemory } = await import("../dynamo/engine.js");
  // The model passes paths relative, absolute, through a workspace root, and with
  // either separator. Missing any spelling loses the update silently.
  for (const path of [
    "MINDWEAVE.md",
    "./MINDWEAVE.md",
    ["D:", "projects", "app", "MINDWEAVE.md"].join(String.fromCharCode(92)),
    "/home/me/app/MINDWEAVE.md",
    "backend/MINDWEAVE.md",
    "  MINDWEAVE.md  ",
    "mindweave.md",
  ]) {
    assert.equal(touchesProjectMemory("write_file", { path }), true, `missed: ${JSON.stringify(path)}`);
  }
});

test("it does not fire on files that merely look similar", async () => {
  const { touchesProjectMemory } = await import("../dynamo/engine.js");
  for (const path of ["MINDWEAVE.md.bak", "NOTMINDWEAVE.md", "docs/MINDWEAVE.md.tmp", "MINDWEAVE.txt"]) {
    assert.equal(touchesProjectMemory("write_file", { path }), false, `false positive: ${path}`);
  }
  // A read is not a write.
  assert.equal(touchesProjectMemory("read_file", { path: "MINDWEAVE.md" }), false);
  assert.equal(touchesProjectMemory("search", { path: "MINDWEAVE.md" }), false);
});

test("a malformed or missing path argument is not a crash", async () => {
  const { touchesProjectMemory } = await import("../dynamo/engine.js");
  assert.equal(touchesProjectMemory("write_file", {}), false);
  assert.equal(touchesProjectMemory("write_file", { path: 42 as unknown as string }), false);
  assert.equal(touchesProjectMemory("write_file", { path: "" }), false);
});
