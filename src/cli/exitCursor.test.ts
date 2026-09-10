/**
 * exitCursor.test.ts — the shell's prompt must land BELOW the conversation.
 *
 * The failure this prevents, exactly as it appeared: after leaving the inline shell,
 * `C:\...>` printed on top of a line of the transcript, replacing its first seventeen
 * characters. Every Enter after that walked one row further down and did it again — a
 * column of prompts eating the left edge of the conversation, one row per keypress, with
 * no way to repair it because by then the app is gone and those rows are the terminal's
 * own scrollback.
 *
 * The cause is that nothing in the restore sequence moves the cursor. It stays where the
 * caret was, which is inside the input box, two or more rows above the last row the app
 * drew — and a shell prompt is written at column zero without clearing the line it lands
 * on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { caretToOutputEnd, setRowsBelowCaret } from "./exitCursor.js";

/** Cursor-down: `CSI n B`. */
const DOWN = /^\x1b\[(\d+)B/;

test("with rows below the caret, the cursor is moved down past them", () => {
  setRowsBelowCaret(3);
  const seq = caretToOutputEnd();
  const match = DOWN.exec(seq);
  assert.ok(match, `expected a cursor-down, got ${JSON.stringify(seq)}`);
  assert.equal(match[1], "3");
});

test("and then opens a fresh line, so the prompt is under the last row, not on it", () => {
  setRowsBelowCaret(2);
  assert.ok(caretToOutputEnd().endsWith("\r\n"), "no fresh line — the prompt would land on the last row of output");
});

test("already at the end, there is nothing to move past", () => {
  setRowsBelowCaret(0);
  assert.equal(caretToOutputEnd(), "\r\n", "a zero-row move is still an escape the terminal has to parse");
});

test("it moves with CUD, never with newlines", () => {
  // A newline at the bottom row SCROLLS. Overshooting with newlines would push the
  // conversation up and off the top of the screen — turning a misjudged distance into
  // lost content. `CUD` is clamped at the bottom row and scrolls nothing, so the same
  // mistake costs a blank row instead.
  setRowsBelowCaret(40);
  const seq = caretToOutputEnd();
  const newlines = (seq.match(/\n/g) ?? []).length;
  assert.equal(newlines, 1, `expected exactly the one deliberate newline, found ${newlines}`);
  assert.match(seq, /^\x1b\[40B/);
});

test("a nonsense distance is treated as none, never as a scroll", () => {
  // The distance comes from a live measurement, and a measurement taken before layout
  // settles can be zero, negative, or NaN. None of those may become a movement.
  for (const bad of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    setRowsBelowCaret(bad);
    assert.equal(caretToOutputEnd(), "\r\n", `${bad} produced a cursor move`);
  }
});

test("a fractional distance is floored to whole rows", () => {
  // Terminals count rows, and `CSI 2.5 B` is not a sequence — it would be parsed as
  // something else entirely, or swallow the bytes after it.
  setRowsBelowCaret(2.9);
  assert.match(caretToOutputEnd(), /^\x1b\[2B/);
});

test("the full-screen shell publishes zero and gets no correction", () => {
  // It hands the terminal back by leaving the alternate screen, which restores the
  // primary buffer's cursor with it. A move here would be a move against a cursor the
  // terminal has already put back where it belongs.
  setRowsBelowCaret(0);
  assert.doesNotMatch(caretToOutputEnd(), DOWN);
});
