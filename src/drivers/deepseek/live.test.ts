/**
 * live.test.ts — the two DeepSeek facts that only the API can settle.
 *
 * Everything else in this driver is pinned against DeepSeek's documentation. These
 * two are not, because documentation is what got the previous answer wrong: Flash was
 * given a two-rung reasoning ladder on the reasonable-sounding assumption that the
 * cheaper model had less of one, and that assumption sat in the manifest, unchallenged
 * and untestable, denying the DEFAULT model its top setting.
 *
 * So this file asks the API instead. It SKIPS without a key — a suite that needs
 * credentials to pass is a suite nobody runs — and the moment `DEEPSEEK_API_KEY` is
 * set, the same `npm test` verifies the claim for real.
 *
 * Deliberately tiny: `max_tokens: 16` on a one-word prompt. Whether a parameter is
 * ACCEPTED is decided before a single token is generated, so there is no reason to
 * pay for generation to find out. What we are reading is the status code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { deepseekProvider, sampling } from "./client.js";
import { FLASH, PRO } from "./manifest.js";
import type { ModelId, ModelRequest } from "../types.js";

const KEY = process.env.DEEPSEEK_API_KEY;
const skip = KEY ? false : "set DEEPSEEK_API_KEY to verify this against the live API";

/** The smallest real request that still carries the setting under test. */
function probe(model: ModelId, thinking: boolean, effort: "high" | "max"): ModelRequest {
  return {
    system: "Reply with the single word OK.",
    messages: [{ role: "user", content: "ping" }],
    model: { model, thinking, effort },
  };
}

/** Send one request and report what the API made of it. */
async function ask(req: ModelRequest): Promise<{ status: number; detail: string }> {
  const body = { ...buildBody(deepseekProvider, req, 16), model: req.model!.model };
  const response = await fetch(`${deepseekProvider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, detail: (await response.text()).slice(0, 400) };
}

test("Flash accepts reasoning_effort: max — the claim the manifest now rests on", { skip }, async () => {
  // THE test. If this fails, `thinkLevels` must go back to a two-rung ladder for
  // Flash and `normalize` must step `max` down again. Nothing else in the driver
  // depends on the answer, so the revert is those two places and this file's verdict.
  const { status, detail } = await ask(probe(FLASH, true, "max"));
  assert.equal(status, 200, `Flash rejected max effort — the manifest is wrong: ${detail}`);
});

test("Pro accepts reasoning_effort: max", { skip }, async () => {
  const { status, detail } = await ask(probe(PRO, true, "max"));
  assert.equal(status, 200, `Pro rejected max effort: ${detail}`);
});

test("the sampling fields we send on a non-thinking call are accepted", { skip }, async () => {
  // DeepSeek documents that thinking mode ignores temperature/top_p silently. This
  // confirms the other direction — that with thinking OFF they are not merely
  // ignored but actually valid on the wire.
  assert.deepEqual(sampling({ model: FLASH, thinking: false, effort: "high" }), { temperature: 1.0, top_p: 0.95 });
  const { status, detail } = await ask(probe(FLASH, false, "high"));
  assert.equal(status, 200, `DeepSeek rejected the documented agent sampling: ${detail}`);
});
