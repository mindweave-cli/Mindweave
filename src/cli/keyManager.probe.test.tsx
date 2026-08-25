/**
 * keyManager.probe.test.tsx — /key, rendered.
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
import { actionsFor, type KeyManagerView, type KeyRow } from "./keyManager.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 78, rows: 30, on: () => {}, off: () => {}, removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false });
  app.unmount();
  return out.join("");
}

const row = (over: Partial<KeyRow> = {}): KeyRow => ({
  providerId: "deepseek", label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY",
  slot: 1, hint: "…a4f2", live: true, canAddMore: true, ...over,
});

const view: KeyManagerView = {
  rows: [
    row(),
    row({ slot: 2, hint: "…9c1b", live: false }),
    row({ providerId: "gemini", label: "Gemini", apiKeyEnv: "GEMINI_API_KEY", hint: "…77de" }),
  ],
  emptyProviders: [{ id: "openai", label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY" }],
};

const screen = (v: KeyManagerView) =>
  frame(
    <KeyManager view={v} width={70} reveal={() => "sk-full-secret-value-1234"}
      onUse={() => {}} onSave={() => {}} onRemove={() => {}} onClose={() => {}} active={false} />,
  );

test("every key is listed, with the live one marked", () => {
  const out = screen(view);
  assert.equal((out.match(/DeepSeek/g) ?? []).length, 2, "the second key for a provider is missing");
  assert.match(out, /Gemini/);
  assert.equal((out.match(/in use/g) ?? []).length, 2, "the key actually being sent is not marked");
});

test("a key is shown by its last characters only", () => {
  const out = screen(view);
  assert.match(out, /…a4f2/);
  // Never the whole value, and never the start — a provider prefix is the same across
  // every key a user owns, so it identifies nothing and is still a credential fragment.
  assert.doesNotMatch(out, /sk-/);
});

test("adding is a row in the same list, not a hidden key", () => {
  assert.match(screen(view), /Add a key/);
});

test("an empty store says so instead of showing an empty box", () => {
  const out = screen({ rows: [], emptyProviders: view.emptyProviders });
  assert.match(out, /none yet/);
  assert.match(out, /Add a key/);
});

test("the columns line up whatever the provider is called", () => {
  // A hint appended to the label moves with the length of the name, so the markers end
  // up in different places and the list stops reading as a table.
  const out = screen(view);
  const marked = out.split(String.fromCharCode(10)).filter((l) => l.includes("in use"));
  assert.equal(marked.length, 2);
  assert.equal(
    marked[0]!.indexOf("in use"),
    marked[1]!.indexOf("in use"),
    "the in-use marker sits in a different column for a longer provider name",
  );
});

test("the actions offered depend on the key", () => {
  // An action that does nothing is worse than an absent one: the user tries it and
  // learns nothing.
  assert.ok(!actionsFor(row({ live: true }), 2).includes("Use this key"));
  assert.ok(actionsFor(row({ live: false }), 2).includes("Use this key"));
  // Removing a provider's only key is allowed — it is how a wrong key gets corrected —
  // but the row says what it is.
  assert.match(actionsFor(row(), 1).join(" "), /only key/);
  assert.doesNotMatch(actionsFor(row(), 2).join(" "), /only key/);
});


test("it is a bordered panel, not a takeover of the screen", () => {
  // It sits where the prompt sits. Replacing the whole terminal for a list of three keys
  // is the wrong weight for changing a setting, and leaves nothing to come back to.
  const out = screen(view);
  assert.match(out, /[┌│└]/, "no panel border — this is rendering as a full screen");
  const lines = out.split(String.fromCharCode(10)).filter((l) => l.trim());
  assert.ok(lines.length <= 14, `the panel is ${lines.length} rows and is not a footer overlay`);
});

test("a key can be read back in full, but only when asked for", () => {
  // Two keys can differ by four characters; sometimes you need to know it is the right
  // one. Shown on request, never in the list.
  const list = screen(view);
  assert.doesNotMatch(list, /sk-full-secret/, "a full key is on screen without being asked for");
  assert.ok(actionsFor(row(), 2).includes("Show the key"), "there is no way to read a key back");
});
