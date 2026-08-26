/**
 * firstRunFrame.probe.test.tsx — the two screens that own the whole terminal.
 *
 * They are the only ones with no conversation behind them, so they are the only ones
 * that should fill it. Left as plain columns they pinned to the top of an empty window,
 * which reads like output that has scrolled rather than something asking for an answer.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, Text } from "ink";
import { FirstRunFrame, FIRST_RUN_TIPS } from "./components/FirstRunFrame.js";

function frame(rows: number, node: React.ReactElement): string[] {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 84, rows, on: () => {}, off: () => {}, removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false, interactive: true });
  app.unmount();
  return out.join("").split(String.fromCharCode(10));
}

const body = <Text>PAYLOAD</Text>;

test("the content sits in the middle of a tall terminal, not at the top", () => {
  const lines = frame(40, <FirstRunFrame rows={40} version=" v1">{body}</FirstRunFrame>);
  const at = lines.findIndex((l) => l.includes("PAYLOAD"));
  assert.ok(at > 6, `the content starts on row ${at}, which is still pinned to the top`);
  assert.ok(at < 34, `the content starts on row ${at}, which is past the middle`);
});

test("a short terminal falls back to the top rather than clipping", () => {
  // Cutting the middle out of a screen the user has to answer is worse than a screen
  // that starts at the first row.
  const lines = frame(14, <FirstRunFrame rows={14} version=" v1">{body}</FirstRunFrame>);
  const at = lines.findIndex((l) => l.includes("PAYLOAD"));
  assert.ok(at >= 0, "the content is not on screen at all");
  assert.ok(at <= 4, `a 14-row terminal pushed the content to row ${at}`);
});

test("it never renders taller than the terminal", () => {
  for (const rows of [14, 24, 40]) {
    const lines = frame(rows, <FirstRunFrame rows={rows} version=" v1" tips={FIRST_RUN_TIPS}>{body}</FirstRunFrame>);
    assert.ok(lines.length - 1 <= rows, `at ${rows} rows it rendered ${lines.length - 1}`);
  }
});

test("a new user is told what this is, which version, and what to try", () => {
  const out = frame(40, <FirstRunFrame rows={40} version=" v1.9.9" subtitle="Welcome — a coding agent" tips={FIRST_RUN_TIPS}>{body}</FirstRunFrame>).join(" ");
  assert.match(out, /Mindweave/);
  assert.match(out, /v1\.9\.9/, "the version is not shown, so nobody can report it");
  assert.match(out, /Welcome/);
  // The tips are the only moment a brand-new user is certainly reading, and the one
  // thing they cannot do yet is ask.
  assert.match(out, /\/help/, "no way to discover the commands");
  assert.match(out, /shift\+tab/, "the modes are undiscoverable");
  assert.match(out, /Esc/, "no way to learn how to stop something");
  assert.match(out, /stay on this machine/, "nothing says where the keys go");
});

test("the tips are shown only where they belong", () => {
  const without = frame(40, <FirstRunFrame rows={40} version=" v1">{body}</FirstRunFrame>).join(" ");
  assert.doesNotMatch(without, /\/help lists/, "tips appear on a screen that did not ask for them");
});
