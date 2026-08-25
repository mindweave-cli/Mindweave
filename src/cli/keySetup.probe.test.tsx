/**
 * keySetup.probe.test.tsx — the first screen, rendered.
 *
 * This is the one screen every new user sees before anything else works, and a
 * typecheck says nothing about what reaches the terminal. Rendered to a fake stream and
 * read back, the way every other UI claim in this codebase is checked.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { KeySetup } from "./components/KeySetup.js";
import { setupView } from "./keySetup.js";
import { allProviders } from "../drivers/registry.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 90,
    rows: 40,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false });
  app.unmount();
  return out.join("");
}

const screen = (hasKey: (v: string) => boolean) =>
  frame(
    <KeySetup
      view={setupView(hasKey)}
      version=" v1.0.0"
      envPath="~/.mindweave/.env"
      docsUrl="https://example.invalid/docs"
      onSaveKey={() => {}}
      onContinue={() => {}}
      active={false}
    />,
  );

test("a brand new user is offered providers, not one hardcoded name", () => {
  const out = screen(() => false);
  // The first window of providers, numbered and pickable.
  const first = allProviders()[0]!;
  assert.ok(out.includes(first.label), "the provider list is not on screen");
  assert.match(out, /1\s+DeepSeek/, "the list is not numbered for quick picking");
  assert.match(out, /Welcome/i, "a first-time user is not greeted");
});

test("Continue is offered but visibly unavailable until a key exists", () => {
  const empty = screen(() => false);
  assert.match(empty, /Continue/, "there is no visible way out of setup");
  assert.match(empty, /add a key first/i, "Continue looks available when it is not");

  const ready = screen((v) => v === allProviders()[0]!.apiKeyEnv);
  assert.match(ready, /Continue →\s+start chatting/, "Continue never becomes available");
  assert.doesNotMatch(ready, /add a key first/i, "Continue still says a key is needed");
});

test("a provider already set up is marked, so adding more is obvious", () => {
  const first = allProviders()[0]!;
  const out = screen((v) => v === first.apiKeyEnv);
  assert.match(out, /key added/, "a saved key leaves no trace on the screen");
  // NAMED, because the list scrolls and the provider just added is often off-screen —
  // a count tells the user a number when the question is "which one".
  assert.match(out, new RegExp(`Ready: ${first.label}`), "the user is not told WHICH provider is ready");
});

test("the screen fits a short terminal, and says what is off it", () => {
  // Thirteen providers plus Continue plus the header does not fit 40 rows of a small
  // window, and Continue lives at the BOTTOM — clipping it would hide the way out.
  const out = screen(() => false);
  const lines = out.split(String.fromCharCode(10));
  assert.ok(lines.length < 30, `the screen is ${lines.length} rows and will be clipped`);
  assert.match(out, /more below/, "providers are cut off with nothing saying so");
});

test("every provider is reachable by name somewhere in setup", () => {
  // Not all at once — the list scrolls — but the LIST must contain them all.
  const view = setupView(() => false);
  assert.equal(view.rows.length, allProviders().length);
  for (const p of allProviders()) {
    assert.ok(view.rows.some((r) => r.label === p.label && r.envVar === p.apiKeyEnv), `${p.label} is missing`);
  }
});


test("the number shortcut it advertises is one it actually has", () => {
  // A single keypress commits, so a two-digit row can never be typed: "1" picks row 1
  // before the second key arrives. The footer used to promise the full range, which was
  // a shortcut four providers did not have — Gemini among them.
  const out = screen(() => false);
  const promised = out.match(/1-(\d+) to jump/);
  assert.ok(promised, "the screen no longer says which numbers work");
  assert.ok(Number(promised![1]) <= 9, `it promises 1-${promised![1]}, but only single digits can be typed`);
  // And the rest are still reachable, which is what makes 1-9 honest rather than a limit.
  assert.match(out, /↑\/↓ to move/, "there is no way to reach the rows without a number");
});


test("a first run has no escape; /key does", () => {
  // Opposite defaults on purpose. On a first run there is nothing behind the screen to
  // go back to, so an escape would only reach an app that cannot answer. Reopened
  // deliberately to fix a key, leaving without changing anything is the whole point.
  const firstRun = frame(
    <KeySetup view={setupView(() => false)} version=" v1" envPath="~/.mindweave/.env"
      docsUrl="d" onSaveKey={() => {}} onContinue={() => {}} active={false} />,
  );
  assert.doesNotMatch(firstRun, /Esc to leave/, "a first run offers an exit to an app that cannot run");

  const reopened = frame(
    <KeySetup view={setupView(() => true)} version=" v1" envPath="~/.mindweave/.env"
      docsUrl="d" onSaveKey={() => {}} onContinue={() => {}} onCancel={() => {}} active={false} />,
  );
  assert.match(reopened, /Esc to leave/, "/key traps the user in the setup screen");
});

test("a provider that already has a key can still be chosen, to replace it", () => {
  // The reason /key exists: a mistyped key is the commonest way a first run dies, and
  // before this the only fix was editing ~/.mindweave/.env by hand.
  const view = setupView(() => true);
  assert.ok(view.rows.every((r) => r.ready));
  assert.equal(view.canContinue, true);
  const out = frame(
    <KeySetup view={view} version=" v1" envPath="~/.mindweave/.env" docsUrl="d"
      onSaveKey={() => {}} onContinue={() => {}} onCancel={() => {}} active={false} />,
  );
  // Every row is still listed and selectable — nothing is greyed out just for being set.
  assert.match(out, /key added/);
  assert.match(out, /1\s+DeepSeek/);
});
