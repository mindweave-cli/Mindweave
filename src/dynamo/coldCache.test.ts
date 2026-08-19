/**
 * coldCache.test.ts — microcompact when the provider's cache has expired.
 *
 * The gate on microcompaction exists because clearing an old tool body rewrites the
 * transcript, and the transcript is the cached half of the request: on a warm cache
 * that trades a cheap cached read for a 1.25x prefix rewrite. Once the entry has
 * expired there is nothing left to invalidate, so the same work becomes free — and the
 * tokens never have to be paid for again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheLikelyCold, CACHE_TTL_MS } from "./contextWindow.js";

const MICRO_BAR = 40_000;
const NOW = 1_000_000_000;

test("a warm cache is left alone even with plenty of context", () => {
  // Inside the TTL the entry still exists, so rewriting the transcript would throw away
  // a cache read and pay 1.25x to rebuild it. That is the loss the gate prevents.
  const justInside = NOW - (CACHE_TTL_MS - 1000);
  assert.equal(cacheLikelyCold(justInside, NOW, MICRO_BAR, MICRO_BAR), false);
});

test("an expired cache with real context to save compacts", () => {
  const longAgo = NOW - CACHE_TTL_MS * 3;
  assert.equal(cacheLikelyCold(longAgo, NOW, MICRO_BAR, MICRO_BAR), true);
});

test("an expired cache with almost nothing in it is not worth stripping", () => {
  // Below the floor there is little to reclaim, and clearing tool bodies early costs
  // detail the model may still want. Free is not the same as worthwhile.
  const longAgo = NOW - CACHE_TTL_MS * 3;
  assert.equal(cacheLikelyCold(longAgo, NOW, 1_000, MICRO_BAR), false);
});

test("a session that has never called the model is not a cold cache", () => {
  // No call means no entry to have expired, and nothing yet worth clearing. Treating
  // this as cold would compact a fresh session on its very first turn.
  assert.equal(cacheLikelyCold(0, NOW, MICRO_BAR, MICRO_BAR), false);
});

test("the TTL is configurable and respected", () => {
  const gap = 60_000;
  assert.equal(cacheLikelyCold(NOW - gap, NOW, MICRO_BAR, MICRO_BAR, gap * 2), false);
  assert.equal(cacheLikelyCold(NOW - gap, NOW, MICRO_BAR, MICRO_BAR, gap / 2), true);
});

/**
 * clearIsWorthIt — the cache economics of a microcompaction.
 *
 * Clearing rewrites the cached prefix, so it is only free when there is no cache to
 * lose. On a warm one the break-even is N = 11.5 * (P - R) / R steps, which is brutal
 * at small R: reclaiming a tenth of a 40K prefix needs ~103 further steps to pay off.
 * These pin the three ways a clear earns its keep.
 */
import { clearIsWorthIt } from "./contextWindow.js";

const AUTO_BAR = 100_000;

test("a clear that reclaims almost nothing is refused on a warm cache", () => {
  // The defect: fire on the bar, clear 2K out of 40K, and pay to rewrite the other 38K
  // at 1.25x. That is a loss dressed as an optimization.
  const worth = clearIsWorthIt({ before: 40_000, after: 38_000, cold: false, autoBar: AUTO_BAR });
  assert.equal(worth, false);
});

test("a clear that reclaims a large fraction is taken", () => {
  const worth = clearIsWorthIt({ before: 40_000, after: 20_000, cold: false, autoBar: AUTO_BAR });
  assert.equal(worth, true);
});

test("any reclaim is worth it once the cache is cold", () => {
  // Nothing left to invalidate, so even a small clear is pure profit — and those tokens
  // never have to be paid for again.
  const worth = clearIsWorthIt({ before: 40_000, after: 39_000, cold: true, autoBar: AUTO_BAR });
  assert.equal(worth, true);
});

test("near the autocompact bar, fitting beats saving", () => {
  // A request that does not fit cannot be sent at any price, and clearing here is what
  // defers a far more expensive summarization pass.
  const worth = clearIsWorthIt({ before: 95_000, after: 94_000, cold: false, autoBar: AUTO_BAR });
  assert.equal(worth, true);
});

test("a clear that reclaims nothing is never taken", () => {
  assert.equal(clearIsWorthIt({ before: 40_000, after: 40_000, cold: true, autoBar: AUTO_BAR }), false);
  assert.equal(clearIsWorthIt({ before: 40_000, after: 41_000, cold: true, autoBar: AUTO_BAR }), false);
});

test("the assumed cache lifetime errs LONG, never short", () => {
  // Direction matters more than the value. Too short and we clear tool bodies while the
  // provider still holds the prefix — destroying a live entry and paying full price to
  // rewrite it, a cost that would never have been incurred. Too long and we merely miss
  // a saving. 5 minutes is only Anthropic's default tier; DeepSeek's cache persists for
  // hours and several providers publish nothing, so a short default is wrong on most of
  // the lineup.
  assert.ok(
    CACHE_TTL_MS >= 60 * 60 * 1000,
    `CACHE_TTL_MS is ${CACHE_TTL_MS}ms — short enough to force cache misses that would not have happened`,
  );
});
