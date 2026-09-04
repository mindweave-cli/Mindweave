/**
 * testSummary.test.ts — recognising a test run, and refusing to when it is not one.
 *
 * The fixtures are real output shapes, not invented ones. A matcher written against an
 * imagined format is a matcher that has never met the thing it matches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestRun, testDetail, SHOWN_FAILURES } from "./testSummary.js";
import { formatDuration } from "./detail.js";

const NODE_GREEN = `
✔ the caret is a bar sitting at the input position (1372.8263ms)
✔ it goes off and comes back (1339.1279ms)
ℹ tests 2171
ℹ suites 0
ℹ pass 2171
ℹ fail 0
ℹ cancelled 0
ℹ skipped 8
ℹ todo 0
ℹ duration_ms 39821.4494
`;

const NODE_RED = `
✔ a run of one-line tool rows hugs (0.09ms)
✖ caret at end of a full row (231.1699ms)
  AssertionError [ERR_ASSERTION]: the input box truncated what was typed
      at TestContext.<anonymous> (C:\\Projects\\Mindweave\\src\\cli\\inputView.test.ts:64:10)
✖ wide run positions the cursor (2.41ms)
  AssertionError [ERR_ASSERTION]: expected 4, got 5
      at TestContext.<anonymous> (C:\\Projects\\Mindweave\\src\\cli\\paint.test.ts:118:10)
ℹ tests 2171
ℹ pass 2168
ℹ fail 3
ℹ skipped 0
ℹ duration_ms 41213.4
`;

test("a green node run reports its totals", () => {
  const run = parseTestRun(NODE_GREEN);
  assert.ok(run, "a node --test run was not recognised");
  assert.equal(run.passed, 2171);
  assert.equal(run.failed, 0);
  assert.equal(run.skipped, 8);
  assert.equal(run.durationMs, 39821.4494);
});

test("a green run is ONE row and nothing else", () => {
  // The whole reason this exists. Two thousand passing tests print two thousand lines to
  // say that nothing is wrong.
  const run = parseTestRun(NODE_GREEN);
  assert.ok(run);
  assert.equal(testDetail(run, formatDuration), "✓ 2,171 passed · 8 skipped · 39.8s");
});

test("a red run names what broke, and where", () => {
  const run = parseTestRun(NODE_RED);
  assert.ok(run);
  assert.equal(run.failed, 3);
  assert.equal(run.failures.length, 2, "both failing tests should be found");
  assert.equal(run.failures[0]!.name, "caret at end of a full row");
  assert.match(run.failures[0]!.detail ?? "", /truncated what was typed/);
  assert.equal(run.failures[0]!.location, "inputView.test.ts:64");
});

test("the verdict leads with the failures, not the passes", () => {
  const run = parseTestRun(NODE_RED);
  assert.ok(run);
  const rows = testDetail(run, formatDuration).split("\n");
  assert.equal(rows[rows.length - 1], "✗ 3 failed · 2,168 passed · 41.2s");
});

test("only the first few failures are shown, and the rest are counted", () => {
  const run = parseTestRun(NODE_RED);
  assert.ok(run);
  run.failures = Array.from({ length: SHOWN_FAILURES + 7 }, (_, i) => ({ name: `failure ${i}` }));
  const rows = testDetail(run, formatDuration).split("\n");
  assert.equal(rows.filter((r) => r.startsWith("✗ failure")).length, SHOWN_FAILURES);
  assert.ok(
    rows.some((r) => r === "… 7 more failures"),
    `the hidden failures were not counted: ${JSON.stringify(rows)}`,
  );
});

test("vitest counts TESTS, not test files", () => {
  // Both lines carry "failed" and "passed"; reading the first reports three failures as
  // one, which is the sort of wrong that is worse than not recognising the run at all.
  const run = parseTestRun(`
 Test Files  1 failed | 2 passed (3)
      Tests  3 failed | 40 passed (43)
   Duration  1.23s
`);
  assert.ok(run, "a vitest run was not recognised");
  assert.equal(run.failed, 3);
  assert.equal(run.passed, 40);
  assert.equal(run.durationMs, 1230);
});

test("jest is read from its one totals line", () => {
  const run = parseTestRun(`
Tests:       3 failed, 2 skipped, 40 passed, 45 total
Time:        1.234 s
`);
  assert.ok(run, "a jest run was not recognised");
  assert.equal(run.failed, 3);
  assert.equal(run.passed, 40);
  assert.equal(run.skipped, 2);
  assert.equal(run.durationMs, 1234);
});

test("pytest is read from its banner", () => {
  const run = parseTestRun("=================== 3 failed, 40 passed, 2 skipped in 1.23s ===================");
  assert.ok(run, "a pytest run was not recognised");
  assert.equal(run.failed, 3);
  assert.equal(run.passed, 40);
  assert.equal(run.skipped, 2);
});

test("an ordinary command is NOT a test run", () => {
  // The rule the whole file lives under: anything unrecognised falls through to the
  // ordinary shell block, whole. A confident set of numbers that were never there is a
  // worse outcome than no summary.
  assert.equal(parseTestRun("Successfully rebased and updated refs/heads/main"), undefined);
  assert.equal(parseTestRun("build: .github#2\nProcess completed with exit code 1"), undefined);
  assert.equal(parseTestRun(""), undefined);
});

test("a run with no tests at all is not claimed", () => {
  assert.equal(parseTestRun("ℹ tests 0\nℹ pass 0\nℹ fail 0\nℹ duration_ms 12"), undefined);
});

test("a duration the runner did not report is not invented", () => {
  const run = parseTestRun("ℹ tests 3\nℹ pass 3\nℹ fail 0");
  assert.ok(run);
  assert.equal(run.durationMs, undefined);
  assert.equal(testDetail(run, formatDuration), "✓ 3 passed");
});
