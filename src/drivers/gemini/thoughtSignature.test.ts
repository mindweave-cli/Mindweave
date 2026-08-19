/**
 * thoughtSignature.test.ts — Gemini's tool calls must survive a round trip.
 *
 * The failure, seen live: the first tool call works, and the NEXT request fails with
 * 400 "Function call is missing a thought_signature in functionCall parts". Gemini 3
 * attaches an encrypted `thought_signature` to every function call and requires it back;
 * an OpenAI-compatible client that drops unknown fields therefore gets exactly one tool
 * call per conversation and then cannot continue. Tool use is broken outright, not
 * degraded — which is why core gained an opaque `meta` it carries without reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, consumeStream, toWireMessages } from "../openaiCompat/wire.js";
import { geminiProvider } from "./client.js";
import type { ChatMessage, ModelRequest } from "../types.js";

const SIG = { google: { thought_signature: "EncRypTedBlOb==" } };

const withCall: ChatMessage[] = [
  { role: "user", content: "list the files" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "list_dir", arguments: "{}" },
        meta: { extra_content: SIG },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "a.ts\nb.ts" },
];

test("a stored signature is put back on the wire as extra_content", () => {
  const [, assistant] = toWireMessages(withCall) as Record<string, unknown>[];
  const calls = assistant!.tool_calls as Record<string, unknown>[];
  assert.deepEqual(calls[0]!.extra_content, SIG, "the signature must be echoed verbatim");
  assert.equal(calls[0]!.meta, undefined, "`meta` is our internal name and must not reach the wire");
});

test("a call with no signature sends no extra_content key at all", () => {
  // An empty or null key is not the same as an absent one, and providers that never
  // send a signature must see exactly the request they saw before this existed.
  const plain: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }],
    },
  ];
  const calls = (toWireMessages(plain)[0] as Record<string, unknown>).tool_calls as Record<string, unknown>[];
  assert.ok(!("extra_content" in calls[0]!), "no signature means no key");
});

test("the signature reaches the actual request body Gemini receives", () => {
  // End to end through the real provider, because the round trip is only worth
  // anything if it survives every layer between the transcript and the socket.
  const req: ModelRequest = { system: "S", messages: withCall, model: undefined };
  const body = buildBody(geminiProvider, req, 1024);
  const msgs = body.messages as Record<string, unknown>[];
  const assistant = msgs.find((m) => m.role === "assistant")!;
  const calls = assistant.tool_calls as Record<string, unknown>[];
  assert.deepEqual(calls[0]!.extra_content, SIG);
});

test("messages without tool calls carry no tool_calls key", () => {
  const msgs = toWireMessages([{ role: "user", content: "hi" }]) as Record<string, unknown>[];
  assert.ok(!("tool_calls" in msgs[0]!), "an empty tool_calls array confuses strict providers");
});

// ── The other half: it has to be CAPTURED before it can be echoed ─────────────
// Echoing a signature we never stored is worth nothing, and a capture that quietly
// stops working looks exactly like a provider that stopped sending one.

/** A response body streaming the given SSE frames. */
function sse(frames: string[]): Pick<Response, "body"> {
  const encoder = new TextEncoder();
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const f of frames) yield encoder.encode(f);
      },
    },
  } as unknown as Pick<Response, "body">;
}

const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

test("a streamed tool call keeps the signature that arrived with it", async () => {
  const result = await consumeStream(
    geminiProvider,
    sse([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "list_dir" }, extra_content: SIG },
              ],
            },
          },
        ],
      }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }),
    ]),
    () => {},
  );
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0]!.meta, { extra_content: SIG }, "the signature must survive assembly");
});

test("the signature is kept when it arrives on a LATER fragment", async () => {
  // Tool calls are fragmented and the provider chooses which fragment carries it.
  // Reading only the first would drop it whenever it comes with the arguments.
  const result = await consumeStream(
    geminiProvider,
    sse([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x" } }] } }] }),
      frame({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" }, extra_content: SIG }] } }],
      }),
    ]),
    () => {},
  );
  assert.deepEqual(result.toolCalls[0]!.meta, { extra_content: SIG });
});

test("a tool call with no signature carries no meta at all", async () => {
  const result = await consumeStream(
    geminiProvider,
    sse([
      frame({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: "{}" } }] } }],
      }),
    ]),
    () => {},
  );
  assert.equal(result.toolCalls[0]!.meta, undefined);
});
