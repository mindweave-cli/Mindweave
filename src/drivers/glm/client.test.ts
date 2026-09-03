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
import {
  acceptsImages,
  alwaysThinks,
  DEFAULT_MODEL,
  GLM_47,
  GLM_47_FLASHX,
  GLM_5,
  GLM_52,
  GLM_53,
  GLM_53_FLASH,
  MODELS,
  normalize,
  price,
  takesEffort,
  thinkLevels,
} from "./manifest.js";
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
  // Against DEFAULT_MODEL rather than a named id, so moving the default does not
  // leave this asserting yesterday's flagship.
  assert.equal(normalize({ model: "glm-imaginary", thinking: true, effort: "high" }).model, DEFAULT_MODEL);
  for (const model of ALL) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
});

// ── The 5.3 pair: reasoning that cannot be switched off ───────────────────────

test("the 5.3 models are offered, and the flagship leads", () => {
  assert.ok(ALL.includes(GLM_53), "GLM-5.3 is not in the lineup");
  assert.ok(ALL.includes(GLM_53_FLASH), "GLM-5.3 Flash is not in the lineup");
  assert.equal(MODELS[0]!.id, GLM_53, "the current flagship must be the default this provider lands on");
});

test("only GLM-5.3 Flash sees images; the text-only models degrade", () => {
  // Flash is natively multimodal (Z.ai serves image input on its own id), and the shared
  // OpenAI-compat transport already sends `image_url` parts. The flagship GLM-5.3 and the
  // older models are text-only, so core must degrade before attaching bytes they can't read.
  assert.equal(acceptsImages(GLM_53_FLASH), true, "GLM-5.3 Flash is multimodal and must accept images");
  assert.equal(acceptsImages(GLM_53), false, "plain GLM-5.3 is text-only");
  assert.equal(acceptsImages(GLM_52), false, "GLM-5.2 is text-only");
});

test("neither 5.3 model is offered a rung that turns thinking off", () => {
  // Z.ai documents `thinking.type` as accepting only `enabled`, and 5.3's
  // reasoning_effort has no off value. A "Standard — answer directly" rung would be a
  // menu entry that builds a request the provider refuses.
  for (const id of [GLM_53, GLM_53_FLASH]) {
    const off = thinkLevels(id).filter((l) => !l.thinking);
    assert.deepEqual(off, [], `${id} offers a rung with thinking off: ${JSON.stringify(off)}`);
    assert.ok(alwaysThinks(id), `${id} is not marked as always thinking`);
  }
});

test("asking a 5.3 model to stop thinking is corrected, not sent", () => {
  // A config carried over from another model must not produce an illegal request.
  for (const id of [GLM_53, GLM_53_FLASH]) {
    const n = normalize({ model: id, thinking: false, effort: "low" });
    assert.equal(n.thinking, true, `${id} was left with thinking off`);
    assert.ok(
      thinkLevels(id).some((l) => l.effort === n.effort),
      `${id} normalized to an effort its own ladder does not offer: ${n.effort}`,
    );
  }
});

test("the older models can still answer without thinking", () => {
  // The rule above is specific to 5.3, not a change to the whole provider.
  for (const id of [GLM_52, GLM_5, GLM_47, GLM_47_FLASHX]) {
    assert.ok(!alwaysThinks(id), `${id} was wrongly marked as always thinking`);
    assert.equal(normalize({ model: id, thinking: false, effort: "high" }).thinking, false);
  }
});

test("both 5.3 models offer all three documented depths", () => {
  // `reasoning_effort` takes `low`, `high` and `max` on each of them, and `max` is what
  // a request falls back to when the field is absent — not the only value accepted.
  // Flash was offered the top rung alone, so a session on it reasoned at the deepest
  // setting for every step of every turn with nothing for the user to turn down.
  for (const id of [GLM_53, GLM_53_FLASH]) {
    assert.deepEqual(thinkLevels(id).map((l) => l.effort), ["low", "high", "max"], `${id}'s ladder is wrong`);
  }
});

test("both 5.3 models take the effort dial", () => {
  assert.ok(takesEffort(GLM_53));
  assert.ok(takesEffort(GLM_53_FLASH));
});

test("every model in the lineup has a real price", () => {
  // A model offered without one silently bills at the default model's rate, which is
  // the wrong number reported confidently.
  const fallback = price(GLM_53);
  for (const id of ALL) {
    const p = price(id);
    if (id === GLM_53) continue;
    if (id === GLM_52) continue; // genuinely the same rate as the flagship
    assert.notDeepEqual(p, fallback, `${id} has no price of its own and fell back to the default`);
  }
  assert.deepEqual(price(GLM_53_FLASH), { cacheHit: 0.03, cacheMiss: 0.15, output: 0.5 });
});
