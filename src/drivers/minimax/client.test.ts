/**
 * client.test.ts — MiniMax's binding to the shared OpenAI-compatible layer.
 *
 * The shared plumbing is already pinned by Qwen's test file. What is genuinely
 * MiniMax's own: M2.7 and M2 can never be put into a non-reasoning state even
 * though they take the same `thinking: {type}` field M3 does, and the field is
 * always sent explicitly because the provider's own default is reasoning-on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { minimaxProvider, reasoningFields } from "./client.js";
import { DEFAULT_MODEL, M2, M27, M3, MODELS, contextWindow, normalize, price, thinkLevels } from "./manifest.js";
import type { ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };
const ALL = MODELS.map((m) => m.id);

test("M2.7 and M2 can never be normalized into a non-reasoning state", () => {
  for (const model of [M27, M2]) {
    assert.equal(normalize({ model, thinking: false, effort: "high" }).thinking, true, model);
    for (const level of thinkLevels(model)) {
      assert.equal(level.thinking, true, `${model}: "${level.label}" claims to be a non-reasoning rung`);
    }
  }
});

test("M3 genuinely offers both states", () => {
  assert.deepEqual(
    thinkLevels(M3).map((l) => l.thinking),
    [false, true],
  );
  assert.equal(normalize({ model: M3, thinking: false, effort: "high" }).thinking, false);
  assert.equal(normalize({ model: M3, thinking: true, effort: "high" }).thinking, true);
});

test("thinking is sent EXPLICITLY every call, in both directions", () => {
  // The provider defaults to reasoning-on when the field is absent, so an internal
  // buffered call with no ModelConfig at all must not silently inherit that.
  assert.deepEqual(reasoningFields(undefined), { thinking: { type: "adaptive" } });
  assert.deepEqual(reasoningFields({ model: M3, thinking: false, effort: "high" }), {
    thinking: { type: "disabled" },
  });
  assert.deepEqual(reasoningFields({ model: M27, thinking: true, effort: "high" }), {
    thinking: { type: "adaptive" },
  });
});

test("an unknown model id falls back to the default rather than reaching the wire", () => {
  assert.equal(normalize({ model: "minimax-nightly", thinking: false, effort: "high" }).model, DEFAULT_MODEL);
});

test("M3's window stays clear of the 512K tier its price table quotes", () => {
  assert.ok(contextWindow(M3) < 512_000);
  assert.ok(contextWindow(M3) > contextWindow(M27), "M3 should still carry a larger usable window than M2.7");
});

test("every model discounts cached input, and reports the split", () => {
  for (const choice of MODELS) {
    const p = price(choice.id);
    assert.ok(p.cacheHit < p.cacheMiss, `${choice.id} should discount cached input`);
  }
  assert.equal(typeof minimaxProvider.cacheSplit, "function");
});

test("MiniMax's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(minimaxProvider, base, minimaxProvider.bufferedMaxTokens).max_tokens, 8_000);
});

test("the base URL points at MiniMax's own platform by default", () => {
  assert.equal(minimaxProvider.baseUrl, "https://api.minimax.io/v1");
  assert.equal(minimaxProvider.apiKeyEnv, "MINIMAX_API_KEY");
});

test("no config can settle on a rung its model's /think does not list", () => {
  for (const model of ALL) {
    for (const thinking of [true, false]) {
      const moved = normalize({ model, thinking, effort: "high" });
      assert.ok(
        thinkLevels(moved.model).some((l) => l.thinking === moved.thinking),
        `${model}: thinking=${thinking} landed on ${JSON.stringify(moved)}, which is not listed`,
      );
    }
  }
});
