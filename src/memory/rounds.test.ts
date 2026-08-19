/**
 * rounds.test.ts — API-round grouping, and dropping the oldest rounds on overflow.
 *
 * The unit matters. A single round with six parallel tool calls is SEVEN entries, so
 * counting entries can cut a round in half — severing a tool call from its result and
 * turning a request that was merely too long into one the provider rejects as
 * malformed. A round boundary is the one split the wire format guarantees is safe:
 * every tool result is resolved before the next assistant turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByRound, dropOldestRounds } from "./compaction.js";
import type { Entry } from "./types.js";

const user = (c: string): Entry => ({ role: "user", content: c });
const asst = (c: string, calls?: string[]): Entry => ({
  role: "assistant",
  content: c,
  ...(calls ? { toolCalls: calls.map((id) => ({ id, name: "read_file", arguments: "{}" })) } : {}),
});
const tool = (id: string, c = "result"): Entry => ({ role: "tool", toolCallId: id, content: c });

/** Two rounds, the first with three parallel calls. */
const CONVO: Entry[] = [
  user("do the thing"),
  asst("working", ["a", "b", "c"]),
  tool("a"),
  tool("b"),
  tool("c"),
  asst("now this", ["d"]),
  tool("d"),
  asst("done"),
];

test("a round starts at each assistant entry and carries its own tool results", () => {
  const groups = groupByRound(CONVO);
  assert.equal(groups.length, 4, "preamble + three assistant rounds");
  assert.deepEqual(groups[0], [user("do the thing")], "the preamble is its own group");
  assert.equal(groups[1]!.length, 4, "the assistant plus all three of its results");
  assert.equal(groups[1]![0]!.role, "assistant");
  assert.ok(groups[1]!.slice(1).every((e) => e.role === "tool"));
});

test("no group ever splits a tool call from its result", () => {
  for (const g of groupByRound(CONVO)) {
    const calls = g.flatMap((e) => (e.role === "assistant" ? (e.toolCalls ?? []).map((c) => c.id) : []));
    const results = g.flatMap((e) => (e.role === "tool" ? [e.toolCallId] : []));
    for (const id of calls) {
      assert.ok(results.includes(id), `call ${id} was separated from its result`);
    }
  }
});

test("an empty or single-round conversation cannot be shed", () => {
  assert.equal(dropOldestRounds([]), null);
  assert.equal(dropOldestRounds([user("hi")]), null, "one group means nothing to drop");
});

test("dropping sheds whole rounds from the OLDEST end and keeps the newest", () => {
  const kept = dropOldestRounds(CONVO, undefined, () => 100)!;
  assert.ok(kept.length < CONVO.length, "something must actually be dropped");
  assert.deepEqual(kept[kept.length - 1], asst("done"), "the newest work is what survives");
});

test("what survives always begins with an assistant — by construction, not by a check", () => {
  // A defensive "strip a leading orphaned tool result" was written here first, and a
  // red check proved it could never fire: every group after the first starts with an
  // assistant entry, so any surviving slice does too. The guard was deleted rather than
  // kept, because an unreachable guard reads as protection while providing none. This
  // test replaces it by asserting the property that makes it unnecessary.
  const groups = groupByRound(CONVO);
  for (const g of groups.slice(1)) {
    assert.equal(g[0]!.role, "assistant", "a non-preamble group must start at an assistant");
  }
  for (const gap of [1, 50, 100, 1000, 100_000]) {
    const kept = dropOldestRounds(CONVO, gap, () => 100);
    if (!kept) continue;
    assert.notEqual(kept[0]!.role, "tool", `gap=${gap} left a dangling tool result at the head`);
  }
});

test("a reported token gap decides how much to shed", () => {
  // Each group counts 100 here, so a gap of 250 needs three groups.
  const kept = dropOldestRounds(CONVO, 250, () => 100)!;
  const groups = groupByRound(CONVO);
  assert.deepEqual(kept, groups.slice(3).flat());
});

test("at least one round always survives, however large the gap", () => {
  const kept = dropOldestRounds(CONVO, 10_000_000, () => 100);
  assert.ok(kept && kept.length > 0, "shedding everything leaves nothing to summarize or continue from");
});
