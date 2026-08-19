/**
 * cachePoints.test.ts — the breakpoint ladder.
 *
 * These tests exist because the failure they guard is INVISIBLE. A breakpoint that
 * cannot reach a prior cache entry does not error; it reports a cache read of zero,
 * which is indistinguishable from a cold start. So nothing about a live session can
 * tell you the ladder broke — only a test can.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheBreakpoints, needsLadder, BLOCK_SPACING, MESSAGE_BREAKPOINTS } from "./cachePoints.js";
import { buildBody } from "./client.js";
import type { ModelRequest } from "../types.js";

/** The gap, in content blocks, between consecutive breakpoints (and from the last
 *  breakpoint to the end). This is the distance the next request's lookback must cover. */
function gaps(blockCounts: readonly number[], picked: readonly number[]): number[] {
  const out: number[] = [];
  const marks = [...picked];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i]!;
    const to = i + 1 < marks.length ? marks[i + 1]! : blockCounts.length;
    let n = 0;
    for (let j = from + 1; j < to; j++) n += blockCounts[j]!;
    out.push(n);
  }
  return out;
}

test("a short conversation needs no ladder", () => {
  assert.equal(needsLadder([1, 1, 2]), false);
  assert.equal(needsLadder([]), false);
});

test("the last message always carries a breakpoint", () => {
  const counts = Array.from({ length: 40 }, () => 1);
  const picked = cacheBreakpoints(counts);
  assert.equal(picked[picked.length - 1], counts.length - 1, "the stable-prefix boundary must be marked");
});

test("breakpoints never sit more than the 20-block lookback apart", () => {
  // The defect this whole module exists for. One breakpoint on a long agentic
  // conversation leaves the previous entry outside the next request's window, and every
  // request then silently re-pays for the entire prefix.
  const counts = Array.from({ length: 60 }, () => 1);
  const picked = cacheBreakpoints(counts);
  for (const g of gaps(counts, picked)) {
    assert.ok(g < 20, `a ${g}-block gap exceeds the lookback window`);
  }
});

test("a tool-heavy round does not blow past the window", () => {
  // Six blocks per message is three parallel tool calls: tool_use + tool_result each.
  // Two of these rounds already exceed a single breakpoint's reach.
  const counts = Array.from({ length: 20 }, () => 6);
  const picked = cacheBreakpoints(counts);
  assert.ok(picked.length > 1, "a tool-heavy conversation must get more than one breakpoint");
  for (const g of gaps(counts, picked)) {
    assert.ok(g < 20, `a ${g}-block gap exceeds the lookback window`);
  }
});

test("the budget is respected and indexes come back ascending", () => {
  const counts = Array.from({ length: 200 }, () => 4);
  const picked = cacheBreakpoints(counts);
  assert.ok(picked.length <= MESSAGE_BREAKPOINTS, `used ${picked.length} of ${MESSAGE_BREAKPOINTS}`);
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b), "indexes must be ascending");
  assert.equal(new Set(picked).size, picked.length, "no duplicates");
});

test("the budget is spent at the RECENT end, not deep in history", () => {
  // When there is more conversation than budget, an unreachable breakpoint far back
  // buys nothing — the next request looks near the end.
  const counts = Array.from({ length: 500 }, () => 1);
  const picked = cacheBreakpoints(counts);
  assert.ok(
    picked[0]! > counts.length - (MESSAGE_BREAKPOINTS + 1) * BLOCK_SPACING - 5,
    `first breakpoint at ${picked[0]} is stranded far from the end of a ${counts.length}-message conversation`,
  );
});

test("a single message still gets its breakpoint", () => {
  assert.deepEqual(cacheBreakpoints([3]), [0]);
});

test("the rendered request carries at most 4 breakpoints in total", () => {
  // The hard API limit, counted the way the API counts it: system blocks plus message
  // blocks. Exceeding it is a 400, so this is the one bound that must never be wrong.
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message ${i}`,
  }));
  const req: ModelRequest = {
    system: "SYSTEM",
    messages,
    context: "VOLATILE",
  };
  const body = buildBody(req, 1024);
  let systemMarks = 0;
  for (const block of body.system as { cache_control?: unknown }[]) if (block.cache_control) systemMarks++;
  let messageMarks = 0;
  for (const m of body.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if ((b as { cache_control?: unknown }).cache_control) messageMarks++;
  }
  assert.ok(systemMarks + messageMarks <= 4, `${systemMarks + messageMarks} breakpoints exceeds the limit of 4`);
  // MESSAGE marks specifically. Counting the total let the old single-breakpoint
  // behaviour pass, because the system breakpoint alone already made the total exceed
  // one — the regression this file exists to catch went straight through.
  assert.ok(
    messageMarks > 1,
    `only ${messageMarks} message breakpoint(s) on a 60-message conversation — the ladder is not being built`,
  );
});
