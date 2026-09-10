/**
 * wordEdit.test.ts — the chunk boundaries, pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { killToLineEnd, lineEnd, wordEnd, wordStart } from "./wordEdit.js";

test("deleting back from the end takes one word, not the whole line", () => {
  const v = "fix the failing test";
  assert.equal(wordStart(v, v.length), "fix the failing ".length);
  assert.equal(v.slice(0, wordStart(v, v.length)), "fix the failing ");
});

test("trailing whitespace goes with the word, so one press is one word", () => {
  const v = "hello world   ";
  assert.equal(v.slice(0, wordStart(v, v.length)), "hello ");
});

test("a long path is ONE chunk", () => {
  // The case that motivated this: a dropped file leaves a path in the buffer and
  // removing it should not take eight presses.
  const v = String.raw`look at "C:\Users\dev\Pictures\Screenshots\shot.png"`;
  assert.equal(v.slice(0, wordStart(v, v.length)), "look at ");
});

test("from mid-word it deletes back to that word's start only", () => {
  const v = "alpha beta gamma";
  assert.equal(wordStart(v, "alpha be".length), "alpha ".length);
});

test("at the very start there is nothing behind the cursor", () => {
  assert.equal(wordStart("abc", 0), 0);
  assert.equal(wordStart("", 0), 0);
});

test("forward and back are mirrors", () => {
  const v = "one two three";
  const afterOne = wordEnd(v, 0);
  assert.equal(v.slice(0, afterOne), "one");
  assert.equal(wordStart(v, afterOne), 0, "back from there returns to the start");
  assert.equal(wordEnd(v, v.length), v.length, "at the end there is nothing ahead");
});

test("forward skips the gap before the next word", () => {
  const v = "one   two";
  assert.equal(wordEnd(v, 3), v.length, "from after 'one', through the spaces and over 'two'");
});

test("a newline is whitespace, so chunks do not run through it silently", () => {
  const v = "first line\nsecond";
  assert.equal(wordStart(v, v.length), "first line\n".length);
});

test("end of line means the line, not the buffer", () => {
  const v = "first\nsecond\nthird";
  assert.equal(lineEnd(v, 0), 5);
  assert.equal(lineEnd(v, 7), "first\nsecond".length);
  assert.equal(lineEnd(v, v.length), v.length, "the last line ends at the end");
});

test("Ctrl+K clears the rest of the line", () => {
  const r = killToLineEnd("keep this|drop this".replace("|", ""), 9);
  assert.equal(r.value, "keep this");
  assert.equal(r.cursor, 9);
});

test("Ctrl+K at a line end joins the next line up instead of doing nothing", () => {
  // Without this the key is inert exactly where a user most expects it to act.
  const r = killToLineEnd("first\nsecond", 5);
  assert.equal(r.value, "firstsecond");
  assert.equal(r.cursor, 5);
});

test("Ctrl+K at the very end of the buffer changes nothing", () => {
  const r = killToLineEnd("done", 4);
  assert.equal(r.value, "done");
  assert.equal(r.cursor, 4);
});

test("a cursor outside the text cannot throw or produce a bad index", () => {
  for (const c of [-5, 999]) {
    assert.ok(wordStart("abc", c) >= 0);
    assert.ok(wordEnd("abc", c) <= 3);
    const r = killToLineEnd("abc", c);
    assert.ok(r.cursor >= 0 && r.cursor <= r.value.length);
  }
});

// ── Locating the input's text on the painted screen ──────────────────────────
// How a click finds its column without anyone computing where the box was laid out.

import { findTextColumn } from "./wordEdit.js";

/** A painted row: `text` starting at `left`, blanks either side. */
const painted = (left: number, text: string, width = 40) => (x: number) =>
  x >= left && x < left + text.length ? text[x - left]! : " ";

test("the text's column is found wherever the box put it", () => {
  assert.equal(findTextColumn(painted(4, "hello world"), 40, "hello world"), 4);
  assert.equal(findTextColumn(painted(0, "hello"), 40, "hello"), 0);
});

test("the caret sitting on a cell does not stop the row being found", () => {
  // The caret replaces the character it is on, so the painted row differs by one cell.
  const withCaret = painted(4, "hello \u2502orld");
  assert.equal(findTextColumn(withCaret, 40, "hello world"), 4);
});

test("two wrong cells is not a match", () => {
  // Beyond one difference this is a different row, and guessing would move the cursor
  // somewhere the user did not click.
  assert.equal(findTextColumn(painted(4, "hello XXrld"), 40, "hello world"), -1);
});

test("a row that is not on screen returns -1 rather than a guess", () => {
  assert.equal(findTextColumn(painted(4, "something else"), 40, "hello world"), -1);
  assert.equal(findTextColumn(painted(4, "hi"), 40, ""), -1, "empty text is never located");
});

test("text wider than the row cannot match", () => {
  assert.equal(findTextColumn(painted(0, "abc"), 3, "abcdef"), -1);
});
