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
import { DEFAULT_MODEL, MODELS, MUSE_SPARK_12, MUSE_SPARK_12_CONTRIBUTOR, normalize, price, thinkLevels } from "./manifest.js";
import type { ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };

test("Muse Spark has no reasoning field — nothing is sent, ever", () => {
  assert.deepEqual(reasoningFields(), {});
  const body = buildBody(metaProvider, { ...base, model: { model: MUSE_SPARK_12, thinking: true, effort: "high" } });
  assert.equal("thinking" in body, false);
  assert.equal("reasoning_effort" in body, false);
});

test("the default is Standard, never the contributor tier — sharing your data is a choice, not a fallback", () => {
  assert.equal(DEFAULT_MODEL, MUSE_SPARK_12);
  assert.equal(normalize({ model: "unknown-model", thinking: true, effort: "high" }).model, MUSE_SPARK_12);
});

test("the contributor tier is real, separate, and dramatically cheaper — the trade is genuine both ways", () => {
  const standard = price(MUSE_SPARK_12);
  const contributor = price(MUSE_SPARK_12_CONTRIBUTOR);
  assert.ok(contributor.cacheMiss < standard.cacheMiss / 5, "contributor input should be far cheaper than standard");
  assert.ok(contributor.output < standard.output / 5, "contributor output should be far cheaper than standard");
  // Both models are genuinely offered, not one hidden behind the other.
  assert.ok(MODELS.some((m) => m.id === MUSE_SPARK_12));
  assert.ok(MODELS.some((m) => m.id === MUSE_SPARK_12_CONTRIBUTOR));
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
