/**
 * screenStore.test.ts — the shell a project is worked in, remembered.
 *
 * The rule that matters is what happens when the file is missing, unreadable or holding
 * something that is not a mode. Every one of those has to end as "no preference", because
 * a session that opens in the wrong shell costs one command while a session that fails to
 * open costs everything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScreenMode, saveScreenMode } from "./screenStore.js";
import { parseSavedMode, startupMode } from "./screenMode.js";

function project(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "mw-screen-")));
}

test("what was saved is what comes back", async () => {
  const root = project();
  await saveScreenMode(root, "inline");
  assert.equal(await loadScreenMode(root), "inline");
  await saveScreenMode(root, "fullscreen");
  assert.equal(await loadScreenMode(root), "fullscreen");
});

test("a project that has never chosen has no preference", async () => {
  assert.equal(await loadScreenMode(project()), null);
});

test("two projects remember separately", async () => {
  // The whole point of storing it per project: one repo worked over ssh and another
  // locally want different answers, and a global setting would make them fight.
  const a = project();
  const b = project();
  await saveScreenMode(a, "inline");
  await saveScreenMode(b, "fullscreen");
  assert.equal(await loadScreenMode(a), "inline");
  assert.equal(await loadScreenMode(b), "fullscreen");
});

test("a corrupt or foreign file reads as no preference, never as a crash", async () => {
  // Half-written by a machine that lost power, or written by a later version that keeps
  // something else there. Neither may stop the app starting.
  const { projectDir } = await import("../memory/store.js");
  const root = project();
  await fs.mkdir(projectDir(root), { recursive: true });
  const path = join(projectDir(root), "screen.json");

  await fs.writeFile(path, "{not json", "utf8");
  assert.equal(await loadScreenMode(root), null);

  await fs.writeFile(path, JSON.stringify({ screen: "hologram" }), "utf8");
  assert.equal(await loadScreenMode(root), null);

  await fs.writeFile(path, JSON.stringify({ somethingElse: true }), "utf8");
  assert.equal(await loadScreenMode(root), null);
});

test("saving into an unwritable place is survivable", async () => {
  // Best-effort by design: failing to remember a preference is worth nothing next to
  // failing to start.
  await assert.doesNotReject(() => saveScreenMode("\0::not a path::", "inline"));
});

test("parseSavedMode accepts only the two modes", () => {
  assert.equal(parseSavedMode("inline"), "inline");
  assert.equal(parseSavedMode("fullscreen"), "fullscreen");
  for (const junk of [null, undefined, 1, "INLINE", "full", {}, []]) {
    assert.equal(parseSavedMode(junk), null, `${JSON.stringify(junk)} was accepted as a mode`);
  }
});

test("the env var beats the saved choice, and the saved choice beats the default", () => {
  // The order is the feature: a single laggy ssh session can be started inline without
  // changing what the project keeps, and a project that chose inline opens inline.
  assert.equal(startupMode("fullscreen", "inline"), "fullscreen", "the env var did not win");
  assert.equal(startupMode("inline", "fullscreen"), "inline", "the env var did not win");
  assert.equal(startupMode(undefined, "inline"), "inline", "the saved choice was ignored");
  assert.equal(startupMode(undefined, null), "fullscreen");
  assert.equal(startupMode("nonsense", "inline"), "inline", "junk in the env var buried the saved choice");
});
