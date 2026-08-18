/**
 * shellCheckpoint.test.ts — a script that edits a file is now undoable.
 *
 * run_command was the one mutation path outside /undo, which mattered because
 * improvising with a script is a capability the tool set deliberately leans on. These
 * run REAL commands against REAL files rather than asserting on a mock, because the
 * whole mechanism is "did the bytes on disk move", and a mock cannot be wrong about
 * that in the way the filesystem can.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "./checkpoints.js";
import { runCommand } from "./runCommand.js";
import { looksReadOnly, snapshotBeforeCommand, captureAfterCommand } from "./shellCheckpoint.js";
import type { ToolContext } from "./types.js";

const IS_WINDOWS = process.platform === "win32";

async function project(files: Record<string, string>): Promise<{ root: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "mw-shellcp-"));
  const reads = new Map();
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await fs.writeFile(path, body, "utf8");
    const st = await fs.stat(path);
    reads.set(path, { mtimeMs: st.mtimeMs, size: st.size, full: true });
  }
  const ctx = {
    cwd: root,
    roots: [root],
    reads,
    todos: [],
    checkpoints: new Checkpoints(),
  } as unknown as ToolContext;
  return { root, ctx };
}

test("looksReadOnly recognises safe commands and doubts everything else", () => {
  for (const c of ["ls", "git status", "cat foo.txt", "pwd"]) {
    assert.equal(looksReadOnly(c), true, c);
  }
  // Anything unrecognised is treated as mutating: a wasted snapshot is cheap, a lost
  // file is not.
  for (const c of ["npm run build", "python fix.py", "sed -i s/a/b/ f.txt", "rm x"]) {
    assert.equal(looksReadOnly(c), false, c);
  }
  // A read-only-looking start that redirects is still a write.
  assert.equal(looksReadOnly("cat a.txt > b.txt"), false);
  assert.equal(looksReadOnly("ls | tee out.txt"), false);
});

test("a file changed between snapshot and capture is checked in with its old bytes", async () => {
  const { root, ctx } = await project({ "a.txt": "original\n" });
  const before = await snapshotBeforeCommand(ctx);
  assert.equal(before.size, 1, "the ledger's file must be snapshotted");

  // Something outside the write tools rewrites it — exactly the improvised-script case.
  await new Promise((r) => setTimeout(r, 20)); // clear coarse mtime granularity
  await fs.writeFile(join(root, "a.txt"), "rewritten by a script\n", "utf8");

  const changes = await captureAfterCommand(ctx, before);
  assert.deepEqual(changes.captured, [join(root, "a.txt")]);

  // The checkpoint holds the PRE-change bytes, which is the whole point.
  ctx.checkpoints!.seal("shell");
  assert.equal(ctx.checkpoints!.hasUndo(), true, "a checkpoint must exist to undo");
});

test("a file the command did not touch is not checked in", async () => {
  const { ctx } = await project({ "a.txt": "one\n", "b.txt": "two\n" });
  const before = await snapshotBeforeCommand(ctx);
  const changes = await captureAfterCommand(ctx, before);
  assert.deepEqual(changes.captured, [], "nothing moved, so nothing to undo");
});

test("a touched-but-identical file is not checked in", async () => {
  // A formatter that reformats to the same bytes, or a build that rewrites a file
  // unchanged, would otherwise create an undo entry that restores nothing.
  const { root, ctx } = await project({ "a.txt": "same\n" });
  const before = await snapshotBeforeCommand(ctx);
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(join(root, "a.txt"), "same\n", "utf8"); // new mtime, same content
  const changes = await captureAfterCommand(ctx, before);
  assert.deepEqual(changes.captured, [], "an identical rewrite is not a change");
});

test("a file DELETED by the command is captured, so undo can bring it back", async () => {
  const { root, ctx } = await project({ "gone.txt": "delete me\n" });
  const before = await snapshotBeforeCommand(ctx);
  await fs.rm(join(root, "gone.txt"));
  const changes = await captureAfterCommand(ctx, before);
  assert.deepEqual(changes.captured, [join(root, "gone.txt")]);
});

test("END TO END: a real shell command that edits a read file becomes undoable", async () => {
  const { root, ctx } = await project({ "app.txt": "version = 1\n" });
  const cmd = IS_WINDOWS
    ? `Set-Content -Path app.txt -Value 'version = 2'`
    : `printf 'version = 2\\n' > app.txt`;

  const r = await runCommand.execute({ command: cmd }, ctx);
  assert.ok(!r.isError, r.output);
  assert.match(await fs.readFile(join(root, "app.txt"), "utf8"), /version = 2/);

  // The point: run_command used to leave nothing to undo here.
  ctx.checkpoints!.seal("shell");
  assert.equal(ctx.checkpoints!.hasUndo(), true, "the shell's change must have produced a checkpoint");
  const [entry] = ctx.checkpoints!.list();
  assert.ok(entry, "and it must be listed as a restorable turn");
});

test("a read-only command does not pay for a snapshot", async () => {
  const { ctx } = await project({ "a.txt": "one\n" });
  const r = await runCommand.execute({ command: IS_WINDOWS ? "pwd" : "pwd" }, ctx);
  assert.ok(!r.isError, r.output);
  // Nothing changed, so regardless of snapshot policy there is nothing checked in.
  ctx.checkpoints!.seal("shell");
  assert.equal(ctx.checkpoints!.list().some((c) => c.files > 0), false, "a read of the tree undoes nothing");
});
