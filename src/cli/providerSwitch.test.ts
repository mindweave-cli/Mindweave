/**
 * providerSwitch.test.ts — the ordering that keeps /provider recoverable.
 *
 * A source scan, like engine.test.ts's compaction guard, because the property is an
 * ORDER of operations inside a React handler rather than a value a unit test can
 * observe. It exists because of a real bug: `applyProvider` saved the new model to
 * disk BEFORE checking whether that provider had a key, so choosing a provider you
 * had no key for wrote an unusable config, and the project then reopened straight
 * into the key prompt on every launch with no way back from inside the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "App.tsx"), "utf8");

function body(fn: string): string {
  const match = source.match(new RegExp(`async function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `${fn} not found — did it get renamed?`);
  return match![1]!;
}

test("applyProvider checks for the key before it saves anything", () => {
  const fn = body("applyProvider");
  const check = fn.indexOf("missingKeyFor");
  const save = fn.indexOf("saveModelConfig");
  assert.ok(check >= 0, "the key check is gone — an unusable provider can be selected");
  // A save reached before the check is the original bug: it persists a provider that
  // cannot answer, and the config outlives the session that made it.
  assert.ok(save < 0 || check < save, "the key must be checked before the switch is persisted");
});

test("a switch to a keyless provider is HELD, not abandoned", () => {
  // Choosing a provider you have no key for used to open a prompt of its own that could
  // not be escaped. It now opens the key manager and remembers the switch, so adding the
  // key finishes it — one flow instead of two commands with a dead end between them.
  const fn = body("applyProvider");
  assert.match(fn, /pendingSwitch\.current = /, "nothing remembers which switch to finish");
  assert.match(fn, /setKeysOpen\(true\)/, "the user is not shown anywhere to add the key");
  assert.doesNotMatch(fn, /setKeyNeed/, "the removed single-provider prompt is back");
});

test("the held switch is finished when that provider's key is saved", () => {
  const src = source.slice(source.indexOf("onSave={(provider, slot, key)"));
  assert.match(src.slice(0, 600), /pendingSwitch\.current/, "saving a key does not complete a held switch");
  assert.match(src.slice(0, 600), /held\.apiKeyEnv === provider\.apiKeyEnv/, "any key would complete the switch");
});

test("a saved config whose provider lost its key falls back instead of trapping", () => {
  assert.match(source, /usableFallback\(/, "startup must be able to recover a config it cannot run");
});
