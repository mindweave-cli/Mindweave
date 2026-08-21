/**
 * retryTransport.test.ts — retries where they actually happen, against a real server.
 *
 * The policy is pure and unit-tested next door. What cannot be proved there is the part
 * that matters: that a second request genuinely goes out, that it goes out only for the
 * failures that deserve it, and above all that a retry can never duplicate streamed
 * output. That last one is why the retry sits where it does — on the status line,
 * before a byte of body is read — and a test that did not drive a real response body
 * could not tell the difference.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { compatStreamTurn, compatToolTurn } from "./openaiCompat/wire.js";
import type { CompatProvider } from "./openaiCompat/wire.js";

const CHAT = { id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] };

const SSE =
  `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
  "data: [DONE]\n\n";

/** A provider whose first `failures` requests fail with `status`. */
async function startProvider(opts: { failures: number; status: number; retryAfter?: string; stream?: boolean }) {
  let seen = 0;
  const server: Server = createServer((req, res) => {
    seen++;
    if (seen <= opts.failures) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.retryAfter) headers["retry-after"] = opts.retryAfter;
      res.writeHead(opts.status, headers);
      res.end(JSON.stringify({ error: { message: "please try again" } }));
      return;
    }
    if (opts.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CHAT));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const provider: CompatProvider = {
    label: "Test",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: "MW_TEST_KEY",
    defaultModel: "test-model",
    // Empty on purpose: this fixture is about the transport, and leaving a provider's
    // reasoning default in force is exactly what an empty fragment means.
    reasoningFields: () => ({}),
  } as CompatProvider;
  return { provider, requests: () => seen, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], model: { model: "test-model" } } as never;

test("a transient failure is retried and the turn survives", async () => {
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 2, status: 503 });
  try {
    const turn = await compatToolTurn(p.provider, req);
    assert.equal(turn.content, "hello", "the turn completed despite two failures");
    assert.equal(p.requests(), 3, "two retries went out");
  } finally {
    await p.stop();
  }
});

test("a rate limit is retried rather than ending the turn", async () => {
  // The behaviour this whole module exists for: one 429 used to lose the user's work.
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 1, status: 429, retryAfter: "0" });
  try {
    assert.equal((await compatToolTurn(p.provider, req)).content, "hello");
    assert.equal(p.requests(), 2);
  } finally {
    await p.stop();
  }
});

test("a malformed request is NOT retried", async () => {
  // Retrying our own bug three times only makes it slower to find, and providerError
  // is waiting to render it properly.
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 99, status: 400 });
  try {
    await assert.rejects(() => compatToolTurn(p.provider, req));
    assert.equal(p.requests(), 1, "exactly one attempt");
  } finally {
    await p.stop();
  }
});

test("an account refusal is surfaced once, not hammered", async () => {
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 99, status: 402 });
  try {
    await assert.rejects(() => compatToolTurn(p.provider, req));
    assert.equal(p.requests(), 1);
  } finally {
    await p.stop();
  }
});

test("retries stop at the cap and surface the last failure", async () => {
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 99, status: 503 });
  try {
    await assert.rejects(() => compatToolTurn(p.provider, req), /503/);
    assert.ok(p.requests() > 1 && p.requests() <= 6, `bounded attempts, got ${p.requests()}`);
  } finally {
    await p.stop();
  }
});

test("a retried STREAM emits its content exactly once", async () => {
  // The reason the retry sits on the status line rather than around the stream. If a
  // retry could re-run a partially-consumed body, the reply would be doubled in both
  // the transcript and on screen, which is far worse than the error it was avoiding.
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 2, status: 503, stream: true });
  try {
    let streamed = "";
    const result = await compatStreamTurn(p.provider, req, (e) => {
      if (e.type === "text") streamed += e.delta;
    });
    assert.equal(p.requests(), 3, "it really did retry");
    assert.equal(streamed, "hello", "and emitted the reply once, not once per attempt");
    assert.equal(result.content, "hello");
  } finally {
    await p.stop();
  }
});

// Note on where cancellation is pinned: the `isAbortLike` throw inside `send` is
// defence, not the load-bearing guard — `isRetryable` refuses an abort on its own, so
// removing that throw changes nothing observable here. The guard that actually holds is
// asserted in retryPolicy.test.ts, and removing IT fails both files.
test("a cancelled request stops at once instead of serving out its backoff", async () => {
  process.env.MW_TEST_KEY = "k";
  const p = await startProvider({ failures: 99, status: 503 });
  const controller = new AbortController();
  try {
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => compatToolTurn(p.provider, req, controller.signal));
    assert.ok(Date.now() - started < 3_000, "an abort must not wait out the remaining backoff");
  } finally {
    await p.stop();
  }
});

test("a stream that dies mid-reply keeps what the user already saw", async () => {
  // Before this, the deltas reached the screen and the throw then unwound the turn
  // before anything was recorded: text visible that the transcript had never heard of.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an ans" } }] })}\n\n`);
    // Destroying the socket is what a dropped connection actually looks like; ending
    // the response cleanly would be a well-formed short stream, which is a different case.
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const provider = {
    label: "Test",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: "MW_TEST_KEY",
    defaultModel: "test-model",
    reasoningFields: () => ({}),
  } as CompatProvider;

  try {
    process.env.MW_TEST_KEY = "k";
    let streamed = "";
    const result = await compatStreamTurn(provider, req, (e) => {
      if (e.type === "text") streamed += e.delta;
    });
    assert.equal(streamed, "half an ans", "the user saw this");
    assert.equal(result.content, "half an ans", "and the turn carries it back to be recorded");
    // Not "end": the engine has to know the reply is incomplete, or it carries on with
    // half an answer as though the model had finished.
    assert.equal(result.stop, "overloaded");
    // A call whose arguments stopped mid-JSON is not a call the model made.
    assert.deepEqual(result.toolCalls, [], "no half-built tool call is handed on");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a stream that dies before ANY reply still surfaces the error", async () => {
  // Nothing to preserve, so the error is the only useful thing to report. Returning an
  // empty successful turn would look like a model that chose to say nothing.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const provider = {
    label: "Test",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: "MW_TEST_KEY",
    defaultModel: "test-model",
    reasoningFields: () => ({}),
  } as CompatProvider;
  try {
    process.env.MW_TEST_KEY = "k";
    await assert.rejects(() => compatStreamTurn(provider, req));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
