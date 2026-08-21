/**
 * http.test.ts — Streamable HTTP, driven by a stub fetch.
 *
 * The interesting cases are all consequences of 2026-07-28 removing things: no session
 * header to echo, no resumability, and a response stream that may carry progress
 * notifications alongside the actual result. Matching the reply by id (rather than
 * taking the last message) is the one that silently corrupts results if wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcError } from "./types.js";
import { HttpTransport, drainSseEvents, encodeHeaderValue, findResponse, httpErrorCode, parseSseEvents } from "./http.js";

/** A fetch stub that records the request and replies with whatever it is given. */
function stubFetch(reply: { body: string; contentType?: string; status?: number }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      statusText: "",
      headers: new Map([["content-type", reply.contentType ?? "application/json"]]) as unknown as Headers,
      text: async () => reply.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  // `headers.get` is all the transport uses.
  return { impl, seen };
}

const rpc = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });

test("parseSseEvents pulls data payloads out of a stream", () => {
  const body = "event: message\ndata: {\"a\":1}\n\ndata: line1\ndata: line2\n\n";
  assert.deepEqual(parseSseEvents(body), ['{"a":1}', "line1\nline2"]);
});

test("parseSseEvents survives CRLF and trailing blanks", () => {
  assert.deepEqual(parseSseEvents("data: {\"a\":1}\r\n\r\n\r\n"), ['{"a":1}']);
  assert.deepEqual(parseSseEvents(""), []);
});

test("the reply is matched by id, not by position", () => {
  // A response stream carries progress notifications and log messages too. Taking the
  // last message would hand a notification back as the tool's result.
  const messages = [
    { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
    { jsonrpc: "2.0", id: 7, result: { ok: true } },
    { jsonrpc: "2.0", method: "notifications/message", params: { text: "working" } },
  ];
  assert.deepEqual(findResponse(messages, 7), { jsonrpc: "2.0", id: 7, result: { ok: true } } as never);
  assert.equal(findResponse(messages, 9), null);
});

test("a plain JSON response resolves", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, { tools: [] }) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  assert.deepEqual(await t.request("tools/list"), { tools: [] });
  assert.equal(seen[0]!.init.method, "POST");
  await t.close();
});

test("an SSE response resolves from the stream", async () => {
  const { impl } = stubFetch({
    body: `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\ndata: ${rpc(1, { done: true })}\n\n`,
    contentType: "text/event-stream",
  });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  assert.deepEqual(await t.request("tools/call"), { done: true });
  await t.close();
});

test("the required 2026-07-28 headers are sent, and no session header is", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", headers: { authorization: "Bearer t" }, fetchImpl: impl });
  await t.request("tools/list");
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers["mcp-method"], "tools/list");
  // `tools/list` has no target, so there is nothing for `Mcp-Name` to mirror. Filling it
  // with the method would disagree with the body and earn a -32020.
  assert.ok(!("mcp-name" in headers));
  assert.match(headers.accept!, /application\/json/);
  assert.match(headers.accept!, /text\/event-stream/);
  assert.equal(headers.authorization, "Bearer t", "configured headers are passed through");
  // Sessions were removed from the transport in 2026-07-28.
  assert.ok(!Object.keys(headers).some((k) => /session/i.test(k)));
  await t.close();
});

test("mirrored headers carry the body's values, not the method", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  await t.request("tools/call", { name: "get_weather", arguments: { location: "Seattle, WA" }, _meta: meta });

  const headers = seen[0]!.init.headers as Record<string, string>;
  const body = JSON.parse(seen[0]!.init.body as string);
  assert.equal(headers["mcp-method"], "tools/call");
  assert.equal(headers["mcp-name"], "get_weather", "Mcp-Name mirrors params.name");
  assert.equal(headers["mcp-protocol-version"], "2026-07-28");
  // The rule a conforming server enforces: every mirrored header equals its body field.
  assert.equal(headers["mcp-method"], body.method);
  assert.equal(headers["mcp-name"], body.params.name);
  assert.equal(headers["mcp-protocol-version"], body.params._meta["io.modelcontextprotocol/protocolVersion"]);
  await t.close();
});

test("resources/read mirrors the uri; prompts/get mirrors the name", async () => {
  // A fresh transport each time: the stub answers to id 1, and ids do not reset.
  const nameFor = async (method: string, params: Record<string, unknown>) => {
    const { impl, seen } = stubFetch({ body: rpc(1, {}) });
    const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
    await t.request(method, params);
    await t.close();
    return (seen[0]!.init.headers as Record<string, string>)["mcp-name"];
  };
  assert.equal(await nameFor("resources/read", { uri: "file:///projects/myapp/config.json" }), "file:///projects/myapp/config.json");
  assert.equal(await nameFor("prompts/get", { name: "review" }), "review");
});

test("a version is only claimed when the body carries one", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  // The handshake dialect agrees a version in `initialize` and sends no `_meta`; a header
  // invented here could only ever contradict the body.
  await t.request("tools/call", { name: "x" });
  assert.ok(!("mcp-protocol-version" in (seen[0]!.init.headers as Record<string, string>)));
  await t.close();
});

