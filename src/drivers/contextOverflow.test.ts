/**
 * contextOverflow.test.ts — telling a too-long conversation apart from a broken request.
 *
 * Both arrive as a failed 400. Getting this wrong in one direction ends a turn that
 * could have been recovered; getting it wrong in the other retries a genuine bug once
 * before surfacing it. The bodies below are the real shapes the providers in the
 * lineup send, because a classifier tested against invented strings only proves it
 * matches the strings someone invented.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isContextOverflowError } from "./contextOverflow.js";

/** Our own transport error: raw body on `detail`, status on the object. */
const httpError = (status: number, detail: string) =>
  Object.assign(new Error(`X API error ${status}: ${detail}`), { status, detail });

/** An SDK-shaped error: the body is pre-parsed onto `error`. */
const sdkError = (status: number, body: unknown) => Object.assign(new Error("api error"), { status, error: body });

test("the real length refusals are recognised", () => {
  const cases: [string, unknown][] = [
    [
      "openai",
      httpError(400, JSON.stringify({
        error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 131204 tokens.", code: "context_length_exceeded" },
      })),
    ],
    ["anthropic", sdkError(400, { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" })],
    ["gemini", httpError(400, JSON.stringify({ error: { message: "The input token count exceeds the maximum number of tokens allowed." } }))],
    ["deepseek", httpError(400, JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens." } }))],
    ["a gateway", httpError(413, "request too large for this endpoint")],
    ["a validation-style refusal", httpError(422, JSON.stringify({ error: { message: "token count exceeds the model's context window" } }))],
  ];
  for (const [label, error] of cases) {
    assert.equal(isContextOverflowError(error), true, label);
  }
});

test("an ordinary malformed request is NOT an overflow", () => {
  // These must keep going through providerError's loud path. Retrying them by dropping
  // history would hide a defect of ours behind a shorter conversation.
  for (const detail of [
    JSON.stringify({ error: { message: "Invalid value for 'temperature': must be <= 2" } }),
    JSON.stringify({ error: { message: "tools[0].function.name: string does not match pattern" } }),
    JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }),
  ]) {
    assert.equal(isContextOverflowError(httpError(400, detail)), false, detail.slice(0, 40));
  }
});

test("account and outage failures are never overflow, whatever they say", () => {
  // A 402 mentioning a context window is still about the account; shedding history
  // cannot help, and pretending otherwise would burn a retry and lose real turns.
  assert.equal(isContextOverflowError(httpError(402, "Insufficient Balance")), false);
  assert.equal(isContextOverflowError(httpError(429, "rate limit: context length")), false);
  assert.equal(isContextOverflowError(httpError(500, "internal error")), false);
  assert.equal(isContextOverflowError(httpError(503, "maximum context")), false);
});

test("an error with no status is judged on its sentence alone", () => {
  // SDK wrappers do not always expose the status. A sentence this specific means the
  // same thing whether or not the number survived the trip.
  assert.equal(isContextOverflowError(new Error("prompt is too long: 210000 tokens > 200000 maximum")), true);
  assert.equal(isContextOverflowError(new Error("socket hang up")), false);
});

test("nothing at all is not an overflow", () => {
  for (const value of [null, undefined, "", 0, {}]) {
    assert.equal(isContextOverflowError(value), false, String(value));
  }
});
