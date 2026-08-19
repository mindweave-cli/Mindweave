/**
 * client.test.ts — Gemini's binding to the shared OpenAI-compatible layer.
 *
 * The shared plumbing (stream framing, tool-call fragments, the request shape) is
 * already pinned by Qwen's test file and runs identically here — Gemini adds
 * nothing new to it. What is genuinely Gemini's own and worth a red-checked test:
 * every model in this lineup ALWAYS reasons, `reasoning_effort` is a bare
 * pass-through (Google's own docs say it maps their `thinking_level` internally),
 * and the ladder tops out at `high` — `xhigh`/`max` are not in Gemini's vocabulary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { cacheSplit, geminiProvider, reasoningFields } from "./client.js";
import { DEFAULT_MODEL, FLASH_37, FLASH_LITE_35, FLASH_36, FLASH_35, FLASH_LITE_31, MODELS, hasListedPrice, PRO_31, contextWindow, normalize, price, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ALL = MODELS.map((m) => m.id);

test("every model in the lineup always reasons — there is no off state to normalize into", () => {
  for (const model of ALL) {
    assert.equal(normalize({ model, thinking: false, effort: "low" }).thinking, true, model);
    for (const level of thinkLevels(model)) {
      assert.equal(level.thinking, true, `${model}: "${level.label}" claims to be a non-reasoning rung`);
    }
  }
});

test("reasoning_effort is a bare pass-through of the config's own rung", () => {
  assert.deepEqual(reasoningFields({ model: DEFAULT_MODEL, thinking: true, effort: "medium" }), {
    reasoning_effort: "medium",
  });
  // No config at all still sends a value — this lineup has no "say nothing" branch.
  assert.deepEqual(reasoningFields(undefined), { reasoning_effort: "low" });
});

test("no config can settle on a rung the ladder does not list, and xhigh/max never reach the wire", () => {
  for (const model of ALL) {
    for (const effort of EFFORTS) {
      const moved = normalize({ model, thinking: true, effort });
      assert.ok(
        thinkLevels(moved.model).some((l) => l.effort === moved.effort),
        `${model}: ${effort} landed on ${JSON.stringify(moved)}, which is not listed`,
      );
    }
    // xhigh/max are not in this provider's own vocabulary at all (only low/medium/high
    // are), so they fall back to the cheapest rung rather than the nearest one — the
    // same rule xAI's manifest uses for the same reason: silently spending more of the
    // user's money is the worse way to be wrong than under-spending it.
    assert.equal(normalize({ model, thinking: true, effort: "xhigh" }).effort, "low", model);
    assert.equal(normalize({ model, thinking: true, effort: "max" }).effort, "low", model);
  }
});

test("an unknown model id falls back to the default rather than reaching the wire", () => {
  assert.equal(normalize({ model: "gemini-1.0-nightly", thinking: false, effort: "low" }).model, DEFAULT_MODEL);
});

test("Gemini 3.1 Pro's window stays under the 200K tier its price table quotes", () => {
  // Crossing 200K doubles the whole request's rate on this model, the same shape
  // as xAI's Grok 4.3. Same reasoning, same number, kept well clear of the cliff.
  assert.equal(contextWindow(PRO_31), 128_000);
  assert.ok(contextWindow(FLASH_37) > contextWindow(PRO_31));
  assert.ok(contextWindow(FLASH_LITE_35) > contextWindow(PRO_31));
});

test("every model discounts cached input, and reports the split", () => {
  for (const choice of MODELS) {
    const p = price(choice.id);
    assert.ok(p.cacheHit < p.cacheMiss, `${choice.id} should discount cached input`);
  }
  assert.equal(typeof geminiProvider.cacheSplit, "function");
});

test("the cache split reads the standard OpenAI-compatible shape", () => {
  assert.deepEqual(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 750 } }), {
    hit: 750,
    miss: 250,
  });
  assert.equal(cacheSplit({ prompt_tokens: 1000 }), undefined);
});

test("Gemini's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(geminiProvider, base, geminiProvider.bufferedMaxTokens).max_tokens, 8_000);
});

test("the base URL points at Google's OpenAI-compatible endpoint by default", () => {
  assert.equal(geminiProvider.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(geminiProvider.apiKeyEnv, "GEMINI_API_KEY");
});

test("every added model is priced from the published table, never the fallback", () => {
  // `price()` falls back to the default model's rate for an unknown id, so a model
  // added to MODELS but forgotten in PRICES is silently costed as something else —
  // wrong, and invisible, in the figure the status line now shows as money.
  // Asked of the TABLE, not of the returned values: two models can legitimately share
  // a rate (3.7 and 3.6 Flash both carry the same promotional price), so equal values
  // prove nothing either way. Only presence does.
  for (const choice of MODELS) {
    assert.ok(hasListedPrice(choice.id), `${choice.id} has no entry in PRICES and is costed as the default`);
  }
  assert.equal(hasListedPrice("definitely-not-a-real-model"), false);
});

test("3.5 Flash really is dearer than the newer Flash models", () => {
  // Counter-intuitive and deliberate: 3.7 and 3.6 carry a promotional rate that 3.5
  // does not. Pinned so a future tidy-up does not "correct" it into looking ordered.
  assert.ok(price(FLASH_35).cacheMiss > price(FLASH_37).cacheMiss);
  assert.ok(price(FLASH_35).cacheMiss > price(FLASH_36).cacheMiss);
});

test("the cheapest model is the Lite one, on every rate", () => {
  const lite = price(FLASH_LITE_31);
  for (const choice of MODELS) {
    if (choice.id === FLASH_LITE_31) continue;
    assert.ok(lite.cacheMiss <= price(choice.id).cacheMiss, `${choice.id} undercuts 3.1 Flash-Lite on input`);
  }
});
