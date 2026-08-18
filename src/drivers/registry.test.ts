/**
 * registry.test.ts — the driver seam.
 *
 * These tests are about the BOUNDARY, not about any one provider: that a model id
 * routes to exactly one provider, that core's model/pricing/compaction helpers all
 * read their numbers from that provider rather than a table of their own, that an
 * unknown id degrades to something usable instead of throwing, and that every
 * provider's wire code can actually be loaded on demand.
 *
 * They are what the NEXT provider has to keep passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activeDriver,
  allModels,
  ensureDriver,
  manifestForModel,
  normalizeConfig,
  sanitizeStreamText,
} from "./registry.js";
import type { Driver, DriverManifest, ModelChoice, ThinkLevel } from "./types.js";
import { priceFor } from "../dynamo/pricing.js";
import { sharpContextWindow } from "../dynamo/contextWindow.js";
import { models, thinkLevels, withModel } from "../dynamo/model.js";

/** Metadata every manifest must supply, without loading any wire code. */
const MANIFEST_KEYS: (keyof DriverManifest)[] = [
  "id",
  "models",
  "thinkLevels",
  "price",
  "contextWindow",
  "normalize",
];

/** Behavior every driver must supply once loaded. */
const DRIVER_KEYS: (keyof Driver)[] = ["toolTurn", "streamTurn"];

test("every manifest implements the whole metadata contract", () => {
  for (const choice of allModels()) {
    const manifest = manifestForModel(choice.id);
    for (const key of MANIFEST_KEYS) {
      assert.ok(manifest[key] !== undefined, `${manifest.id} is missing ${String(key)}`);
    }
    assert.ok(manifest.models.length > 0, `${manifest.id} offers no models`);
  }
});

test("each offered model routes to the provider that declares it", () => {
  for (const choice of allModels()) {
    const manifest = manifestForModel(choice.id);
    assert.ok(
      manifest.models.some((m: ModelChoice) => m.id === choice.id),
      `${choice.id} routed to ${manifest.id}, which does not declare it`,
    );
  }
});

test("model ids are unique across providers, so routing is unambiguous", () => {
  const ids = allModels().map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate model id among ${ids.join(", ")}`);
});

test("more than one provider is installed (the seam is actually exercised)", () => {
  const providers = new Set(allModels().map((m) => manifestForModel(m.id).id));
  assert.ok(providers.size >= 2, `expected 2+ providers, got: ${[...providers].join(", ")}`);
});

test("every provider's driver loads on demand and implements the behavior contract", async () => {
  for (const choice of allModels()) {
    const driver = await ensureDriver(choice.id);
    assert.equal(driver.id, manifestForModel(choice.id).id);
    for (const key of DRIVER_KEYS) {
      assert.equal(typeof driver[key], "function", `${driver.id} is missing ${String(key)}`);
    }
    // The loaded driver must still expose its own metadata unchanged.
    assert.deepEqual(driver.models, manifestForModel(choice.id).models);
    assert.equal(activeDriver().id, driver.id);
  }
});

test("an unknown model id falls back instead of throwing", () => {
  const manifest = manifestForModel("not-a-real-model");
  assert.ok(manifest.id.length > 0);
  assert.ok(manifest.contextWindow("not-a-real-model") > 0);
  assert.ok(manifest.price("not-a-real-model").output > 0);
});

test("core reads its numbers from the provider, not a private table", () => {
  for (const choice of allModels()) {
    const manifest = manifestForModel(choice.id);
    assert.equal(sharpContextWindow(choice.id), manifest.contextWindow(choice.id));
    assert.deepEqual(priceFor(choice.id), manifest.price(choice.id));
    assert.deepEqual(thinkLevels(choice.id), manifest.thinkLevels(choice.id));
  }
});

test("the /model picker lists exactly what the providers declare", () => {
  assert.deepEqual(
    models().map((m) => m.id),
    allModels().map((m) => m.id),
  );
});

test("switching model normalizes onto a reasoning level that model offers", () => {
  // Start from a config no provider can serve verbatim: an effort rung DeepSeek
  // doesn't have, on a model that isn't real.
  for (const choice of allModels()) {
    const next = withModel({ model: "whatever-was-before", thinking: true, effort: "max" }, choice.id);
    assert.equal(next.model, choice.id);
    const offered: ThinkLevel[] = manifestForModel(choice.id).thinkLevels(choice.id);
    assert.ok(
      offered.some((l) => l.thinking === next.thinking && (!l.thinking || l.effort === next.effort)),
      `${choice.id}: normalized to an effort (${next.effort}) it does not offer`,
    );
  }
});

test("every offered reasoning level survives normalization unchanged", () => {
  // A level a provider advertises must be one it will actually accept — otherwise
  // picking it in /think would silently give you a different one.
  for (const choice of allModels()) {
    for (const level of manifestForModel(choice.id).thinkLevels(choice.id)) {
      const config = { model: choice.id, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(
        normalizeConfig(config),
        config,
        `${choice.id}: offered level "${level.label}" is changed by normalize`,
      );
    }
  }
});

test("normalizeConfig coerces an unknown model onto a servable one", () => {
  const config = normalizeConfig({ model: "not-a-real-model", thinking: false, effort: "high" });
  assert.ok(
    allModels().some((m) => m.id === config.model),
    "an unknown saved model should be coerced onto a model some provider serves",
  );
});

test("sanitizeStreamText is a safe pass-through for ordinary prose", () => {
  const prose = "Here is the fix:\n\n```ts\nconst a = 1;\n```";
  assert.ok(sanitizeStreamText(prose).includes("const a = 1;"));
});

test("every provider declares the key metadata setup needs", () => {
  for (const choice of allModels()) {
    const m = manifestForModel(choice.id);
    assert.ok(m.label.length > 0, `${m.id} has no display label`);
    assert.match(m.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/, `${m.id} apiKeyEnv is not an env var name`);
    assert.match(m.keysUrl, /^https:\/\//, `${m.id} keysUrl is not an https URL`);
  }
});

test("the DeepSeek driver does not statically import another provider's SDK", async () => {
  // DeepSeek serves its native search over an Anthropic-protocol endpoint, so its
  // driver reaches for that SDK — but only inside the search call, behind a dynamic
  // import. A static one at the top of the file would load the SDK for every
  // DeepSeek session, undoing the lazy split that is the whole reason drivers load
  // on demand. That regression would be invisible: everything still works, it is
  // just slower for people who never search.
  const src = await readFile(new URL("./deepseek/client.ts", import.meta.url), "utf8");
  const staticImport = /^\s*import\s[^\n]*["']@anthropic-ai\/sdk["']/m.exec(src);
  assert.equal(staticImport, null, "the SDK must only be reached through a dynamic import");
  assert.match(src, /await import\(\s*["']@anthropic-ai\/sdk["']\s*\)/, "expected the dynamic import");
});

test("providers use distinct API key variables", () => {
  const vars = [...new Set(allModels().map((m) => manifestForModel(m.id).id))].map(
    (id) => allModels().map((m) => manifestForModel(m.id)).find((m) => m.id === id)!.apiKeyEnv,
  );
  assert.equal(new Set(vars).size, vars.length, `two providers share a key variable: ${vars.join(", ")}`);
});
