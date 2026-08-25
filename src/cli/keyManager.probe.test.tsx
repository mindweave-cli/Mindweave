/**
 * keyManager.probe.test.tsx — /key, rendered at each of its three levels.
 *
 * The screen is the feature: a list of keys you cannot read is not a manager. Rendered
 * into a fake terminal and read back, like every other UI claim here.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { KeyManager } from "./components/KeyManager.js";
import { actionsFor, countLabel, type KeyRow, type ProviderRow } from "./keyManager.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 76,
    rows: 30,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false });
  app.unmount();
  return out.join("");
}

const PROVIDERS: ProviderRow[] = [
  { id: "deepseek", label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", count: 2 },
  { id: "anthropic", label: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", count: 1 },
  { id: "gemini", label: "Gemini", apiKeyEnv: "GEMINI_API_KEY", count: 0 },
];

const DEEPSEEK_KEYS: KeyRow[] = [
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 1, hint: "…a4f2", active: true },
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 2, hint: "…9c1b", active: false },
];

function screen(): string {
  return frame(
    <KeyManager
      providers={PROVIDERS}
      keysOf={() => DEEPSEEK_KEYS}
      nextSlot={() => 3}
      reveal={() => "sk-full-secret-value"}
      width={64}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
    />,
  );
}

test("the first level is PROVIDERS, with how many keys each holds", () => {
  const out = screen();
  assert.match(out, /DeepSeek/);
  assert.match(out, /Anthropic/);
  assert.match(out, /2 keys/, "a provider with several keys does not say so");
  assert.match(out, /1 key\b/, "a provider with one key does not say so");
  // A provider with none is still listed — that is how the first key gets added.
  assert.match(out, /no key yet/, "a provider with no key is hidden, so it can never gain one");
});

test("counts read naturally at 0, 1 and many", () => {
  assert.equal(countLabel(0), "no key yet");
  assert.equal(countLabel(1), "1 key");
  assert.equal(countLabel(4), "4 keys");
});

test("it is a bordered panel, not a takeover of the screen", () => {
  // It sits where the prompt sits. Replacing the whole terminal to change a setting is
  // the wrong weight, and leaves nothing to come back to.
  const out = screen();
  assert.match(out, /[┌│└]/, "no panel border — this is rendering as a full screen");
  const lines = out.split(String.fromCharCode(10)).filter((l) => l.trim());
  assert.ok(lines.length <= 14, `the panel is ${lines.length} rows and is not a footer overlay`);
});

test("no key value is on screen until it is asked for", () => {
  assert.doesNotMatch(screen(), /sk-full-secret/, "a full key is shown without being asked for");
});

test("the actions offered depend on the key, and adding never runs out", () => {
  const active = DEEPSEEK_KEYS[0]!;
  const spare = DEEPSEEK_KEYS[1]!;
  // An action that does nothing is worse than an absent one: the user tries it and
  // learns nothing.
  assert.ok(!actionsFor(active, 2).includes("Make this the active key"));
  assert.ok(actionsFor(spare, 2).includes("Make this the active key"));

  for (const a of ["Show the key", "Edit it", "Back"]) {
    assert.ok(actionsFor(active, 2).includes(a), `${a} is not offered`);
  }
  // Removing a provider's only key is allowed — it is how a wrong key gets corrected —
  // but the row says what it costs rather than refusing.
  assert.match(actionsFor(active, 1).join(" "), /only key/);
  assert.doesNotMatch(actionsFor(active, 2).join(" "), /only key/);
});
