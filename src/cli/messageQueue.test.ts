/**
 * messageQueue.test.ts — the rules a queued message obeys.
 *
 * Every case here is one a user hit or could hit: a message that came back doubled,
 * a slash command swallowed into prose, a footer tall enough to break the frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drain, isCommand, popAll, visibleQueue, MAX_VISIBLE_QUEUED } from "./messageQueue.js";

test("an empty queue has nothing to send and nothing to pop", () => {
  assert.equal(drain([]), undefined);
  assert.equal(popAll([], "", 0), undefined);
  // Not the same as popping an empty string: the caller must be able to tell
  // "nothing was queued" from "a blank message was queued", because on Esc the
  // first has to fall through to the interrupt and the second must not.
  assert.equal(popAll([], "half a thought", 4), undefined);
});

test("messages typed one after another are sent as ONE turn", () => {
  const d = drain(["fix the test", "and the types", "then build"])!;
  assert.equal(d.rest.length, 0, "something was left queued — this will cost an extra turn");
  assert.match(d.send, /fix the test/);
  assert.match(d.send, /and the types/);
  assert.match(d.send, /then build/);
});

test("they are separated so they don't read as one rambling line", () => {
  const d = drain(["first", "second"])!;
  assert.equal(d.send, "first\n\nsecond");
});

test("a slash command goes alone, and does not swallow what follows", () => {
  // Batched, `/model` would be sent to the model as the literal word and nothing
  // would switch.
  const d = drain(["/model", "now use the new one"])!;
  assert.equal(d.send, "/model");
  assert.deepEqual(d.rest, ["now use the new one"]);
});

test("prose stops at a command instead of absorbing it", () => {
  const d = drain(["fix it", "add a test", "/undo"])!;
  assert.equal(d.send, "fix it\n\nadd a test");
  assert.deepEqual(d.rest, ["/undo"], "the command was consumed as text");
});

test("a command is recognised through leading whitespace", () => {
  assert.equal(isCommand("  /help"), true);
  assert.equal(isCommand("what does / mean"), false);
  assert.equal(isCommand("http://x/y"), false);
});

test("draining repeatedly empties the queue and never loops", () => {
  let q = ["a", "/model", "b", "c"];
  const sent: string[] = [];
  for (let i = 0; i < 10 && q.length > 0; i++) {
    const d = drain(q)!;
    assert.ok(d.rest.length < q.length, "a drain that removed nothing would spin forever");
    sent.push(d.send);
    q = d.rest;
  }
  assert.deepEqual(sent, ["a", "/model", "b\n\nc"]);
  assert.equal(q.length, 0);
});

test("popping brings back EVERY queued message, not just the last", () => {
  // The bug this replaces: ↑ showed the last message from history while the queue
  // kept all of them, so editing and sending produced a duplicate.
  const p = popAll(["one", "two", "three"], "", 0)!;
  assert.equal(p.text, "one\ntwo\nthree");
  assert.equal(p.cursor, p.text.length, "cursor is not at the end of what was restored");
});

test("a half-typed line survives the pop, and lands after the queue", () => {
  const p = popAll(["queued one"], "typing thi", 10)!;
  assert.equal(p.text, "queued one\ntyping thi");
  assert.equal(
    p.text.slice(p.cursor),
    "",
    "the cursor did not follow the draft — the user resumes typing in the wrong place",
  );
  assert.equal(p.cursor, "queued one".length + 1 + 10);
});

test("the cursor keeps its place inside the draft, not just at the end", () => {
  const p = popAll(["q"], "abcdef", 3)!;
  assert.equal(p.text, "q\nabcdef");
  assert.equal(p.text.slice(0, p.cursor), "q\nabc", "cursor drifted within the draft");
});

test("the footer never grows without limit", () => {
  const many = Array.from({ length: 9 }, (_, i) => `msg ${i + 1}`);
  const v = visibleQueue(many);
  assert.equal(v.rows.length, MAX_VISIBLE_QUEUED);
  assert.equal(v.hidden, 9 - MAX_VISIBLE_QUEUED, "hidden messages are not accounted for");
  // A footer taller than the terminal corrupts the frame rather than clipping it.
  assert.ok(v.rows.length <= MAX_VISIBLE_QUEUED);
});

test("a short queue is shown whole, with nothing claimed hidden", () => {
  const v = visibleQueue(["a", "b"]);
  assert.deepEqual(v.rows, ["a", "b"]);
  assert.equal(v.hidden, 0);
});
