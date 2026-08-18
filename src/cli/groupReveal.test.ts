import { test } from "node:test";
import assert from "node:assert/strict";
import { isGroupMember, groupSettled, planGroupReveal, resultQueued } from "./groupReveal.js";

test("a grouped toolStart and any toolEnd are group members", () => {
  assert.equal(isGroupMember({ type: "toolStart", group: true }), true);
  assert.equal(isGroupMember({ type: "toolEnd" }), true);
});

test("a standalone toolStart, narration, and a sub-agent start are NOT group members", () => {
  assert.equal(isGroupMember({ type: "toolStart", group: false }), false);
  assert.equal(isGroupMember({ type: "toolStart" }), false);
  assert.equal(isGroupMember({ type: "token" }), false);
  assert.equal(isGroupMember({ type: "subagentStart" }), false);
});

test("an empty queue behind the group's opening call is not settled", () => {
  assert.equal(groupSettled([]), false);
});

test("more grouped calls and their ends queued behind it: still not settled, no matter how many", () => {
  const manyItems = Array.from({ length: 50 }, () => ({ type: "toolEnd" as const }));
  assert.equal(groupSettled([{ type: "toolStart", group: true }, ...manyItems]), false);
});

test("anything that isn't part of the group queued behind it: settled", () => {
  assert.equal(groupSettled([{ type: "toolEnd" }, { type: "toolStart", group: false }]), true, "a standalone tool followed");
  assert.equal(groupSettled([{ type: "token" }]), true, "narration followed");
  assert.equal(groupSettled([{ type: "subagentStart" }]), true, "a sub-agent followed");
  assert.equal(groupSettled([{ type: "finishReply" }]), true, "the turn ending followed — the guarantee the hold can't get stuck");
});

test("a standalone call waits for ITS OWN result, not just any tool's", () => {
  const q = [
    { type: "toolStart", toolId: "a" },
    { type: "toolEnd", toolId: "b" },
  ];
  assert.equal(resultQueued("a", q), false, "another tool's end must not release this row");
  assert.equal(resultQueued("b", q), true);
  assert.equal(resultQueued("a", []), false, "nothing queued yet — hold");
});

test("planGroupReveal: settled always flushes", () => {
  assert.equal(planGroupReveal(true, false), "flush");
});

test("planGroupReveal: flushing outright (Esc) always flushes, even unsettled", () => {
  assert.equal(planGroupReveal(false, true), "flush");
});

test("planGroupReveal: not settled, not flushing — hold, with NO time-based escape hatch", () => {
  // Deliberately no third argument for elapsed time: there isn't one anymore.
  // A group holds exactly until it settles, however long that takes — see the
  // file header for why a grace period reintroduced the bug it existed to fix.
  assert.equal(planGroupReveal(false, false), "hold");
});