test("header values outside the safe set travel in the base64 sentinel", () => {
  // Vectors published in the 2026-07-28 Value Encoding table, so this checks the
  // encoding against the spec rather than against itself.
  assert.equal(encodeHeaderValue("us-west1"), "us-west1");
  assert.equal(encodeHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
  assert.equal(encodeHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assert.equal(encodeHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
  // A plain value that merely looks encoded must be encoded too, or a server would
  // decode something the client never wrote and compare the wrong bytes to the body.
  assert.equal(encodeHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
});

test("an unsafe tool name reaches the header encoded", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await t.request("tools/call", { name: "поиск" });
  assert.equal((seen[0]!.init.headers as Record<string, string>)["mcp-name"], "=?base64?0L/QvtC40YHQug==?=");
  await t.close();
});

test("a JSON-RPC error rejects with its code intact", async () => {
  const { impl } = stubFetch({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await assert.rejects(() => t.request("server/discover"), (e: unknown) => e instanceof RpcError && e.code === -32601);
  await t.close();
});

test("a stream that ends without answering is an error, not a hang", async () => {
  // Resumability was removed: a broken stream loses the request and the remedy is a
  // NEW request. Waiting for a resume that cannot come would wedge the turn.
  const { impl } = stubFetch({ body: "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n", contentType: "text/event-stream" });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await assert.rejects(() => t.request("tools/call"), /ended without a result/);
  await t.close();
});

test("auth failures are distinguishable from ordinary ones", async () => {
  // The connection layer turns this into `needs-auth` rather than `failed`, so the
  // code has to survive as more than a message.
  assert.equal(httpErrorCode(401), -32001);
  assert.equal(httpErrorCode(403), -32001);
  assert.equal(httpErrorCode(404), -32601);
  assert.equal(httpErrorCode(500), -32603);

  const { impl } = stubFetch({ body: "", status: 401 });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await assert.rejects(() => t.request("tools/list"), (e: unknown) => e instanceof RpcError && e.code === -32001);
  await t.close();
});

test("requests after close are refused", async () => {
  const { impl } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await t.close();
  await assert.rejects(() => t.request("tools/list"), /closed/);
});

// ── Phase 2: subscription streams ──────────────────────────────────────────────

test("drainSseEvents yields complete events and keeps the partial tail", () => {
  // A subscription stream never finishes, so it must be consumed as it arrives.
  // `parseSseEvents` only works on a body that has stopped growing.
  const first = drainSseEvents('data: {"a":1}\n\ndata: {"b":');
  assert.deepEqual(first.events, ['{"a":1}']);
  assert.equal(first.rest, 'data: {"b":');
  // The tail completes on the next chunk.
  assert.deepEqual(drainSseEvents(first.rest + '2}\n\n').events, ['{"b":2}']);
});

test("a subscription stream delivers notifications until it ends", async () => {
  const chunks = [
    'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "",
      headers: new Map([["content-type", "text/event-stream"]]) as unknown as Headers,
      body,
    }) as unknown as Response) as unknown as typeof fetch;

  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  const seen: string[] = [];
  t.onNotification((n) => seen.push(n.method));
  // Resolves once ESTABLISHED, not when the stream ends — awaiting the end would
  // block the caller until the server goes away.
  await t.openStream!("subscriptions/listen", { types: ["toolsListChanged"] });
  for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ["notifications/tools/list_changed", "notifications/progress"]);
  await t.close();
});

test("a refused subscription is an error the caller can shrug off", async () => {
  // Every pre-2026 server refuses this. Treating it as fatal would drop most servers
  // in existence for the sake of an optimization.
  const { impl } = stubFetch({ body: "", status: 405 });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await assert.rejects(() => t.openStream!("subscriptions/listen", {}), RpcError);
  await t.close();
});

test("mirrored param headers reach the wire and survive configured headers", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({
    url: "https://x.dev/mcp",
    // A configured header deliberately colliding with a mirrored one. Configuration must
    // not win: these restate the body, and a server rejects any header that disagrees
    // with it, so an override would break every call with no visible cause.
    headers: { authorization: "Bearer t", "mcp-param-Region": "eu-west1" },
    fetchImpl: impl,
  });
  await t.request("tools/call", { name: "execute_sql", arguments: { region: "us-west1" } }, { "mcp-param-Region": "us-west1" });

  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers["mcp-param-Region"], "us-west1");
  assert.equal(headers["mcp-name"], "execute_sql");
  assert.equal(headers.authorization, "Bearer t", "unrelated configured headers still pass through");
  await t.close();
});

test("a request with nothing to mirror sends no param headers", async () => {
  const { impl, seen } = stubFetch({ body: rpc(1, {}) });
  const t = new HttpTransport({ url: "https://x.dev/mcp", fetchImpl: impl });
  await t.request("tools/call", { name: "plain" });
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase().startsWith("mcp-param-")));
  await t.close();
});
