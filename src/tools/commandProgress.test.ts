/**
 * commandProgress.test.ts — a running command says what it is doing.
 *
 * The failure this closes was reported as a hang and was not one: a release build ran for
 * ten minutes, correctly, and the screen showed nothing about it the whole time. The row
 * was not even up (the reveal held it for its own result), so the last thing visible was
 * the tool before it, and a working agent was indistinguishable from a stuck one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { neverBackground, progressTail } from "./runCommand.js";

test("the LAST lines are what is shown, not the first", () => {
  // A build puts its banner at the start and its diagnosis at the end. The end is the
  // part worth glancing at while it runs.
  const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const tail = progressTail(out, 6);
  assert.equal(tail.split("\n").length, 6);
  assert.match(tail, /line 40$/);
  assert.doesNotMatch(tail, /line 1\b/);
});

test("output shorter than the window is shown whole", () => {
  assert.equal(progressTail("one\ntwo", 6), "one\ntwo");
});

test("trailing blank lines are dropped before the window is taken", () => {
  // A command that ends its output with newlines would otherwise report a tail of empty
  // rows and look like it had stopped saying anything — the exact impression this is
  // meant to remove.
  const tail = progressTail("real one\nreal two\n\n\n\n", 3);
  assert.equal(tail, "real one\nreal two");
});

test("a very long line is clipped, never wrapped", () => {
  // This is a glance at progress. One 400-column line wrapped would push the rest of the
  // tail off screen, which is the opposite of showing what is happening.
  const tail = progressTail("x".repeat(500), 6, 80);
  assert.equal(tail.length, 80);
  assert.ok(tail.endsWith("…"));
});

test("empty output produces nothing rather than a blank row", () => {
  assert.equal(progressTail("", 6), "");
  assert.equal(progressTail("\n\n\n", 6), "");
});

test("it is pure — the same output always gives the same tail", () => {
  // Sent once a second while a command runs, and the caller compares it against the last
  // one to decide whether to send at all. A tail that varied would repaint every second.
  const out = "a\nb\nc";
  assert.equal(progressTail(out, 2), progressTail(out, 2));
});

// ── a pure delay is the work, so it is never moved to the background ─────────
//
// Backgrounding a `sleep` at the timeout keeps alive a process whose only purpose is to
// finish, and hands back a shell id nobody wants: the wait was the point, and it ends up
// neither waited on nor cancelled. Killing it is the honest outcome.

test("a delay is refused for backgrounding, however it is spelled", () => {
  for (const command of ["sleep 30", "Start-Sleep -Seconds 5", "/bin/sleep 2", "  SLEEP 3"]) {
    assert.equal(neverBackground(command), true, `${command} would be backgrounded`);
  }
});

test("leading environment assignments do not hide the command", () => {
  // `FOO=1 sleep 9` starts with an assignment, not a program. Judging the first word
  // literally would read `FOO=1` as the command and let the delay through.
  assert.equal(neverBackground("FOO=1 sleep 9"), true);
  assert.equal(neverBackground("A=1 B=2 npm test"), false);
});

test("real work is still allowed to background", () => {
  // The rule must be narrow. A build or a test run is exactly what backgrounding exists
  // for, and a rule that caught them would kill the feature.
  for (const command of ["npm test", "cargo run --release", "python train.py", "sleeper --run"]) {
    assert.equal(neverBackground(command), false, `${command} was refused backgrounding`);
  }
});

test("an empty command is not treated as a delay", () => {
  assert.equal(neverBackground(""), false);
  assert.equal(neverBackground("   "), false);
});

test("a delay that runs long is KILLED, not backgrounded", async () => {
  // End to end, because the rule is only worth having if it reaches the timeout branch.
  // A backgrounded delay is the worst of both: still running, nobody waiting on it, and
  // a shell id the model now has to reason about.
  const { runCommand } = await import("./runCommand.js");
  const { BackgroundShells } = await import("./backgroundShells.js");
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
  } as unknown as import("./types.js").ToolContext;

  const command = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const started = Date.now();
  const r = await runCommand.execute({ command, timeout: 1000 }, ctx);
  const elapsed = Date.now() - started;
  mgr.dispose();

  assert.doesNotMatch(r.output, /background as shell/i, "a pure delay was moved to the background");
  assert.match(r.output, /timed out/i, "the delay was neither backgrounded nor reported as timing out");
  assert.ok(elapsed < 8000, `it should end at the ~1s timeout, not run the full delay (took ${elapsed}ms)`);
});
