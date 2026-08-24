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
 * credentials to pass is a suite nobody runs — and the moment a key exists, the same
 * `npm test` verifies the claim for real.
 *
 * "A key exists" is asked the way the app asks it. Reading `process.env` alone was
 * wrong: the key normally lives in `~/.mindweave/.env`, because that is where Mindweave
 * itself writes it. So these skipped for anyone who had a key set up the ordinary way,
 * which is everyone — and the claim the manifest rests on stayed unverified while the
 * means to verify it sat on disk.
 *
 * Deliberately tiny: `max_tokens: 16` on a one-word prompt. Whether a parameter is
 * ACCEPTED is decided before a single token is generated, so there is no reason to
 * pay for generation to find out. What we are reading is the status code.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { deepseekProvider, sampling } from "./client.js";
import { FLASH, PRO } from "./manifest.js";
import type { ModelId, ModelRequest } from "../types.js";
import { loadConfig } from "../../cli/bootstrap.js";

loadConfig();
const KEY = process.env.DEEPSEEK_API_KEY;
const skip = KEY ? false : "set DEEPSEEK_API_KEY (shell or ~/.mindweave/.env) to verify this against the live API";

/** The smallest real request that still carries the setting under test. */
function probe(model: ModelId, thinking: boolean, effort: "high" | "max"): ModelRequest {
  return {
    system: "Reply with the single word OK.",
    messages: [{ role: "user", content: "ping" }],
    model: { model, thinking, effort },
  };
}

/**
 * Statuses that mean WE could not ask, not that the answer is no.
 *
 * A 402 for an empty balance says nothing whatever about whether `reasoning_effort:
 * max` is a valid parameter — but asserting a bare 200 reports it as "the manifest is
 * wrong", which would send someone to revert a claim that was never tested. An
 * unverifiable run has to read as unverified.
 */
const CANNOT_ASK: Record<number, string> = {
  401: "the key was rejected",
  402: "the account has no balance",
  403: "the key is not allowed to use this model",
  429: "rate limited",
};

/**
 * Assert the API ACCEPTED a request, or SKIP saying why it could not be asked.
 *
 * Skipped rather than failed, because a red suite is a claim about the code and this
 * would be a claim about a billing account. The reason is printed either way, so an
 * unverified claim is visible without being mistaken for a broken one — which is the
 * whole distinction this file exists to keep straight.
 */
function acceptedOrUnverifiable(t: TestContext, status: number, detail: string, claim: string): void {
  const why = CANNOT_ASK[status];
  if (why) {
    t.skip(`Could not verify "${claim}" — ${why} (HTTP ${status}). Untested, not disproved: ${detail}`);
    return;
  }
  assert.equal(status, 200, `${claim} — REJECTED by the API, so the manifest is wrong: ${detail}`);
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

test("Flash accepts reasoning_effort: max — the claim the manifest now rests on", { skip }, async (t) => {
  // THE test. If this fails, `thinkLevels` must go back to a two-rung ladder for
  // Flash and `normalize` must step `max` down again. Nothing else in the driver
  // depends on the answer, so the revert is those two places and this file's verdict.
  const { status, detail } = await ask(probe(FLASH, true, "max"));
  acceptedOrUnverifiable(t, status, detail, "Flash accepts reasoning_effort: max");
});

test("Pro accepts reasoning_effort: max", { skip }, async (t) => {
  const { status, detail } = await ask(probe(PRO, true, "max"));
  acceptedOrUnverifiable(t, status, detail, "Pro accepts reasoning_effort: max");
});

test("the sampling fields we send on a non-thinking call are accepted", { skip }, async (t) => {
  // DeepSeek documents that thinking mode ignores temperature/top_p silently. This
  // confirms the other direction — that with thinking OFF they are not merely
  // ignored but actually valid on the wire.
  assert.deepEqual(sampling({ model: FLASH, thinking: false, effort: "high" }), { temperature: 1.0, top_p: 0.95 });
  const { status, detail } = await ask(probe(FLASH, false, "high"));
  acceptedOrUnverifiable(t, status, detail, "the documented agent sampling is accepted");
});
