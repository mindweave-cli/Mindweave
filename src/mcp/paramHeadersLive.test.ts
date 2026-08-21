/**
 * paramHeadersLive.test.ts — `x-mcp-header` end to end, against a real HTTP server.
 *
 * The pure halves are covered in `paramHeaders.test.ts` and the transport's own tests.
 * What neither can prove is the seam between them: that the connection finds the calling
 * tool's validated annotations and hands them down. That is three lines, it is invisible
 * when wrong (the header is simply absent, and only a conforming server complains), and
 * a mock of either side would assume exactly the thing under test. So this drives a real
 * `node:http` MCP endpoint and reads the headers it actually received.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { McpManager } from "./manager.js";
import type { McpServerConfig } from "./config.js";

const ANNOTATED_TOOL = {
  name: "execute_sql",
  description: "Execute SQL",
  inputSchema: {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
    },
    required: ["region", "query"],
  },
};

/** A tool whose annotation violates the spec: `number` has no single header form. */
const MALFORMED_TOOL = {
  name: "broken",
  inputSchema: { type: "object", properties: { ratio: { type: "number", "x-mcp-header": "Ratio" } } },
};

/** A Streamable HTTP MCP endpoint that records every request's headers. */
async function startServer(): Promise<{ url: string; seen: Record<string, string>[]; stop: () => Promise<void> }> {
  const seen: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ ...(req.headers as Record<string, string>) });
      const msg = JSON.parse(body) as { id: number; method: string };
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "server/discover") return reply({ protocolVersions: ["2026-07-28"], capabilities: {}, serverInfo: { name: "sqlgw" } });
      if (msg.method === "tools/list") return reply({ tools: [ANNOTATED_TOOL, MALFORMED_TOOL] });
      if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: "ok" }] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("an annotated argument is mirrored into Mcp-Param on the real call", async () => {
  const endpoint = await startServer();
  const mgr = new McpManager();
  try {
    const config: McpServerConfig = { type: "http", name: "sqlgw", url: endpoint.url };
    await mgr.start([config]);

    const status = mgr.statuses().find((s) => s.name === "sqlgw");
    assert.equal(status?.state, "connected", `server did not connect${status?.error ? ` — ${status.error}` : ""}`);

    // The malformed tool is gone; the good one survives. One bad definition must not
    // cost the server its other tools.
    const names = mgr.toolSchemas().map((s) => s.function.name);
    assert.deepEqual(names, ["mcp__sqlgw__execute_sql"]);

    const tool = mgr.asTool("mcp__sqlgw__execute_sql");
    assert.ok(tool);
    await tool.execute({ region: "us-west1", query: "SELECT 1" }, {} as never);

    const call = endpoint.seen.find((h) => h["mcp-method"] === "tools/call");
    assert.ok(call, "the server never saw a tools/call");
    // The whole point: the header is present, and it carries the ARGUMENT, not the method
    // or the tool name. Without it a conforming server must reject the call with -32020.
    assert.equal(call["mcp-param-region"], "us-west1");
    assert.equal(call["mcp-name"], "execute_sql");
    assert.equal(call["mcp-protocol-version"], "2026-07-28");

    // And the drop was reported rather than leaving a tool silently non-existent.
    const notices = mgr.takeNotices().join("\n");
    assert.match(notices, /broken/);
  } finally {
    await mgr.dispose();
    await endpoint.stop();
  }
});
