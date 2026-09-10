/**
 * blockHeights.test.ts — the height table stays bounded, and prunes the right end.
 *
 * Both failure directions are silent. Pruning too little leaks for the length of a
 * session; pruning the wrong end throws away the heights of blocks still on screen,
 * which does not look like a bug, only like the app being slow again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneHeights, MAX_TRACKED_HEIGHTS, needsMeasure } from "./blockHeights.js";

function table(ids: number[]): Map<number, string> {
  return new Map(ids.map((id) => [id, `h${id}`]));
}

test("a table under the cap is left completely alone", () => {
  const t = table([1, 2, 3]);
  pruneHeights(t, 10);
  assert.deepEqual([...t.keys()], [1, 2, 3]);
});

test("exactly at the cap is still not pruned", () => {
  // Off-by-one here throws away a height every single time a block is measured.
  const t = table([1, 2, 3]);
  pruneHeights(t, 3);
  assert.equal(t.size, 3);
});

test("the OLDEST ids go, and the newest are kept", () => {
  // The wrong end is the dangerous one: the newest blocks are the ones on screen, so
  // dropping them means laying them out in full again on the very next frame.
  const t = table([10, 11, 12, 13, 14]);
  pruneHeights(t, 3);
  assert.deepEqual([...t.keys()].sort((a, b) => a - b), [12, 13, 14]);
});

test("insertion order does not decide what is kept", () => {
  // A Map iterates in insertion order, and heights are recorded as blocks are measured,
  // which is not id order — a block scrolled back into view is measured after newer
  // ones. Pruning by iteration order would drop whatever happened to be recorded first.
  const t = new Map<number, string>([[99, "new"], [1, "old"], [50, "mid"]]);
  pruneHeights(t, 2);
  assert.deepEqual([...t.keys()].sort((a, b) => a - b), [50, 99]);
});

test("it prunes down to exactly the cap, not below it", () => {
  const t = table(Array.from({ length: 50 }, (_, i) => i));
  pruneHeights(t, 20);
  assert.equal(t.size, 20);
});

test("the cap leaves real room above the scrollback", () => {
  // Pruning must never be able to reach a block that is still rendered. The scrollback
  // cap is 150 blocks; a table sized near that would evict blocks still on screen.
  assert.ok(MAX_TRACKED_HEIGHTS >= 300, `cap is ${MAX_TRACKED_HEIGHTS}, too close to the scrollback`);
});

// ── what still owes a real measurement ──────────────────────────────────────
//
// A width change RESCALES every recorded height by the ratio of the widths, so the
// scroll arithmetic stays roughly right without laying the whole scrollback out again.
// The entry it leaves behind still points at the same block object, so a check for
// "did the block change" answers no — and the estimate was never paid off. It then
// sized a spacer in the virtual window for the rest of the session.
//
// The error is not small and does not average out: a paragraph that wrapped to one row
// does not become 1.4 rows at a narrower width, it becomes two, and every block is
// rounded on its own. Blocks land a row or two from where they belong, worst exactly
// where the terminal is narrowest.

test("a block with no recorded height must be measured", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure(undefined, block), true);
});

test("a block that CHANGED must be measured — the height describes the old content", () => {
  const before = { id: 1 };
  const after = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block: before }, after), true);
});

test("a real measurement of the same block is not repeated", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block }, block), false);
});

test("a SCALED height owes a measurement even though the block is identical", () => {
  // The whole bug in one assertion. Same object, so "did it change" says no; the height
  // is an estimate from a resize, so it is not a measurement.
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block, scaled: true }, block), true);
});

test("recording a measurement clears the debt", () => {
  // What the measuring effect writes back has no `scaled`, so the next pass leaves it
  // alone. Without this the block would be re-measured on every single render.
  const block = { id: 1 };
  const rescaled = { height: 4, block, scaled: true };
  assert.equal(needsMeasure(rescaled, block), true);
  const measured = { height: 7, block };
  assert.equal(needsMeasure(measured, block), false);
});

test("scaled:false is a measurement, not a debt", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block, scaled: false }, block), false);
});
