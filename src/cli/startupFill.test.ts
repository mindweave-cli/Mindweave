/**
 * startupFill.test.ts — the rule that keeps the inline prompt at the bottom edge.
 *
 * The fill is a run of blank rows printed above the first screen so a short conversation
 * lands at the bottom of the terminal instead of floating part-way up. It goes into
 * `<Static>`, which prints once, so its height is fixed when first printed — and the
 * first render often runs before the real terminal height is known. Sized then, the fill
 * is frozen too small and a band of empty screen stays at the bottom. These pin the rule
 * that grows it once the real height arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { growFill, INLINE_LIVE_RESERVE, NO_FILL } from "./startupFill.js";

test("the first sizing fills the screen and does NOT ask for a remount", () => {
  // Nothing is printed yet, so the first frame carries the fill on its own.
  const d = growFill(NO_FILL, 30);
  assert.equal(d.fill, 30 - INLINE_LIVE_RESERVE);
  assert.equal(d.basis, 30);
  assert.equal(d.remount, false);
});

test("a taller terminal grows the fill and DOES ask for a remount", () => {
  // The settle after a wrong first read, or a window dragged bigger. A void has opened at
  // the bottom and only a remount reprints the fill that closes it.
  const first = growFill(NO_FILL, 20); // stale small first read
  const grown = growFill(first, 40); // real height
  assert.equal(grown.fill, 40 - INLINE_LIVE_RESERVE);
  assert.equal(grown.basis, 40);
  assert.equal(grown.remount, true);
});

test("the exact reported shape: a stale 24 then a real 40 leaves no void", () => {
  const stale = growFill(NO_FILL, 24);
  assert.equal(stale.fill, 19); // frozen too small — this is the void
  const settled = growFill(stale, 40);
  assert.equal(settled.fill, 35, "the fill did not grow to the real height, so the void stays");
  assert.equal(settled.remount, true, "without a remount the grown fill never reaches the screen");
});

test("an unchanged height changes nothing and never reprints", () => {
  const sized = growFill(NO_FILL, 30);
  const again = growFill(sized, 30);
  assert.deepEqual({ fill: again.fill, basis: again.basis }, { fill: sized.fill, basis: sized.basis });
  assert.equal(again.remount, false, "a no-op resize asked for a reprint");
});

test("a SHORTER terminal is left alone — the footer already reaches the bottom there", () => {
  // Once the conversation overflows a short screen the footer sits at the bottom on its
  // own. Shrinking the fill would reprint on every small drag for a void that is not there.
  const tall = growFill(NO_FILL, 40);
  const shorter = growFill(tall, 20);
  assert.equal(shorter.fill, tall.fill, "the fill shrank on a shorter terminal");
  assert.equal(shorter.basis, tall.basis, "the basis dropped, so a later grow would misfire");
  assert.equal(shorter.remount, false);
});

test("growing only fires from the high-water mark, not from the last size", () => {
  // tall -> short -> tall-again must NOT reprint on the way back up to a height already seen.
  const tall = growFill(NO_FILL, 40);
  const short = growFill(tall, 20);
  const back = growFill(short, 40);
  assert.equal(back.remount, false, "returning to a height already filled reprinted needlessly");
  assert.equal(back.fill, tall.fill);
});

test("a tiny terminal never asks for negative fill", () => {
  const d = growFill(NO_FILL, 3);
  assert.equal(d.fill, 0, `reserve ${INLINE_LIVE_RESERVE} on a 3-row terminal must floor at 0, got ${d.fill}`);
});

test("the reserve is the live region's real height", () => {
  // It sizes the fill, so it has to match what the footer at rest occupies — the blank
  // separator, the three input-box rows and the tip. tipLine.probe.test.tsx measures it.
  assert.equal(INLINE_LIVE_RESERVE, 5);
});
