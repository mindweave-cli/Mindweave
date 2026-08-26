/**
 * clearSession.test.ts — what `/clear` must carry across, and what it must drop.
 *
 * `/clear` builds a brand-new session in the same folder. "Brand new" is the easy half;
 * the hard half is that some things belong to the FOLDER rather than to the
 * conversation, and losing those is silent. A multi-root workspace is the sharpest
 * case: someone runs `/include ../backend`, works across both for an hour, types
 * `/clear`, and every tool goes back to seeing one folder with nothing said about it.
 *
 * This is a real hazard rather than a hypothetical: `createSession` hardcoded `[cwd]`,
 * and the only path that restored added roots was `resumeSession`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mindweave-clear-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.MINDWEAVE_STATE_DIR = join(HOME, "state");

const { createSession } = await import("../memory/session.js");
const { rootsOf } = await import("../tools/paths.js");

function project(): { root: string; extra: string } {
  const root = mkdtempSync(join(tmpdir(), "mindweave-proj-"));
  const extra = join(root, "..", `sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(extra, { recursive: true });
  return { root, extra };
}

test("a fresh session in the same folder keeps the folders that were added to it", async () => {
  const { root, extra } = project();
  const first = await createSession(root);
  assert.deepEqual(rootsOf(first.toolContext).length, 1, "a new session should start with just its own root");

  // What /clear does: build a new session carrying the roots the old one had.
  const cleared = await createSession(root, [extra]);
  const roots = rootsOf(cleared.toolContext);
  assert.equal(roots.length, 2, "the added folder was dropped — every tool silently narrows to one root");
  assert.equal(roots[0], first.cwd, "the primary root must stay first; labels and relativization depend on it");

  await Promise.all([first, cleared].map((s) => stop(s)));
});

test("a folder that has since been deleted is not carried into the new session", async () => {
  // Otherwise the new session starts with a root that cannot be read, and every
  // search across it fails for a reason nothing explains.
  const { root } = project();
  const gone = join(root, "..", "definitely-not-here-" + Date.now());
  const s = await createSession(root, [gone]);
  assert.deepEqual(rootsOf(s.toolContext), [s.cwd], "a missing folder was carried over");
  await stop(s);
});

test("the primary root is never duplicated if it is also passed as extra", async () => {
  const { root } = project();
  const s = await createSession(root, [root]);
  const roots = rootsOf(s.toolContext);
  assert.equal(roots.length, 1, `the primary root appears twice: ${roots.join(", ")}`);
  await stop(s);
});

/** Chassis lanes are real background work; leaving them running hangs the run. */
async function stop(s: Awaited<ReturnType<typeof createSession>>): Promise<void> {
  const { stopChassis } = await import("../alternator/lane.js");
  s.toolContext.backgroundShells?.dispose();
  await s.toolContext.mcp?.dispose();
  for (const ch of s.toolContext.chassisByRoot?.values() ?? []) await stopChassis(ch);
}

/**
 * Undo history across a `/clear`.
 *
 * Clearing a conversation does not un-edit the files. The checkpoints are the only
 * record of what they looked like before, they live entirely in memory, and a fresh
 * tool context builds an empty `Checkpoints` — so without this the user is left with
 * modified files and no way back.
 */
test("undo history survives starting a fresh conversation", async () => {
  const { carryAcrossFreshSession } = await import("./sessionCarry.js");
  const { root } = project();
  const before = await createSession(root);
  const target = join(root, "touched.txt");
  before.toolContext.checkpoints!.backup(target, null, "new content");
  before.toolContext.checkpoints!.seal("an edit");
  assert.equal(before.toolContext.checkpoints!.hasUndo(), true, "the fixture did not create undo history");

  const after = await createSession(root);
  assert.equal(after.toolContext.checkpoints!.hasUndo(), false, "a fresh context should start empty");

  carryAcrossFreshSession(before.toolContext, after.toolContext);
  assert.equal(
    after.toolContext.checkpoints!.hasUndo(),
    true,
    "the files are still edited and /undo can no longer reach them",
  );

  await Promise.all([before, after].map((s) => stop(s)));
});

test("what the model was told does NOT survive", async () => {
  const { carryAcrossFreshSession } = await import("./sessionCarry.js");
  const { root } = project();
  const before = await createSession(root);
  before.toolContext.reads.set(join(root, "seen.ts"), { at: Date.now() } as never);
  before.toolContext.todos = [{ text: "old work", status: "pending" } as never];

  const after = await createSession(root);
  carryAcrossFreshSession(before.toolContext, after.toolContext);

  // A ledger saying a file is already in context makes the model skip reading it —
  // but the new conversation never showed it anything.
  assert.equal(after.toolContext.reads.size, 0, "the read ledger carried over and now lies to the model");
  assert.deepEqual(after.toolContext.todos, [], "a task list for work the model can no longer see carried over");

  await Promise.all([before, after].map((s) => stop(s)));
});
