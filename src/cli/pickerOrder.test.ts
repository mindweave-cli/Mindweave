/**
 * pickerOrder.test.ts — the display order of the /provider, /key and /model lists.
 *
 * The rule under test: the row you are most likely to want floats to the top, then the
 * rest is alphabetical. For providers that is the default first, then the ones you hold
 * a key for, then the rest; for a provider's models it is the default first, then A→Z.
 * The order matters beyond looks — a picker's render and its selection handler both
 * index this list, so a wrong order selects the wrong row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderProviders, orderModels } from "./pickerOrder.js";

const provider = (id: string, label: string) => ({ id, label });

test("providers: default first, then keyed, then the rest — each group alphabetical", () => {
  // Registration order, deliberately not alphabetical and with the keyed ones scattered.
  const providers = [
    provider("deepseek", "DeepSeek"),
    provider("anthropic", "Anthropic"),
    provider("openai", "OpenAI"),
    provider("glm", "GLM"),
    provider("gemini", "Gemini"),
    provider("groq", "Groq"),
  ];
  const keyed = new Set(["deepseek", "glm", "gemini"]);
  const ordered = orderProviders(providers, (p) => keyed.has(p.id), "deepseek").map((p) => p.label);
  assert.deepEqual(ordered, [
    "DeepSeek", // the default, pinned first even though it is also keyed
    "Gemini", // keyed group, alphabetical
    "GLM",
    "Anthropic", // unkeyed group, alphabetical
    "Groq",
    "OpenAI",
  ]);
});

test("providers: the default is pinned even when it has no key", () => {
  const providers = [provider("z", "Zeta"), provider("d", "Deeb"), provider("a", "Acme")];
  const ordered = orderProviders(providers, () => false, "d").map((p) => p.label);
  assert.deepEqual(ordered, ["Deeb", "Acme", "Zeta"]);
});

test("providers: alphabetical is case-insensitive, so capitals do not jump the list", () => {
  const providers = [provider("a", "GLM"), provider("b", "Gemini"), provider("c", "Groq")];
  const ordered = orderProviders(providers, () => false, "none").map((p) => p.label);
  assert.deepEqual(ordered, ["Gemini", "GLM", "Groq"]);
});

test("models: the provider default stays first, the rest sort alphabetically", () => {
  // The registry lists a provider default-first; the picker keeps that pin.
  const models = [
    { id: "flash", label: "V4.1 Flash" },
    { id: "pro", label: "V4 Pro" },
    { id: "air", label: "Air" },
  ];
  const ordered = orderModels(models).map((m) => m.label);
  assert.deepEqual(ordered, ["V4.1 Flash", "Air", "V4 Pro"]);
});

test("models: a single-model provider is unchanged", () => {
  const models = [{ id: "only", label: "Only" }];
  assert.deepEqual(orderModels(models).map((m) => m.id), ["only"]);
});
