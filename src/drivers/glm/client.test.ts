/**
 * client.test.ts — GLM's binding to the shared OpenAI-compatible layer.
 *
 * The shared stream plumbing is already tested through Qwen; what is tested here is
 * what makes GLM different, and two things do:
 *
 *   - The widest `finish_reason` vocabulary of any provider in this project. Two of
 *     its extra values would otherwise be reported to the engine as a clean finish,
 *     which is the most expensive kind of silent bug: a refusal and an overflowed
 *     conversation both look like a completed answer.
 *   - `reasoning_effort` exists on exactly ONE model in the lineup, and its seven
 *     accepted values collapse onto two real levels.
 *
 * No network, no API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, toStop } from "../openaiCompat/wire.js";
import { cacheSplit, extraStop, glmProvider, reasoningFields } from "./client.js";
import { GLM_47, GLM_47_FLASHX, GLM_5, GLM_52, MODELS, normalize, takesEffort, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };
const ALL = MODELS.map((m) => m.id);
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// ── Stop reasons: the expensive silent bug ────────────────────────────────────

test("a refusal and an overflow are NOT reported as a clean finish", () => {
  // Both are outside the OpenAI vocabulary, so without a case they fall through to
  // "end" and the engine carries on as if it received a complete answer.
  assert.equal(extraStop("sensitive"), "refused");
  assert.equal(extraStop("model_context_window_exceeded"), "overflow");
  assert.equal(extraStop("network_error"), "overloaded");

  // And they survive the shared mapper rather than being overridden by it.
  assert.equal(toStop(glmProvider, "sensitive"), "refused");
  assert.equal(toStop(glmProvider, "model_context_window_exceeded"), "overflow");
  assert.equal(toStop(glmProvider, "network_error"), "overloaded");
});

test("the standard vocabulary still maps the standard way", () => {
  assert.equal(extraStop("stop"), undefined);
  assert.equal(toStop(glmProvider, "stop"), "end");
  assert.equal(toStop(glmProvider, "tool_calls"), "end");
  assert.equal(toStop(glmProvider, "length"), "truncated");
  assert.equal(toStop(glmProvider, "content_filter"), "refused");
});

test("every finish_reason this provider documents has a deliberate mapping", () => {
  // The documented set, so a value can never quietly acquire the "end" default.
  const documented = ["stop", "tool_calls", "length", "sensitive", "model_context_window_exceeded", "network_error"];
  const expected = ["end", "end", "truncated", "refused", "overflow", "overloaded"];
  assert.deepEqual(
    documented.map((r) => toStop(glmProvider, r)),
    expected,
  );
});

// ── Reasoning ─────────────────────────────────────────────────────────────────

test("thinking OFF is sent EXPLICITLY — this provider defaults to ON", () => {
  assert.deepEqual(reasoningFields(undefined), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningFields({ model: GLM_47, thinking: false, effort: "high" }), {
    thinking: { type: "disabled" },
  });
});

test("the effort dial rides along only on the model that HAS one", () => {
  // GLM-5.2 is the only model with `reasoning_effort`; sending it elsewhere is a
  // parameter the model does not know, not a tolerated extra.
  assert.deepEqual(reasoningFields({ model: GLM_52, thinking: true, effort: "max" }), {
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  for (const model of [GLM_5, GLM_47, GLM_47_FLASHX]) {
    const fields = reasoningFields({ model, thinking: true, effort: "max" });
    assert.deepEqual(fields, { thinking: { type: "enabled" } }, model);
    assert.ok(!("reasoning_effort" in fields), `${model} has no effort dial`);
  }
});

test("no effort is sent when thinking is off, even on the model that has the dial", () => {
  const fields = reasoningFields({ model: GLM_52, thinking: false, effort: "max" });
  assert.ok(!("reasoning_effort" in fields), "an effort with thinking disabled is contradictory");
});

test("a request with no model config still renders the DEFAULT model's shape", () => {
  const expected = reasoningFields({ model: glmProvider.defaultModel, thinking: false, effort: "high" });
  assert.deepEqual(reasoningFields(undefined), expected);
});

test("the model named in the body always matches the shape its fields came from", () => {
  for (const model of ALL) {
    const body = buildBody(glmProvider, { ...base, model: { model, thinking: true, effort: "high" } });
    assert.equal(body.model, model);
    assert.equal("reasoning_effort" in body, takesEffort(model), `${model}: wrong reasoning shape`);
  }
});

test("only the two rungs that DO something are offered", () => {
  // GLM-5.2 accepts seven effort values, but `low`/`medium` both map up to `high`
  // and `xhigh` maps up to `max`. Listing them would be switches wired to the same
  // place as the one above them.
  const thinkingRungs = thinkLevels(GLM_52).filter((l) => l.thinking).map((l) => l.effort);
  assert.deepEqual(thinkingRungs, ["high", "max"]);
  // And a model with no dial offers no third rung at all.
  assert.equal(thinkLevels(GLM_47).length, 2);
});

// ── Usage and ceilings ────────────────────────────────────────────────────────

test("the cache split reads the details object, and reports nothing when absent", () => {
  assert.deepEqual(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 600 } }), {
    hit: 600,
    miss: 400,
  });
  assert.equal(cacheSplit({ prompt_tokens: 1000 }), undefined);
});

test("the buffered ceiling is sent, so core's reservation is not fiction", () => {
  assert.equal(buildBody(glmProvider, base, glmProvider.bufferedMaxTokens).max_tokens, 8_000);
  assert.equal(buildBody(glmProvider, base).max_tokens, undefined);
});

// ── Model rules ───────────────────────────────────────────────────────────────

test("normalize keeps every advertised reasoning level intact", () => {
  for (const model of ALL) {
    for (const level of thinkLevels(model)) {
      const config = { model, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(normalize(config), config, `${model}: "${level.label}" was altered`);
    }
  }
});

test("normalize snaps an unlisted effort onto a rung /think actually offers", () => {
  for (const model of ALL) {
    for (const effort of EFFORTS) {
      for (const thinking of [true, false]) {
        const moved = normalize({ model, thinking, effort });
        assert.ok(
          thinkLevels(model).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
          `${model}: ${thinking}/${effort} landed on ${JSON.stringify(moved)}, which /think does not list`,
        );
      }
    }
  }
});

test("switching between any two models leaves a config the target accepts", () => {
  // Moving GLM-5.2's Maximum onto a model with no dial is the case that matters:
  // the effort has to fall back to something the target's ladder lists.
  for (const from of ALL) {
    for (const level of thinkLevels(from)) {
      for (const to of ALL) {
        const moved = normalize({ model: to, thinking: level.thinking, effort: level.effort });
        assert.deepEqual(normalize(moved), moved, `${from} "${level.label}" → ${to} is unstable`);
        assert.ok(
          thinkLevels(to).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
          `${from} "${level.label}" → ${to} landed on ${JSON.stringify(moved)}, which ${to} does not offer`,
        );
      }
    }
  }
});

test("an unknown model id falls back rather than reaching the wire", () => {
  assert.equal(normalize({ model: "glm-imaginary", thinking: true, effort: "high" }).model, GLM_52);
  for (const model of ALL) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
});
