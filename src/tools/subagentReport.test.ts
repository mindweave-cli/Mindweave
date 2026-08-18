/**
 * subagentReport.test.ts — a child's report is a claim until the run is checked.
 *
 * The failure being prevented is the quiet one: a child that stopped early, or found
 * nothing, or misunderstood the task, hands back prose that reads exactly like success.
 * These pin that the MECHANICAL signals fire regardless of what the child claims about
 * itself, because a child that misunderstood its task is precisely the one that will
 * report having finished it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, renderVerdict, verifySubagentReport, STATUS_INSTRUCTION } from "./subagentReport.js";

const REPORT = "Found 3 call sites:\n- src/a.ts:10\n- src/b.ts:22\n- src/c.ts:31";
const clean = { steps: 4, budget: 20 };

test("a clean run is trusted and reads exactly as the child wrote it", () => {
  const v = verifySubagentReport(`${REPORT}\nSTATUS: complete`, clean);
  assert.equal(v.status, "complete");
  assert.equal(v.trustworthy, true);
  assert.deepEqual(v.concerns, []);
  assert.equal(renderVerdict(v), REPORT, "no caveat means no wrapper");
});

test("the status line is stripped, so protocol never leaks into the parent's context", () => {
  const { body } = parseStatus(`${REPORT}\nSTATUS: complete`);
  assert.equal(body, REPORT);
  assert.ok(!body.includes("STATUS"), "the marker must not travel upward");
});

test("the status line is read despite the formatting a model tends to add", () => {
  for (const line of ["STATUS: complete", "**STATUS: complete**", "> STATUS:  complete", "status: Complete."]) {
    assert.equal(parseStatus(`${REPORT}\n${line}`).status, "complete", line);
  }
});

test("MECHANICAL: exhausting the step budget is flagged even when the child claims success", () => {
  // The load-bearing case. A child that used every step it had did not choose to stop,
  // so its confidence is irrelevant — this is unfinished work.
  const v = verifySubagentReport(`${REPORT}\nSTATUS: complete`, { steps: 20, budget: 20 });
  assert.equal(v.trustworthy, false, "a self-reported success cannot override running out of room");
  assert.match(v.concerns.join(" "), /entire 20-step budget/);
  assert.match(v.concerns.join(" "), /max_steps/, "and the parent is told how to get the rest");
});

test("MECHANICAL: a near-empty report is flagged", () => {
  const v = verifySubagentReport("done\nSTATUS: complete", clean);
  assert.equal(v.trustworthy, false);
  assert.match(v.concerns.join(" "), /almost no content/);
});

test("a child that never stated an outcome is marked unverified, not assumed good", () => {
  const v = verifySubagentReport(REPORT, clean);
  assert.equal(v.status, "unstated");
  assert.equal(v.trustworthy, false);
  assert.match(v.concerns.join(" "), /did not state whether it finished/);
});

test("a declared failure is called out as not-a-result", () => {
  const v = verifySubagentReport(`I could not find the file.\nSTATUS: failed`, clean);
  assert.equal(v.status, "failed");
  assert.equal(v.trustworthy, false);
  assert.match(v.concerns.join(" "), /could NOT do the task/);
});

test("a declared partial is passed through, flagged rather than withheld", () => {
  const v = verifySubagentReport(`${REPORT}\nSTATUS: partial`, clean);
  assert.equal(v.trustworthy, false);
  assert.match(v.concerns.join(" "), /only part of the task/);
  assert.ok(renderVerdict(v).includes(REPORT), "the findings still reach the parent — they may be useful");
});

test("caveats render ABOVE the report, not after it", () => {
  // A warning printed under 200 lines of findings is read after the parent has already
  // formed a conclusion, which is the same as not printing it.
  const v = verifySubagentReport(`${REPORT}\nSTATUS: partial`, { steps: 20, budget: 20 });
  const out = renderVerdict(v);
  assert.ok(out.indexOf("Before using this report") < out.indexOf("Found 3 call sites"));
  assert.match(out, /^Before using this report:\n- /, "several concerns list rather than run together");
});

test("the instruction the child is given actually names the three statuses", () => {
  // The parser and the instruction have to agree, or every child reads as unstated.
  for (const s of ["complete", "partial", "failed"]) assert.ok(STATUS_INSTRUCTION.includes(s), s);
  assert.equal(parseStatus("x\nSTATUS: complete").status, "complete");
  assert.equal(parseStatus("x\nSTATUS: partial").status, "partial");
  assert.equal(parseStatus("x\nSTATUS: failed").status, "failed");
});
