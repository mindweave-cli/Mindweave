/**
 * inputView.test.ts — the prompt box's wrapping, cursor mapping, and height cap.
 *
 * The bug these guard against was visible, not theoretical: a message long enough to
 * wrap pushed the box past the rows the frame could spare, and the tip line under it
 * disappeared off the bottom of the screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapWithOffsets, inputView } from "./inputView.js";

test("wrapping records where each row started in the buffer", () => {
  // The offsets are what make the cursor exact. A word break drops the space it broke
  // on, so the rendered rows are shorter than the source and the position cannot be
  // recovered by adding up row lengths afterwards.
  const text = "alpha bravo charlie delta";
  const rows = wrapWithOffsets(text, 12);
  for (const row of rows) {
    assert.equal(text.slice(row.start, row.start + row.text.length), row.text, "row must match its own offset");
    assert.ok(row.text.length <= 12, `row over width: "${row.text}"`);
  }
});

test("a word longer than the row is split rather than allowed to overflow", () => {
  // An unbroken URL must not push the box wider than the terminal.
  const rows = wrapWithOffsets("x".repeat(50), 10);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.text.length, 10);
});

test("explicit newlines always break, including empty lines", () => {
  const rows = wrapWithOffsets("one\n\ntwo", 40);
  assert.deepEqual(rows.map((r) => r.text), ["one", "", "two"]);
});

test("the cursor lands on the row the caret is actually on", () => {
  const text = "alpha bravo charlie delta";
  const rows = wrapWithOffsets(text, 12);
  for (let c = 0; c <= text.length; c++) {
    const v = inputView(text, c, 12, 20);
    const row = v.rows[v.cursorRow]!;
    assert.ok(v.cursorRow >= 0 && v.cursorRow < rows.length, `cursor ${c} off the rows`);
    assert.ok(v.cursorCol >= 0 && v.cursorCol <= row.text.length, `cursor ${c} off row ${v.cursorRow}`);
    assert.equal(row.start + v.cursorCol, Math.min(c, row.start + row.text.length));
  }
});

test("a cursor at a wrap point sits at the START of the new row, not the end of the old", () => {
  // Where the caret belongs after typing the character that caused the break. Getting
  // this backwards makes the caret appear to jump a line behind what you typed.
  const text = "alpha bravo";
  const v = inputView(text, 6, 6, 20); // "alpha" / "bravo", cursor at 'b'
  assert.equal(v.rows[v.cursorRow]!.text, "bravo");
  assert.equal(v.cursorCol, 0);
});

test("the box never exceeds its row cap, however long the message", () => {
  // THE FIX. Left to grow, the box takes rows off a fixed frame, and the tip line at
  // the bottom is what falls off.
  const huge = Array.from({ length: 200 }, (_, i) => `line number ${i}`).join("\n");
  const v = inputView(huge, huge.length, 40, 8);
  assert.equal(v.rows.length, 8);
  assert.ok(v.hiddenAbove > 0, "and it says what it scrolled past");
});

test("the cursor stays visible when the buffer is taller than the cap", () => {
  const huge = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  for (const cursor of [0, 200, huge.length]) {
    const v = inputView(huge, cursor, 40, 6);
    assert.ok(v.cursorRow >= 0 && v.cursorRow < v.rows.length, `cursor ${cursor} scrolled out of view`);
  }
});

test("hidden counts add up to the rows not shown", () => {
  const huge = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const v = inputView(huge, 0, 40, 6);
  assert.equal(v.rows.length + v.hiddenAbove + v.hiddenBelow, 30);
});

test("an empty buffer still yields one row, so the box never collapses", () => {
  const v = inputView("", 0, 40, 8);
  assert.equal(v.rows.length, 1);
  assert.equal(v.cursorRow, 0);
  assert.equal(v.cursorCol, 0);
});

test("a degenerate width does not hang or produce empty rows forever", () => {
  const rows = wrapWithOffsets("hello world", 0);
  assert.ok(rows.length > 0 && rows.length <= 11);
  assert.ok(rows.every((r) => r.text.length <= 1));
});
