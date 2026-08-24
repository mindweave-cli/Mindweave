/**
 * docsCurrent.test.ts — the two files that tell a new user which providers exist.
 *
 * Both had gone three weeks and six providers stale: `.env.example` listed ONE key of
 * thirteen, and PROVIDERS.md still said "more providers are on the way" under a table
 * with two rows. Nothing was wrong with either file when it was written; they simply
 * had no reason to change when a provider was added.
 *
 * So the registry is the source of truth and these assert against it. A new driver now
 * fails this until it appears where a user would look for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allProviders } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

test(".env.example names every provider's key variable", () => {
  const text = read("../../.env.example");
  const missing = allProviders().filter((p) => !text.includes(p.apiKeyEnv));
  assert.deepEqual(
    missing.map((p) => `${p.label} (${p.apiKeyEnv})`),
    [],
    "a provider ships that the first file a new user opens does not mention",
  );
});

test("PROVIDERS.md names every provider and its key", () => {
  const text = read("PROVIDERS.md");
  for (const p of allProviders()) {
    assert.ok(text.includes(p.apiKeyEnv), `${p.label}'s key variable is missing`);
    assert.ok(text.includes(p.label), `${p.label} is not listed`);
  }
});

test("PROVIDERS.md states the real provider and model counts", () => {
  // The specific way it went wrong last time: prose that was true when written and
  // silently became a lie. A count is checkable, so it is checked.
  const text = read("PROVIDERS.md");
  const providers = allProviders();
  const models = providers.reduce((n, p) => n + (p.models ?? []).length, 0);
  // Digits, not words, precisely so this can be checked. "Thirteen" reads better and
  // cannot be verified, which is how the old file came to promise providers that had
  // already shipped.
  const claim = text.match(/(\d+) providers, (\d+) models/);
  assert.ok(claim, "PROVIDERS.md no longer states the counts in a checkable form");
  assert.equal(Number(claim![1]), providers.length, "the stated provider count is wrong");
  assert.equal(Number(claim![2]), models, "the stated model count is wrong");
});
