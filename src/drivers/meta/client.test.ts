/**
 * client.test.ts — Meta's binding to the shared OpenAI-compatible layer.
 *
 * The shared plumbing is already pinned by Qwen's test file. What is genuinely
 * Meta's own: Muse Spark sends NO reasoning field at all (there isn't one to
 * send), and the contributor tier is a real, separate, non-default model id
 * whose price gap is real precisely because the data trade behind it is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { metaProvider, reasoningFields } from "./client.js";
import {
  DEFAULT_MODEL,
  MODELS,
  MUSE_SPARK_12,
  MUSE_SPARK_12_CONTRIBUTOR,
  MUSE_SPARK_13,
  MUSE_SPARK_13_CONTRIBUTOR,
  normalize,
  price,
  thinkLevels,
} from "./manifest.js";
import type { ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };

test("Muse Spark has no reasoning field — nothing is sent, ever", () => {
  assert.deepEqual(reasoningFields(), {});
  const body = buildBody(metaProvider, { ...base, model: { model: MUSE_SPARK_12, thinking: true, effort: "high" } });
  assert.equal("thinking" in body, false);
  assert.equal("reasoning_effort" in body, false);
});

test("the default is Standard, never the contributor tier — sharing your data is a choice, not a fallback", () => {
  assert.equal(DEFAULT_MODEL, MUSE_SPARK_13);
  assert.equal(normalize({ model: "unknown-model", thinking: true, effort: "high" }).model, MUSE_SPARK_13);
});

test("the contributor tier is real, separate, and dramatically cheaper — the trade is genuine both ways", () => {
  // Asserted on BOTH generations, because the tier is a property of the provider
  // rather than of one model: a new Spark that quietly shipped without its
  // contributor id, or with a discount that was no longer a discount, would be a
  // different bargain offered under the same words.
  for (const [standardId, contributorId] of [
    [MUSE_SPARK_13, MUSE_SPARK_13_CONTRIBUTOR],
    [MUSE_SPARK_12, MUSE_SPARK_12_CONTRIBUTOR],
  ]) {
    const standard = price(standardId!);
    const contributor = price(contributorId!);
    assert.ok(contributor.cacheMiss < standard.cacheMiss / 5, `${contributorId} input should be far cheaper`);
    assert.ok(contributor.output < standard.output / 5, `${contributorId} output should be far cheaper`);
    // Both models are genuinely offered, not one hidden behind the other.
    assert.ok(MODELS.some((m) => m.id === standardId));
    assert.ok(MODELS.some((m) => m.id === contributorId));
  }
});

test("1.3 ships at 1.2's rates, so the newer model is not the dearer one", () => {
  assert.deepEqual(price(MUSE_SPARK_13), price(MUSE_SPARK_12));
  assert.deepEqual(price(MUSE_SPARK_13_CONTRIBUTOR), price(MUSE_SPARK_12_CONTRIBUTOR));
});

test("thinking never turns on — there is no rung this provider's ladder offers for it", () => {
  for (const choice of MODELS) {
    for (const level of thinkLevels(choice.id)) {
      assert.equal(level.thinking, false, choice.id);
    }
    assert.equal(normalize({ model: choice.id, thinking: true, effort: "high" }).thinking, false, choice.id);
  }
});

test("Meta's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(metaProvider, base, metaProvider.bufferedMaxTokens).max_tokens, 8_000);
});

test("the base URL points at Meta's Model API by default", () => {
  assert.equal(metaProvider.baseUrl, "https://api.meta.ai/v1");
  assert.equal(metaProvider.apiKeyEnv, "MODEL_API_KEY");
});
