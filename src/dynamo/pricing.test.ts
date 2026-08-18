/**
 * pricing.test.ts — the task usage/cost summary (pure).
 *
 * Verifies the fix for the "every task looks like ~700K" problem: ctx is the LAST
 * call's prompt (not a sum), hit/miss/output are summed, the cache split drives a
 * cache-aware cost, and a provider that omits the split is costed safely as fresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTask, priceFor, formatTokens, formatCost, taskLimitReason } from "./pricing.js";
import type { Usage } from "../drivers/types.js";

const u = (p: number, c: number, hit: number, miss: number): Usage => ({
  promptTokens: p,
  completionTokens: c,
  totalTokens: p + c,
  cacheHitTokens: hit,
  cacheMissTokens: miss,
});

test("summarizeTask uses the LAST prompt as ctx and SUMS the billed tokens", () => {
  // Three steps, context growing as the conversation is re-sent each call.
  const s = summarizeTask(
    [u(40_000, 1000, 30_000, 10_000), u(45_000, 1000, 42_000, 3000), u(50_000, 2000, 47_000, 3000)],
    "deepseek-v4-flash",
  )!;
  assert.equal(s.ctxTokens, 50_000); // the LAST call's prompt, not 135_000
  assert.equal(s.totalTokens, 41_000 + 46_000 + 52_000); // real throughput, summed
  assert.equal(s.cacheHitTokens, 119_000);
  assert.equal(s.cacheMissTokens, 16_000);
  assert.equal(s.outputTokens, 4000);
  assert.equal(s.cachePct, Math.round((119_000 / 135_000) * 100)); // 88%
});

test("summarizeTask costs cache hits ~10x cheaper than misses (DeepSeek default)", () => {
  const s = summarizeTask([u(1_000_000, 0, 1_000_000, 0)], "deepseek-v4-flash")!;
  // 1M cache-hit tokens at $0.014/M.
  assert.ok(Math.abs(s.costUsd - 0.014) < 1e-9, `got ${s.costUsd}`);
  const miss = summarizeTask([u(1_000_000, 0, 0, 1_000_000)], "deepseek-v4-flash")!;
  assert.ok(Math.abs(miss.costUsd - 0.14) < 1e-9, `got ${miss.costUsd}`);
});

test("summarizeTask treats an unreported cache split as fresh input (safe over-estimate)", () => {
  const s = summarizeTask([u(1_000_000, 0, 0, 0)], "deepseek-v4-flash")!;
  assert.equal(s.cacheMissTokens, 1_000_000);
  assert.equal(s.cachePct, 0);
  assert.ok(Math.abs(s.costUsd - 0.14) < 1e-9);
});

test("summarizeTask returns null for an empty task", () => {
  assert.equal(summarizeTask([]), null);
});

test("priceFor honors a MINDWEAVE_PRICE override, else falls back to the table/default", () => {
  const prev = process.env.MINDWEAVE_PRICE;
  try {
    delete process.env.MINDWEAVE_PRICE;
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
    assert.deepEqual(priceFor("unknown-model"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
    process.env.MINDWEAVE_PRICE = "1,2,3";
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 1, cacheMiss: 2, output: 3 });
    process.env.MINDWEAVE_PRICE = "garbage";
    assert.deepEqual(priceFor("deepseek-v4-flash"), { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 });
  } finally {
    if (prev === undefined) delete process.env.MINDWEAVE_PRICE;
    else process.env.MINDWEAVE_PRICE = prev;
  }
});

test("taskLimitReason fires on cost or time, and is disabled at 0", () => {
  const usage = summarizeTask([u(1_000_000, 0, 0, 1_000_000)], "deepseek-v4-flash")!; // $0.14
  // Cost ceiling
  assert.match(taskLimitReason(usage, 0, { maxUsd: 0.1, maxSeconds: 0 })!, /cost ceiling/);
  assert.equal(taskLimitReason(usage, 0, { maxUsd: 0.5, maxSeconds: 0 }), null);
  // Time ceiling
  assert.match(taskLimitReason(null, 20_000, { maxUsd: 0, maxSeconds: 10 })!, /time ceiling/);
  assert.equal(taskLimitReason(null, 5_000, { maxUsd: 0, maxSeconds: 10 }), null);
  // Both disabled
  assert.equal(taskLimitReason(usage, 999_000, { maxUsd: 0, maxSeconds: 0 }), null);
});

test("formatTokens and formatCost render compactly", () => {
  assert.equal(formatTokens(540), "540");
  assert.equal(formatTokens(8123), "8.1K");
  assert.equal(formatTokens(56_000), "56K");
  assert.equal(formatCost(0.0005), "<$0.001");
  assert.equal(formatCost(0.018), "~$0.018");
  assert.equal(formatCost(1.42), "~$1.42");
});

// ── The number the status line shows ──────────────────────────────────────────

test("billedTokens counts each token ONCE, however many tool rounds a turn took", () => {
  // The defect this exists to prevent. A turn re-sends its whole prompt on every
  // tool round, so summing per-call totals counts the same text once per step: the
  // figure climbs with tool use rather than with work done, and a long turn looks
  // catastrophically expensive when it was mostly cache reads.
  const s = summarizeTask(
    [u(40_000, 1000, 30_000, 10_000), u(45_000, 1000, 42_000, 3000), u(50_000, 2000, 47_000, 3000)],
    "deepseek-v4-flash",
  )!;
  // Fresh input (16K) + everything generated (4K). Not 139K.
  assert.equal(s.billedTokens, 16_000 + 4000);
  assert.ok(s.billedTokens < s.totalTokens / 6, "the inflated total must not be what we show");
});

test("a turn with NO tool rounds reports the same either way", () => {
  // A single call has nothing to double-count, so the honest number and the naive
  // one agree. If they ever disagree here, the fix has broken the simple case.
  const s = summarizeTask([u(1000, 200, 0, 1000)], "deepseek-v4-flash")!;
  assert.equal(s.billedTokens, 1200);
  assert.equal(s.billedTokens, s.totalTokens);
});

test("billedTokens grows when real work is done, not when the prompt is re-read", () => {
  // Two turns, same number of steps. The second reads far more cache but does the
  // same fresh work, and must not report a larger figure.
  const light = summarizeTask([u(10_000, 500, 0, 10_000), u(11_000, 500, 10_000, 1000)], "deepseek-v4-flash")!;
  const heavy = summarizeTask([u(90_000, 500, 80_000, 10_000), u(91_000, 500, 90_000, 1000)], "deepseek-v4-flash")!;
  assert.equal(light.billedTokens, heavy.billedTokens, "cache reads must not inflate the figure");
  assert.ok(heavy.totalTokens > light.totalTokens * 4, "the naive total does inflate, which is the point");
});

test("an unreported cache split still produces an honest billed figure", () => {
  // Providers that report no split have the whole prompt counted as fresh, so the
  // figure over-states rather than under-states. Never the other way round.
  const s = summarizeTask([u(5000, 100, 0, 0)], "deepseek-v4-flash")!;
  assert.equal(s.billedTokens, 5100);
});
