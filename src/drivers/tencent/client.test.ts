/**
 * client.test.ts — Tencent's binding to the shared OpenAI-compatible layer.
 *
 * The shared stream plumbing is already tested through Qwen; what is tested here is
 * what makes this provider different, and two things do:
 *
 *   - Thinking is ON by default at the provider's end, so the request must say
 *     `disabled` out loud. A driver that simply omits the field bills every internal
 *     call for reasoning nobody reads.
 *   - `reasoning_effort` accepts two values where the shared config carries five, so
 *     a config arriving from another provider has to be brought down to a rung this
 *     one actually serves.
 *
 * No network, no API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { reasoningFields, tencentProvider } from "./client.js";
import { DEFAULT_MODEL, HY3, HY4_PREVIEW, MODELS, normalize, price, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };
const ALL = MODELS.map((m) => m.id);
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// ── Thinking is on unless we say otherwise ───────────────────────────────────

test("thinking off is SENT, never merely omitted", () => {
  // The provider's default is enabled at effort `high`. Omitting the field means the
  // model reasons and bills for it, so every call that wants a direct answer — the
  // summarizer, the distiller — has to say so.
  assert.deepEqual(reasoningFields({ model: HY3, thinking: false, effort: "high" }), {
    thinking: { type: "disabled" },
  });
  assert.deepEqual(reasoningFields(undefined), { thinking: { type: "disabled" } });
});

test("an effort rides along only when thinking is on, and only as low or high", () => {
  assert.deepEqual(reasoningFields({ model: HY3, thinking: true, effort: "low" }), {
    thinking: { type: "enabled" },
    reasoning_effort: "low",
  });
  // Every rung above `low` resolves to `high`: those are the two the API documents,
  // and a value it has never heard of is not a soft no-op.
  for (const effort of ["medium", "high", "xhigh", "max"] as Effort[]) {
    assert.deepEqual(reasoningFields({ model: HY4_PREVIEW, thinking: true, effort }), {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  }
});

test("the reasoning fields reach the request body", () => {
  const body = buildBody(tencentProvider, { ...base, model: { model: HY3, thinking: true, effort: "low" } });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.model, HY3);
});

// ── The ladder, and what a stored config becomes ─────────────────────────────

test("the ladder offers a real off rung and the two efforts that exist", () => {
  const levels = thinkLevels(HY3);
  assert.deepEqual(
    levels.map((l) => [l.thinking, l.effort]),
    [
      [false, "high"],
      [true, "low"],
      [true, "high"],
    ],
  );
  assert.ok(!levels.some((l) => l.effort === "max"), "a rung wired to a value the API rejects");
});

test("a config from another provider is snapped onto a rung this one serves", () => {
  for (const effort of EFFORTS) {
    const n = normalize({ model: HY3, thinking: true, effort });
    assert.ok(
      thinkLevels(HY3).some((l) => l.thinking === n.thinking && l.effort === n.effort),
      `${effort} normalized to a rung the ladder does not offer: ${n.effort}`,
    );
  }
  // Ties break downward: `medium` sits between the two rungs and resolves to the
  // cheaper one, because spending more of someone's money is the worse way to be wrong.
  assert.equal(normalize({ model: HY3, thinking: true, effort: "medium" }).effort, "low");
});

test("an unknown model falls back to the default rather than being sent as it stands", () => {
  assert.equal(normalize({ model: "hy9-imaginary", thinking: false, effort: "high" }).model, DEFAULT_MODEL);
});

// ── The numbers ──────────────────────────────────────────────────────────────

test("every model in the lineup has a real price", () => {
  // A model offered without one silently bills at the default model's rate, which is
  // the wrong number reported confidently.
  const fallback = price(DEFAULT_MODEL);
  for (const id of ALL) {
    const p = price(id);
    if (id === DEFAULT_MODEL) continue;
    assert.notDeepEqual(p, fallback, `${id} has no price of its own`);
  }
  assert.deepEqual(price(HY3), { cacheHit: 0.033, cacheMiss: 0.132, output: 0.528 });
  assert.deepEqual(price(HY4_PREVIEW), { cacheHit: 0.042, cacheMiss: 0.834, output: 2.501 });
});

test("the cheaper model leads, so the default is not the expensive preview", () => {
  assert.equal(MODELS[0]!.id, DEFAULT_MODEL);
  assert.ok(
    price(DEFAULT_MODEL).cacheMiss < price(HY4_PREVIEW).cacheMiss,
    "the default costs more per input token than another model in the lineup",
  );
});

test("the endpoint and key are the international TokenHub ones", () => {
  assert.equal(tencentProvider.apiKeyEnv, "TOKENHUB_API_KEY");
  assert.match(tencentProvider.baseUrl, /^https:\/\/[^/]+\/v1$/);
});
