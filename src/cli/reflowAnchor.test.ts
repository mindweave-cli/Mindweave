/**
 * reflowAnchor.test.ts — the reading position survives a resize.
 *
 * Reported from a real session: resizing the window moved the conversation out from
 * under the reader. The cause is that `scrollUp` counts LINES back from the newest,
 * and a line is not a stable distance across a re-wrap. Narrow the terminal and every
 * wrapped paragraph grows rows, so the same count lands somewhere else entirely, and
 * a reader who scrolled back to look at something is carried off by a resize they
 * meant as a resize and not as navigation.
 *
 * Being pinned to the newest survived by luck, because zero is zero at any width.
 * Everything else did not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reflowScroll } from "./chatAnchor.js";

test("pinned to the newest stays pinned, at any new size", () => {
  // The common case and the one that must never drift: rounding a proportion of a
  // changed range can otherwise land on 1, which lifts the view off the bottom and
  // stops new output following it.
  for (const next of [0, 1, 40, 500, 10_000]) {
    assert.equal(reflowScroll(0, 300, next), 0, `pinned view drifted at maxScroll ${next}`);
  }
});

test("a scrolled reader keeps their place in proportion", () => {
  // Halfway back through a 200 line range is halfway back through a 400 line one.
  // Not the same paragraph to the row, but within a line or two, where the raw count
  // would have moved them by pages.
  assert.equal(reflowScroll(100, 200, 400), 200);
  assert.equal(reflowScroll(50, 200, 100), 25);
});

test("the very top stays the very top", () => {
  // The other end that a reader can be sitting exactly on. Scrolled fully back must
  // still be fully back, or the oldest content becomes unreachable by resizing.
  assert.equal(reflowScroll(200, 200, 640), 640);
});

test("it never scrolls past what exists", () => {
  // A position beyond the new range would compute an offset that slides the whole
  // transcript off the top, showing nothing and explaining nothing.
  for (const [scrolled, oldMax, newMax] of [
    [500, 200, 40],
    [999, 1000, 3],
    [7, 7, 0],
  ] as const) {
    const got = reflowScroll(scrolled, oldMax, newMax);
    assert.ok(got >= 0 && got <= newMax, `${got} is outside 0..${newMax}`);
  }
});

test("a transcript that did not scroll before rests at the bottom after", () => {
  // Nothing scrollable means the reader was looking at the whole thing, so there is
  // no proportion to carry. Dividing by that range instead of special-casing it would
  // be a division by zero.
  assert.equal(reflowScroll(0, 0, 300), 0);
  assert.equal(reflowScroll(5, 0, 300), 0);
});

test("growing the window pulls the reader toward the newest, never away", () => {
  // Making the terminal taller reduces how much is scrollable. The position has to
  // shrink with it rather than stay a large line count pointing past the end.
  const before = 120;
  const after = reflowScroll(before, 400, 80);
  assert.ok(after <= 80, `a taller window left the view ${after} lines back in an 80 line range`);
});

test("a negative position cannot survive the conversion", () => {
  // The one thing the zero guard actually does. A negative scroll would keep its sign
  // through the proportion and become a negative offset, which slides the transcript
  // off the TOP of the viewport: nothing on screen, and nothing explaining why.
  assert.equal(reflowScroll(-5, 200, 400), 0);
  assert.equal(reflowScroll(-1, 0, 0), 0);
});
