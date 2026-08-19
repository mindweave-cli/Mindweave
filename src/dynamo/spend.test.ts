/**
 * spend.test.ts — the session-level cost arithmetic.
 *
 * This is shown to a user as money, so it is tested rather than trusted. The two things
 * that must hold: tokens are counted ONCE across a multi-round turn (never the inflated
 * per-call totals), and an inferred figure never launders itself into an exact one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySpend, addTurn, cachePct } from "./spend.js";
import type { TaskUsage } from "./pricing.js";

const turn = (o: Partial<TaskUsage> = {}): TaskUsage => ({
  billedTokens: 1000,
  totalTokens: 9999,
  ctxTokens: 5000,
  cacheHitTokens: 4000,
  cacheMissTokens: 900,
  cacheWriteTokens: 400,
  outputTokens: 100,
  cachePct: 81,
  costUsd: 0.01,
  estimated: false,
  ...o,
});

test("a fresh session has spent nothing", () => {
  const s = emptySpend();
  assert.equal(s.billed, 0);
  assert.equal(s.turns, 0);
  assert.equal(s.estimated, false);
});

test("turns accumulate", () => {
  const s = addTurn(addTurn(emptySpend(), turn()), turn());
  assert.equal(s.turns, 2);
  assert.equal(s.billed, 2000);
  assert.equal(s.cacheWrite, 800);
  assert.ok(Math.abs(s.costUsd - 0.02) < 1e-9);
});

test("the inflated per-call total is never what accumulates", () => {
  // `totalTokens` re-counts the cached prefix once per tool round. Summing it is what
  // made a normal turn read 147K, and it must never reach a figure shown as spend.
  const s = addTurn(emptySpend(), turn());
  assert.equal(s.billed, 1000, "billed must come from misses + output, not the per-call total");
  assert.notEqual(s.billed, 9999);
});

test("estimated is sticky — a later exact turn does not launder an earlier guess", () => {
  const s = addTurn(addTurn(emptySpend(), turn({ estimated: true })), turn({ estimated: false }));
  assert.equal(s.estimated, true, "a session containing an inferred turn is partly inferred forever");
});

test("estimated stays false when every turn was measured", () => {
  const s = addTurn(addTurn(emptySpend(), turn()), turn());
  assert.equal(s.estimated, false);
});

test("cache percentage is derived from the running sums", () => {
  const s = addTurn(emptySpend(), turn({ cacheHitTokens: 9000, cacheMissTokens: 1000 }));
  assert.equal(cachePct(s), 90);
  assert.equal(cachePct(emptySpend()), 0, "no input is 0%, not a division by zero");
});
