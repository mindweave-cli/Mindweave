/**
 * keyStore.test.ts — more than one key per provider, stored without losing any.
 *
 * The first design used the bare `DEEPSEEK_API_KEY` as both "stored key 1" and "the key
 * currently live". It reads neatly and destroys data: switching to key 3 overwrote the
 * variable that WAS key 1, so key 1 vanished and the next removal duplicated key 3 into
 * its place. Found by exercising add, use and remove and reading the file back — not by
 * reading the code, which looked right.
 *
 * So: keys are STORED in `VAR_1..VAR_9`, and the bare `VAR` is only ever the live one,
 * which is what every driver reads. These hold that line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { activeSlot, keyHint, keysFor, nextFreeSlot, slotVar } from "./keyStore.js";
import { globalEnvPath, hasApiKey, loadConfig, removeApiKey, saveApiKey, useApiKey } from "./bootstrap.js";

const V = "DEEPSEEK_API_KEY";

/** A machine with no keys at all. */
function fresh(): void {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "keystore-"));
  for (const k of Object.keys(process.env)) if (k.startsWith(V)) delete process.env[k];
  loadConfig(mkdtempSync(join(tmpdir(), "keystore-proj-")));
}

const stored = () => keysFor(V).map((k) => `${k.slot}:${k.value}`).join(" ");

test("three keys are stored, and all three survive", () => {
  fresh();
  saveApiKey(V, "key-one");
  saveApiKey(V, "key-two", 2);
  saveApiKey(V, "key-three", 3);
  assert.equal(stored(), "1:key-one 2:key-two 3:key-three");
  assert.equal(nextFreeSlot(V), 4);
});

test("choosing a key changes what is sent, and changes nothing else", () => {
  fresh();
  saveApiKey(V, "key-one");
  saveApiKey(V, "key-two", 2);
  assert.equal(activeSlot(V), 1);

  useApiKey(V, 2);
  assert.equal(process.env[V], "key-two", "the drivers are still sending the old key");
  assert.equal(activeSlot(V), 2);
  // THE bug this file exists for: the other key must still be there afterwards.
  assert.equal(stored(), "1:key-one 2:key-two", "choosing a key destroyed another one");
});

test("removing a key closes the gap behind it", () => {
  fresh();
  saveApiKey(V, "key-one");
  saveApiKey(V, "key-two", 2);
  saveApiKey(V, "key-three", 3);
  removeApiKey(V, 2);
  assert.equal(stored(), "1:key-one 2:key-three", "a hole was left, or a key was duplicated");
  assert.equal(nextFreeSlot(V), 3);
});

test("removing the key in use falls back to one that still exists", () => {
  fresh();
  saveApiKey(V, "key-one");
  saveApiKey(V, "key-two", 2);
  useApiKey(V, 2);
  removeApiKey(V, 2);
  assert.equal(process.env[V], "key-one", "the provider was left pointing at a key that is gone");
  assert.equal(hasApiKey(V), true);
});

test("removing the last key leaves the provider with nothing, not with a ghost", () => {
  fresh();
  saveApiKey(V, "only-key");
  removeApiKey(V, 1);
  assert.equal(stored(), "");
  assert.equal(hasApiKey(V), false, "a removed key is still being sent");
  assert.doesNotMatch(readFileSync(globalEnvPath(), "utf8"), /only-key/, "it is still on disk");
});

test("keys survive a restart", () => {
  // Nothing on disk fills the LIVE variable, so a reload has to point each provider at
  // its first stored key. Without that a key added through /key is written, reloaded,
  // and then invisible: the app asks for a key it already has.
  fresh();
  saveApiKey(V, "key-one");
  saveApiKey(V, "key-two", 2);
  const cwd = mkdtempSync(join(tmpdir(), "keystore-restart-"));

  for (const k of Object.keys(process.env)) if (k.startsWith(V)) delete process.env[k];
  loadConfig(cwd);

  assert.equal(stored(), "1:key-one 2:key-two", "the stored keys did not come back");
  assert.equal(hasApiKey(V), true, "a key that was saved is invisible after a restart");
  assert.equal(process.env[V], "key-one");
});

test("a config that predates slots still works, and is migrated once", () => {
  // An existing user, or anyone exporting the variable in their shell, has only the bare
  // name. It counts as the one stored key so nothing they had disappears.
  fresh();
  process.env[V] = "legacy-key";
  assert.equal(stored(), "1:legacy-key");

  saveApiKey(V, "second", 2);
  assert.equal(keysFor(V).find((k) => k.slot === 1)?.value, "legacy-key", "the original key was lost");
  assert.equal(keysFor(V).length, 2);
  assert.ok(readFileSync(globalEnvPath(), "utf8").includes(`${slotVar(V, 1)}=legacy-key`), "not migrated to a slot");
});

// Set up an empty machine, then seed the global env file the way a person might have
// written it by hand, and load it. Returns nothing — the point is what is in process.env
// and on disk afterwards.
function seeded(initial: string): void {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "keystore-seed-"));
  for (const k of Object.keys(process.env)) if (k.startsWith(V)) delete process.env[k];
  loadConfig(mkdtempSync(join(tmpdir(), "keystore-seed-proj-")));
  writeFileSync(globalEnvPath(), initial);
  loadConfig(process.cwd()); // re-read now that the file exists
}

// A key can be written into the global file the way a person writes env files: with an
// `export` prefix, or indented. The reader accepts both, so the writer has to find those
// lines too — otherwise an update appends a second line and the stale one wins next launch.
for (const [shape, initial] of [
  ["export VAR=", `export ${V}=old-key\n`],
  ["indented VAR=", `   ${V}=old-key\n`],
  ["plain VAR=", `${V}=old-key\n`],
] as const) {
  test(`updating a key written as "${shape}" replaces it, and it stays replaced after a restart`, () => {
    seeded(initial);
    assert.equal(process.env[V], "old-key", "the reader did not load the seeded key");

    saveApiKey(V, "new-key");
    assert.equal(process.env[V], "new-key", "the new key is not live this session");

    // Relaunch: a fresh process re-reads only the file.
    for (const k of Object.keys(process.env)) if (k.startsWith(V)) delete process.env[k];
    loadConfig(process.cwd());
    assert.equal(process.env[V], "new-key", "the update was lost — the stale line won on restart");
    assert.doesNotMatch(readFileSync(globalEnvPath(), "utf8"), /old-key/, "the old key is still on disk");
  });
}

test("a key hint shows the END of a key, never the start", () => {
  // The first characters are a provider prefix shared by all of a user's keys: it would
  // distinguish nothing while still putting part of a credential on a shareable screen.
  assert.equal(keyHint("sk-ant-api03-abcd1234"), "…1234");
  assert.equal(keyHint(""), "");
  assert.doesNotMatch(keyHint("sk-ant-api03-abcd1234"), /sk-/);
});
