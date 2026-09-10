import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDALONE_HOLD_MS, groupSettled, isGroupMember, planGroupReveal, planStandaloneReveal, resultQueued } from "./groupReveal.js";

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

// ── a standalone row is held, but not forever ────────────────────────────────
//
// Held with no limit, a `cargo run --release` row was invisible for the ten minutes the
// build took: the last thing on screen stayed the tool before it, the footer's timer
// counted up, and an agent working steadily was indistinguishable from one that had hung.
// It was reported as a hang. Nothing was wrong except that nothing was shown.

test("a row whose result is already queued reveals at once", () => {
  // The calm case, unchanged: a read or an edit resolves in milliseconds, so the pair is
  // ready long before any deadline and the row still arrives carrying its body.
  const plan = planStandaloneReveal({ resultQueued: true, flushing: false, streamDone: false, heldForMs: 0 });
  assert.equal(plan, "reveal");
});

test("a row whose result has not come is held — briefly", () => {
  const plan = planStandaloneReveal({ resultQueued: false, flushing: false, streamDone: false, heldForMs: 0 });
  assert.equal(plan, "hold");
});

test("past the deadline it is shown bare rather than not at all", () => {
  // The two-stage reveal this file exists to avoid, accepted deliberately: a header now
  // with its body later is strictly better than ten minutes of nothing.
  const plan = planStandaloneReveal({
    resultQueued: false,
    flushing: false,
    streamDone: false,
    heldForMs: STANDALONE_HOLD_MS,
  });
  assert.equal(plan, "reveal");
});

test("the deadline is past every local tool and short of a human noticing", () => {
  // A read, an edit and a search all resolve in single-digit milliseconds, so none of them
  // may ever reach it; and nobody should watch a still screen for a second wondering.
  assert.ok(STANDALONE_HOLD_MS >= 100, `${STANDALONE_HOLD_MS}ms would flash on ordinary tools`);
  assert.ok(STANDALONE_HOLD_MS <= 1500, `${STANDALONE_HOLD_MS}ms is long enough to read as a hang`);
});

test("Esc and the end of the stream still release it immediately", () => {
  // Both existed before the deadline and both still outrank it: Esc is the user asking to
  // see the rest now, and once the stream is over no result can ever arrive.
  for (const heldForMs of [0, STANDALONE_HOLD_MS * 10]) {
    assert.equal(
      planStandaloneReveal({ resultQueued: false, flushing: true, streamDone: false, heldForMs }),
      "reveal",
    );
    assert.equal(
      planStandaloneReveal({ resultQueued: false, flushing: false, streamDone: true, heldForMs }),
      "reveal",
    );
  }
});

test("the GROUP hold keeps its absence of a timer", () => {
  // Deliberately not given the same deadline. A group is a burst of local reads with a
  // model round-trip between them, so any short grace elapses almost every time and the
  // group ends up shown live-updating — the exact bug the group hold exists to avoid.
  assert.equal(planGroupReveal(false, false), "hold");
  assert.equal(planGroupReveal(true, false), "flush");
});
