/**
 * contextWindow.test.ts — model-anchored thresholds: micro < auto < window, a
 * longer-window model automatically gets a higher bar, and the summary reserve
 * comes from the driver rather than a constant in core.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  warnBarFor,
  contextPressure,
  sharpContextWindow,
  summaryReserveFor,
  autoCompactThreshold,
  microCompactThreshold,
  autoBarFor,
  microBarFor,
  measuredOverhead,
} from "./contextWindow.js";

test("overhead is what the provider counted minus the transcript we measured", () => {
  // 120K prompt, 80K of it transcript → 40K of system prompt, tool schemas, working
  // set and relevance map that the bars used to be blind to.
  assert.equal(measuredOverhead(120_000, 80_000), 40_000);
});

test("overhead never goes negative when our estimate reads high", () => {
  // The transcript estimator is deliberately conservative, so it can exceed the real
  // count. A negative overhead would push the bars LATER — the exact failure removed.
  assert.equal(measuredOverhead(70_000, 80_000), 0);
});

test("DeepSeek anchors to its sharp window (not its 1M storage cap)", () => {
  assert.equal(sharpContextWindow("deepseek-v4-pro"), 256_000);
  assert.equal(sharpContextWindow("deepseek-v4-flash"), 192_000);
  // Both stay well under the 1M storage limit: the anchor is where multi-needle
  // retrieval stays reliable, not where the model stops accepting tokens.
  assert.ok(sharpContextWindow("deepseek-v4-pro") < 1_000_000);
});

test("Flash gets its own window rather than inheriting Pro's curve", () => {
  // No published multi-needle data exists for Flash, so it anchors lower on
  // purpose. If these ever collapse to one number, the split was lost by accident.
  assert.notEqual(sharpContextWindow("deepseek-v4-flash"), sharpContextWindow("deepseek-v4-pro"));
  assert.ok(sharpContextWindow("deepseek-v4-flash") < sharpContextWindow("deepseek-v4-pro"));
});

test("the bars scale with the window, so a longer model gets more room", () => {
  assert.ok(autoBarFor(256_000) > autoBarFor(128_000));
  assert.ok(microBarFor(256_000) > microBarFor(128_000));
  // The split is visible downstream, not just in the raw window.
  assert.ok(microCompactThreshold("deepseek-v4-pro") > microCompactThreshold("deepseek-v4-flash"));
});

test("thresholds are ordered micro < auto < window, with real headroom", () => {
  for (const win of [128_000, 192_000, 256_000, 1_000_000]) {
    const auto = autoBarFor(win);
    const micro = microBarFor(win);
    assert.ok(micro < auto, `${win}: micro < auto`);
    assert.ok(auto < win, `${win}: auto below the window`);
    assert.ok(win - auto >= 30_000, `${win}: reserves room for summary + buffer`);
  }
});

test("a tiny window still leaves a usable floor rather than going negative", () => {
  assert.equal(autoBarFor(8_000), 20_000);
});

test("an unknown model falls back to a safe default rather than throwing", () => {
  // Unknown ids resolve through the default driver and land on the CONSERVATIVE
  // side of the split, never the higher Pro window.
  assert.equal(sharpContextWindow("some-new-model"), 192_000);
  assert.ok(autoCompactThreshold("some-new-model") > 0);
  assert.ok(microCompactThreshold("some-new-model") > 0);
});

// ── The summary reserve comes from the driver ────────────────────────────────

test("the reserve is the driver's declared buffered ceiling, not a core constant", () => {
  // Anthropic caps its buffered calls at 16K and says so, so core reserves 16K —
  // NOT the 20K fallback, and not the 128K these models advertise as their output
  // maximum. If this ever reads 20_000 the manifest's answer is being ignored.
  assert.equal(summaryReserveFor("claude-sonnet-5"), 16_000);
  assert.equal(summaryReserveFor("claude-opus-5"), 16_000);
  // The declared reserve is visible in the bar, not just in the lookup.
  assert.equal(autoCompactThreshold("claude-sonnet-5"), 200_000 - 16_000 - 13_000);
});

test("a driver that declares no ceiling falls back instead of reserving nothing", () => {
  // DeepSeek sends no max_tokens at all — the provider's own default applies, so
  // there is no honest number to reserve and core keeps its conservative one.
  assert.equal(summaryReserveFor("deepseek-v4-pro"), 20_000);
  assert.equal(summaryReserveFor("some-new-model"), 20_000);
  assert.equal(autoCompactThreshold("deepseek-v4-pro"), 256_000 - 20_000 - 13_000);
});

test("every declared reserve leaves the model most of its window", () => {
  for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "claude-sonnet-5", "claude-opus-5"]) {
    const reserve = summaryReserveFor(model);
    assert.ok(reserve > 0, `${model}: reserve must be positive`);
    assert.ok(
      reserve < sharpContextWindow(model) / 2,
      `${model}: reserve ${reserve} eats half the window`,
    );
  }
});

// ── The micro bar stays sane at any window ───────────────────────────────────

test("the micro bar is capped in absolute terms on very long models", () => {
  // A flat 30% share would put a 500K model's working set at 150K of stale tool
  // output, and a 1M model's at 300K. The cap is what keeps "lean" absolute.
  assert.equal(microBarFor(500_000), 96_000);
  assert.equal(microBarFor(1_000_000), 96_000);
  assert.ok(microBarFor(500_000) < Math.round(500_000 * 0.3));
});

test("no shipped model's micro bar moved when the cap was introduced", () => {
  // The cap engages only past ~320K, above every window we ship. These are the
  // pre-change values; a diff here means the cap started biting a live model.
  assert.equal(microCompactThreshold("deepseek-v4-pro"), 76_800);
  assert.equal(microCompactThreshold("deepseek-v4-flash"), 57_600);
  assert.equal(microCompactThreshold("claude-sonnet-5"), 60_000);
});

test("micro stays below auto for every window and reserve combination", () => {
  // The guard exists for the inverted case: a large reserve on a small window
  // floors the auto bar while the micro share keeps climbing. At 120K/100K a
  // plain 30% share is 36,000 against a floored auto bar of 20,000 — inverted,
  // which would clear tool bodies at the same moment we summarize.
  for (const win of [8_000, 40_000, 66_000, 120_000, 192_000, 256_000, 500_000, 1_000_000]) {
    for (const reserve of [1_000, 16_000, 20_000, 64_000, 100_000]) {
      const auto = autoBarFor(win, reserve);
      const micro = microBarFor(win, reserve);
      assert.ok(micro > 0, `${win}/${reserve}: micro must be positive`);
      assert.ok(micro < auto, `${win}/${reserve}: micro ${micro} must stay below auto ${auto}`);
    }
  }
});

test("the approach warning sits below the bar and scales with the model", () => {
  // A fixed 20K of notice is most of a small window's usable transcript and a rounding
  // error on a large one; the point is roughly a turn or two of warning, and a turn is
  // proportional to the window.
  for (const auto of [20_000, 107_000, 171_000, 299_000]) {
    const warn = warnBarFor(auto);
    assert.ok(warn < auto, `warning must come before the bar (auto ${auto})`);
    assert.ok(warn > auto * 0.5, `but not so early it is meaningless (auto ${auto})`);
  }
  assert.ok(warnBarFor(299_000) - warnBarFor(107_000) > 0, "a bigger window gets more absolute room");
});

test("contextPressure warns only past the warn bar, and counts down room to the compaction", () => {
  const model = "claude-sonnet-5";
  const auto = autoCompactThreshold(model);
  const warn = warnBarFor(auto);

  // Comfortably under the warn bar: silent, and never surface a stale notice.
  assert.equal(contextPressure(Math.round(auto * 0.5), model).warn, false);
  assert.equal(contextPressure(warn - 1, model).warn, false);

  // At and past the warn bar: the notice shows, and percentLeft is the room to the bar.
  const atWarn = contextPressure(warn, model);
  assert.equal(atWarn.warn, true);
  assert.ok(atWarn.percentLeft > 0 && atWarn.percentLeft <= 100 - 90 + 1, `~10% left at the warn bar, got ${atWarn.percentLeft}`);

  // As the auto bar is reached, the room runs out — 0% left, which is where the pass fires.
  assert.equal(contextPressure(auto, model).percentLeft, 0);
  assert.equal(contextPressure(auto + 50_000, model).percentLeft, 0, "never negative once over the bar");
  assert.equal(contextPressure(auto, model).warn, true);
});
