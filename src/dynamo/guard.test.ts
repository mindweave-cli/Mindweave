import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUARD_OPTIONS,
  GUARD_REFUSAL,
  describeCall,
  guardQuestion,
  guardDetail,
  interpretGuardChoice,
} from "./guard.js";

test("interpretGuardChoice maps each option to its action", () => {
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[0]), "proceed");
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[1]), "allow-all");
  assert.equal(interpretGuardChoice(GUARD_OPTIONS[2]), "refuse");
});

test("interpretGuardChoice fails safe on cancel / unknown answers", () => {
  assert.equal(interpretGuardChoice(undefined), "refuse"); // Esc / no channel
  assert.equal(interpretGuardChoice(""), "refuse");
  assert.equal(interpretGuardChoice("whatever"), "refuse");
});

test("describeCall names the file for edit/write tools", () => {
  assert.equal(describeCall("edit_file", { path: "src/app.ts" }), "edit_file — src/app.ts");
  assert.equal(describeCall("write_file", { path: "a/b.ts" }), "write_file — a/b.ts");
  assert.equal(describeCall("replace_symbol_body", { path: "m.ts", name: "greet" }), "replace_symbol_body — m.ts");
});

test("describeCall shows the command for run_command, clipped", () => {
  assert.equal(describeCall("run_command", { command: "npm test" }), "run_command — npm test");
  const long = describeCall("run_command", { command: "x".repeat(200) });
  assert.ok(long.length < 120, "long commands are clipped");
  assert.ok(long.endsWith("…"));
});

test("describeCall shows the task for spawn_subagent", () => {
  assert.equal(describeCall("spawn_subagent", { task: "find call sites" }), "spawn_subagent — find call sites");
});

test("describeCall degrades gracefully for unknown tools", () => {
  assert.equal(describeCall("some_external_tool", { path: "/tmp/x" }), "some_external_tool — /tmp/x");
  assert.equal(describeCall("weird_tool", {}), "weird_tool");
});

test("the question is one line and there are exactly 3 options", () => {
  // One line because it renders inside a height-bounded box. What the call actually is
  // moved to guardDetail, which prints into the transcript — see the test below.
  const q = guardQuestion();
  assert.match(q, /Sentinel/);
  assert.equal(q.split("\n").length, 1);
  assert.equal(GUARD_OPTIONS.length, 3);
  assert.ok(GUARD_REFUSAL.length > 0);
});

test("guardDetail spells out what is about to happen, in full", () => {
  const d = guardDetail("run_command", { command: "git push origin main --force" });
  assert.match(d, /Action: Shell execution/, "named in the user's terms, not the tool's");
  assert.match(d, /\$ git push origin main --force/);
  assert.match(d, /Tool: run_command/, "the exact tool is still recorded");
});

test("a command is shown WHOLE, because the tail is where the damage is", () => {
  // A clipped command hides the end of it, and on a shell command that is exactly the
  // part worth reading — `… && rm -rf /`. This is the one field that is never trimmed.
  const long = "npm run build " + "--flag ".repeat(60) + "&& rm -rf dist";
  const d = guardDetail("run_command", { command: long });
  assert.ok(d.includes(long), "the command must not be truncated");
  assert.match(d, /rm -rf dist/);
});

test("guardDetail states facts and never invents a risk rating", () => {
  // The reference design shows "Risk: High". Nothing in Mindweave knows which commands
  // are dangerous, so a severity here would be a guess presented as an assessment —
  // and a wrong "Low" is worse than no line at all.
  const d = guardDetail("run_command", { command: "rm -rf /" });
  assert.doesNotMatch(d, /Risk:/i);
});

test("guardDetail names the file for an edit, and the task for a sub-agent", () => {
  assert.match(guardDetail("edit", { path: "src/App.tsx" }), /Action: File edit/);
  assert.match(guardDetail("edit", { path: "src/App.tsx" }), /File: src\/App\.tsx/);
  assert.match(guardDetail("spawn_subagent", { task: "audit the auth flow" }), /Task: audit the auth flow/);
});
