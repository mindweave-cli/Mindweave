/**
 * workspaceBoundary.test.ts — writing outside the folders the user opened.
 *
 * Lightning means "do not ask me about the work", and everything inside the workspace
 * IS the work. A path outside all of it is a different claim: nothing the user chose
 * says the agent may write there, and an absolute path is easy for a model to produce
 * from a stale assumption about where it is. Measured before this existed: a write to a
 * folder outside every root succeeded with no prompt at all.
 *
 * The line is drawn where it is because an auto-accept mode allows a write only when the
 * path is inside an allowed working directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "./writeFile.js";
import { edit } from "./edit.js";
import { insideWorkspace } from "./approval.js";
import type { ToolContext } from "./types.js";

function dirs() {
  return {
    root: realpathSync.native(mkdtempSync(join(tmpdir(), "mw-inside-"))),
    away: realpathSync.native(mkdtempSync(join(tmpdir(), "mw-away-"))),
  };
}

function ctx(root: string, answer?: string): ToolContext {
  return {
    cwd: root,
    roots: [root],
    reads: new Map(),
    todos: [],
    ...(answer === undefined ? {} : { requestApproval: async () => answer }),
  } as unknown as ToolContext;
}

test("insideWorkspace answers for the root itself, its children, and a sibling", () => {
  const { root, away } = dirs();
  const c = ctx(root);
  assert.equal(insideWorkspace(c, root), true, "the root itself is inside it");
  assert.equal(insideWorkspace(c, join(root, "src", "a.ts")), true);
  assert.equal(insideWorkspace(c, away), false);
  // A sibling whose name merely STARTS with the root's must not count as inside it.
  assert.equal(insideWorkspace(c, `${root}-other/file.ts`), false, "prefix match is not containment");
});

test("a write outside the workspace is refused when the user declines", async () => {
  const { root, away } = dirs();
  const c = ctx(root, "No, keep to the workspace");
  const target = join(away, "stranger.txt");

  const r = await writeFile.execute({ path: target, content: "x" }, c);
  assert.equal(r.isError, true);
  await assert.rejects(() => fs.readFile(target, "utf8"), "the file was written anyway");
});

test("a write outside the workspace goes ahead when the user allows it", async () => {
  const { root, away } = dirs();
  const c = ctx(root, "Yes, write it");
  const target = join(away, "allowed.txt");

  const r = await writeFile.execute({ path: target, content: "hello" }, c);
  assert.notEqual(r.isError, true, r.output);
  assert.equal(await fs.readFile(target, "utf8"), "hello");
});

test("allowing the FOLDER stops it asking again for that folder, but not for another", async () => {
  const { root, away } = dirs();
  let asks = 0;
  const c = {
    ...ctx(root),
    requestApproval: async () => {
      asks++;
      return "Yes, and allow this folder for the session";
    },
  } as unknown as ToolContext;

  await writeFile.execute({ path: join(away, "one.txt"), content: "a" }, c);
  await writeFile.execute({ path: join(away, "two.txt"), content: "b" }, c);
  assert.equal(asks, 1, "the folder grant was not honoured");

  // A different folder is a different claim and must be asked about.
  const { away: elsewhere } = dirs();
  await writeFile.execute({ path: join(elsewhere, "three.txt"), content: "c" }, c);
  assert.equal(asks, 2, "the grant leaked to a folder the user never saw");
});

test("with no way to ask, the write does NOT happen", async () => {
  // Fails closed, like every other gate here. A sub-agent has no channel to the user.
  const { root, away } = dirs();
  const target = join(away, "silent.txt");

  const r = await writeFile.execute({ path: target, content: "x" }, ctx(root));
  assert.equal(r.isError, true);
  assert.match(r.output, /outside the workspace/);
  await assert.rejects(() => fs.readFile(target, "utf8"), "a sub-agent wrote outside the workspace unasked");
});

test("work INSIDE the workspace is never interrupted by this", async () => {
  // The whole point of Lightning is not being asked about the work. If this fires for
  // ordinary edits it is worse than the hole it closes.
  const { root } = dirs();
  let asked = false;
  const c = {
    ...ctx(root),
    requestApproval: async () => {
      asked = true;
      return "No, keep to the workspace";
    },
  } as unknown as ToolContext;

  const r = await writeFile.execute({ path: join(root, "src", "a.ts"), content: "ok" }, c);
  assert.notEqual(r.isError, true, r.output);
  assert.equal(asked, false, "an ordinary in-workspace write asked for permission");
});

test("the same boundary covers edit, not just write_file", async () => {
  const { root, away } = dirs();
  const target = join(away, "edit-me.txt");
  await fs.writeFile(target, "before\n");
  const c = ctx(root, "No, keep to the workspace");
  c.reads.set(target, { mtimeMs: 1, size: 7, full: true, touchedAt: 1 });

  const r = await edit.execute({ path: target, edits: [{ old_string: "before", new_string: "after" }] }, c);
  assert.equal(r.isError, true);
  assert.equal(await fs.readFile(target, "utf8"), "before\n", "edit slipped past the boundary");
});
