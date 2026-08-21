/**
 * mrtr.test.ts — multi round-trip requests, 2026-07-28.
 *
 * The defect this closes was silence, not noise: `input_required` was parsed nowhere, so
 * a half-finished result went back to the model as though the tool had answered. Every
 * assertion here is therefore about a case that previously "passed" by doing the wrong
 * thing quietly.
 *
 * The pure half checks the shape; the live half drives a real `node:http` server through
 * the loop, because "the state that comes back is the state THIS round returned" is a
 * property of the sequence and a single call cannot show it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readInputRequired, resultTypeOf, MRTR_METHODS } from "./protocol.js";
import { McpManager } from "./manager.js";
import { MAX_INPUT_ROUNDS } from "./connection.js";
import type { McpServerConfig } from "./config.js";

test("a result without resultType is complete, which is the compatibility rule", () => {
  // Every pre-2026 server omits the field. Reading a missing field as "pending" would
  // turn every legacy tool call into a retry loop.
  assert.equal(resultTypeOf({ content: [] }), "complete");
  assert.equal(readInputRequired({ content: [] }), null);
  assert.equal(readInputRequired({ resultType: "complete", content: [] }), null);
});

test("an input_required result yields its state and the methods it asked for", () => {
  const pending = readInputRequired({
    resultType: "input_required",
    inputRequests: { github_login: { method: "elicitation/create", params: { message: "who?" } } },
    requestState: "AEAD-protected blob",
  });
  assert.ok(pending);
  assert.equal(pending.requestState, "AEAD-protected blob");
  assert.deepEqual(pending.inputRequests, { github_login: { method: "elicitation/create" } });
});

test("a missing requestState is absent, not empty", () => {
  // The spec makes these different instructions: echo the value back exactly, versus
  // send no requestState at all. Collapsing them into "" would invent a field.
  const pending = readInputRequired({ resultType: "input_required", inputRequests: {} });
  assert.ok(pending);
  assert.ok(!("requestState" in pending));
  assert.equal(readInputRequired({ resultType: "input_required", requestState: "s" })!.requestState, "s");
});

test("only three methods may be answered with input_required", () => {
  // Closed by the spec. A tools/list claiming to need input is a broken server, and
  // treating it as a continuation would hide that behind a retry.
  assert.deepEqual([...MRTR_METHODS], ["tools/call", "resources/read", "prompts/get"]);
});

/**
 * An MCP endpoint that answers `input_required` once per entry in `states`, returning
 * that entry as its `requestState` (or none, for an `undefined` entry), and recording
 * what the client sent back. `endless` never finishes.
 */
async function startServer(opts: { states: (string | undefined)[]; endless?: boolean; asksForInput?: boolean }) {
  const seenState: (string | undefined)[] = [];
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const msg = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "server/discover") return reply({ protocolVersions: ["2026-07-28"], capabilities: {}, serverInfo: { name: "mrtr" } });
      if (msg.method === "tools/list") return reply({ tools: [{ name: "slow", inputSchema: { type: "object" } }] });
      if (msg.method === "tools/call") {
        seenState.push(msg.params?.requestState as string | undefined);
        const round = calls++;
        if (opts.endless || round < opts.states.length) {
          const state = opts.endless ? `state-${round + 1}` : opts.states[round];
          return reply({
            resultType: "input_required",
            ...(state === undefined ? {} : { requestState: state }),
            ...(opts.asksForInput ? { inputRequests: { who: { method: "elicitation/create" } } } : {}),
          });
        }
        return reply({ content: [{ type: "text", text: `done after ${calls} calls` }] });
      }
      reply({});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    config: { type: "http", name: "mrtr", url: `http://127.0.0.1:${port}/mcp` } as McpServerConfig,
    seenState,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function callSlow(endpoint: { config: McpServerConfig }, mgr: McpManager) {
  await mgr.start([endpoint.config]);
  const tool = mgr.asTool("mcp__mrtr__slow");
  assert.ok(tool, "the server did not offer its tool");
  return tool.execute({}, {} as never);
}

test("a server that needs another round gets one, with its own state echoed back", async () => {
  const endpoint = await startServer({ states: ["state-1", "state-2"] });
  const mgr = new McpManager();
  try {
    const result = await callSlow(endpoint, mgr);
    assert.match(result.output, /done after 3 calls/);
    // Nothing on the first call, then exactly what each round returned.
    assert.deepEqual(endpoint.seenState, [undefined, "state-1", "state-2"]);
    assert.equal(result.isError, undefined);
  } finally {
    await mgr.dispose();
    await endpoint.stop();
  }
});

test("a round that returns no state clears the one before it", async () => {
  // "If the InputRequiredResult does not contain a requestState, the client MUST NOT
  // include one in the retry." The state belongs to the round that issued it, so holding
  // the last one seen is a real and natural bug — and one that only shows up when a
  // stateful round is FOLLOWED by a stateless one, never on a server that sends none at
  // all. That is the sequence below.
  const endpoint = await startServer({ states: ["state-1", undefined] });
  const mgr = new McpManager();
  try {
    await callSlow(endpoint, mgr);
    assert.deepEqual(endpoint.seenState, [undefined, "state-1", undefined]);
  } finally {
    await mgr.dispose();
    await endpoint.stop();
  }
});

test("a server that never finishes is cut off rather than looped forever", async () => {
  const endpoint = await startServer({ states: [], endless: true });
  const mgr = new McpManager();
  try {
    const result = await callSlow(endpoint, mgr);
    assert.equal(result.isError, true);
    assert.match(result.output, /still needed more input/);
    assert.equal(endpoint.seenState.length, MAX_INPUT_ROUNDS + 1, "the cap counts attempts, not retries");
  } finally {
    await mgr.dispose();
    await endpoint.stop();
  }
});

test("input we cannot supply fails the call and names what was asked for", async () => {
  // We declare no elicitation capability, so a conforming server must never ask. One
  // that does gets an honest failure — the old behaviour handed the model a result with
  // no content and no hint that anything was outstanding.
  const endpoint = await startServer({ states: ["state-1"], asksForInput: true });
  const mgr = new McpManager();
  try {
    const result = await callSlow(endpoint, mgr);
    assert.equal(result.isError, true);
    assert.match(result.output, /elicitation\/create/);
    assert.equal(endpoint.seenState.length, 1, "asking for the impossible stops the loop at once");
  } finally {
    await mgr.dispose();
    await endpoint.stop();
  }
});
