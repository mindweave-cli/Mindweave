/**
 * outputShape.test.ts — the rules that decide what survives out of a long command's
 * output, checked against the shapes that actually turn up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capEnds, condense, stripCommonPrefix, stripTimestamps } from "./outputShape.js";

test("a CI log loses its job column and its timestamps", () => {
  // The case this exists for. Better than half of every row is the job name and a
  // timestamp, identical in shape on every line, before anything is said.
  const lines = [
    "build     Build installers        2026-09-03T12:39:26.8496621Z HttpError: 403 Forbidden",
    "build     Build installers        2026-09-03T12:39:26.8516023Z   at createHttpError (httpExecutor.ts:30:10)",
    "build     Build installers        2026-09-03T12:39:26.8786998Z Process completed with exit code 1",
  ];
  assert.deepEqual(condense(lines), [
    "HttpError: 403 Forbidden",
    "  at createHttpError (httpExecutor.ts:30:10)",
    "Process completed with exit code 1",
  ]);
});

test("one unprefixed line does not save the column for the rest", () => {
  // Found by rendering a real log rather than by reading the rule. A wrapped path
  // continues on a row with no columns at all, and under "every line must share it" that
  // one row reduced the shared prefix to nothing and handed back the whole log untouched
  // — the exact output the stripping exists for, never stripped.
  const lines = [
    "build   Build installers   downloading electron",
    "build   Build installers   at createHttpError (D:\\a\\node_modules\\builder-util-runtime",
    "\\src\\httpExecutor.ts:30:10)",
    "build   Build installers   Process completed with exit code 1",
  ];
  assert.deepEqual(stripCommonPrefix(lines), [
    "downloading electron",
    "at createHttpError (D:\\a\\node_modules\\builder-util-runtime",
    "\\src\\httpExecutor.ts:30:10)",
    "Process completed with exit code 1",
  ]);
});

test("a column carried by only one line is not chrome", () => {
  // The other side of the majority rule: one padded row among plain ones is a line that
  // happens to contain two spaces, not a column the output is written in.
  const lines = ["starting up", "worker   ready", "shutting down", "all done"];
  assert.deepEqual(stripCommonPrefix(lines), lines);
});

test("the shared prefix is cut at a column, not mid-word", () => {
  // Timestamps share their leading digits, so the longest common prefix ends inside the
  // hour. Cutting there would leave rows starting `9:26.84Z`.
  const lines = [
    "job  2026-09-03T12:39:26Z alpha",
    "job  2026-09-03T12:39:44Z bravo",
    "job  2026-09-03T12:41:02Z charlie",
  ];
  for (const line of stripCommonPrefix(lines)) {
    assert.match(line, /^2026-09-03T12:\d\d:\d\dZ /, `cut through a word: ${line}`);
  }
});

test("a diff keeps its markers", () => {
  // Every line starts with the same two characters, and those two characters are the
  // entire meaning of the line.
  const lines = ["+ added one", "+ added two", "+ added three"];
  assert.deepEqual(stripCommonPrefix(lines), lines);
});

test("two lines are not a pattern", () => {
  const lines = ["prefix here alpha", "prefix here bravo"];
  assert.deepEqual(stripCommonPrefix(lines), lines);
});

test("a shared opening phrase is content, not a column", () => {
  // Three lines of prose that begin the same way share a prefix ending in an ordinary
  // space. Cutting there would leave `staging` / `staging now` and delete what the
  // command was actually reporting.
  const lines = ["deploying to staging", "deploying to staging now", "deploying to staging again"];
  assert.deepEqual(stripCommonPrefix(lines), lines);
});

test("blank lines survive and do not decide the prefix", () => {
  const lines = ["region one   alpha", "", "region one   bravo", "region one   charlie"];
  assert.deepEqual(stripCommonPrefix(lines), ["alpha", "", "bravo", "charlie"]);
});

test("timestamps go even when only some lines carry one", () => {
  const lines = ["2026-09-03T12:39:26Z starting", "continuing", "2026-09-03T12:39:27Z done"];
  assert.deepEqual(stripTimestamps(lines), ["starting", "continuing", "done"]);
});

test("one dated line among many is left alone", () => {
  // A commit log line or a printed date is content. Stripping it because it looks like a
  // stamp would delete part of what the command actually said.
  const lines = ["alpha", "bravo", "2026-09-03T12:39:26Z charlie", "delta", "echo"];
  assert.deepEqual(stripTimestamps(lines), lines);
});

test("the cap always keeps the END of the output", () => {
  // Output is read backwards when it FAILED: what went wrong is on the last line. An
  // even earlier cap kept only the head, so a failed run showed its banner and dropped
  // its error. Whatever else changes here, the last line survives.
  const lines = ["one", "two", "three", "four", "five"];
  const capped = capEnds(lines, 3);
  assert.equal(capped[capped.length - 1], "five");
  assert.deepEqual(capped.slice(-2), ["four", "five"]);
});

test("and the FIRST line too — a command that worked says what it did up front", () => {
  // A scaffolder announces what it built in its opening line and signs off with advice
  // about what to do next. Capped from the end alone, a command that created a whole
  // project directory displayed nothing but the sign-off.
  const lines = ["Template created!", "two", "three", "four", "run npm run tauri dev"];
  const capped = capEnds(lines, 3);
  assert.equal(capped[0], "Template created!");
  assert.match(capped[1]!, /2 earlier lines hidden/);
  assert.deepEqual(capped.slice(2), ["four", "run npm run tauri dev"]);
});

test("the notice sits directly above the tail it introduces", () => {
  // Not at the very top, where it would claim the opening line was hidden too, and not
  // below the tail, where it reads as one more line the command printed.
  const capped = capEnds(["first", "a", "b", "c", "last"], 3);
  const notice = capped.findIndex((l) => l.includes("hidden"));
  assert.equal(notice, 1, `the notice landed at ${notice}: ${JSON.stringify(capped)}`);
});

test("with room for one line only, that line is the END", () => {
  // A failure is the case that cannot afford to lose its last line, so a budget too
  // small for both ends spends it there rather than on the banner.
  const capped = capEnds(["one", "two", "three"], 1);
  assert.equal(capped[capped.length - 1], "three");
  assert.match(capped[0]!, /2 earlier lines hidden/);
});

test("no notice when the two ends meet", () => {
  // Exactly one line over budget: head + tail covers everything, and a notice saying
  // "0 lines hidden" would report a hole where there is none.
  const capped = capEnds(["one", "two", "three"], 3);
  assert.deepEqual(capped, ["one", "two", "three"]);
  const tight = capEnds(["one", "two", "three", "four"], 4);
  assert.deepEqual(tight, ["one", "two", "three", "four"]);
});

test("output that fits is untouched, notice and all", () => {
  const lines = ["one", "two"];
  assert.deepEqual(capEnds(lines, 5), lines);
});

test("one hidden line is singular", () => {
  assert.match(capEnds(["one", "two"], 1)[0]!, /1 earlier line hidden/);
});
