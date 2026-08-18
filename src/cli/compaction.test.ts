/**
 * compaction.test.ts — the compaction report's layout and its arithmetic.
 *
 * Pure text, so it is checked here rather than through a rendered frame: what matters
 * is that the bars are honest at the edges (empty, nearly-full, over-full) and that the
 * two of them line up when the digits differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bar, percent, compactionLines } from "./compaction.js";

test("a bar fills in proportion, and is 20 cells by default", () => {
  assert.equal(bar(0, 100), `[${"░".repeat(20)}]`);
  assert.equal(bar(50, 100), `[${"█".repeat(10)}${"░".repeat(10)}]`);
  assert.equal(bar(100, 100), `[${"█".repeat(20)}]`);
});

test("a full bar means FULL, and a used context never looks empty", () => {
  // Both directions matter for trust. Rounding could show 99.9% as a complete bar —
  // telling the user there is no room left when there is — and could show a small but
  // real usage as untouched.
  assert.ok(bar(9990, 10000).includes("░"), "99.9% must not render as full");
  assert.ok(bar(1, 10000).includes("█"), "a used context must show at least one cell");
  assert.equal(bar(0, 10000).includes("█"), false, "…but an empty one shows none");
});

test("an over-full measurement clamps instead of overflowing the row", () => {
  // The estimate can exceed the window (it is an estimate). A bar wider than its
  // brackets would break the row it sits in.
  const b = bar(200_000, 128_000);
  assert.equal(b.length, 22, "20 cells plus two brackets, always");
  assert.equal(percent(200_000, 128_000).trim(), "100%");
});

test("a zero window degrades to empty rather than dividing by zero", () => {
  assert.equal(percent(1000, 0).trim(), "0%");
  assert.ok(bar(1000, 0).includes("░"));
});

test("percentages are padded so the two bars line up", () => {
  // 7% and 100% must occupy the same columns, or the stacked bars read as ragged.
  assert.equal(percent(7, 100).length, percent(100, 100).length);
});

test("the block is three rows: before, what it recovered, after", () => {
  const rows = compactionLines({ before: 128_000, after: 22_000, window: 128_000 });
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /100%\s+before/);
  assert.match(rows[1]!, /✔ Reclaimed 106K tokens \(22K \/ 128K\)/);
  assert.match(rows[2]!, /17%\s+after/);
});

test("the labels stay true when /compact is typed early", () => {
  // The reference design says "Context Full" over the first bar. That is only true
  // when the pass ran at the threshold; typed by hand at 75% it would caption the
  // picture with a contradiction.
  const rows = compactionLines({ before: 96_000, after: 41_000, window: 128_000 });
  assert.match(rows[0]!, /75%/);
  assert.doesNotMatch(rows.join("\n"), /full/i);
});

test("a pass that recovered nothing reports zero, never a negative", () => {
  const rows = compactionLines({ before: 40_000, after: 44_000, window: 128_000 });
  assert.match(rows[1]!, /Reclaimed 0 tokens/);
});

test("bars shrink on a narrow terminal instead of wrapping", () => {
  // A wrapped bar reads as two broken bars, so width is spent on the bar rather than
  // allowed to overflow.
  const wide = compactionLines({ before: 100, after: 10, window: 100 }, 100);
  const narrow = compactionLines({ before: 100, after: 10, window: 100 }, 40);
  assert.ok(narrow[0]!.length < wide[0]!.length);
  for (const row of narrow) assert.ok(row.length <= 40, `row must fit: ${row}`);
});
