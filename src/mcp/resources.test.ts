/**
 * resources.test.ts — the data half of MCP.
 *
 * Two things here are easy to get wrong and expensive when you do. `resources/read`
 * returns a DIFFERENT shape from `tools/call` (`contents` with bare text/blob entries,
 * not typed `content` blocks), so reusing the tool parser yields silence rather than an
 * error. And a resource is content chosen by a third party, so it has to go through the
 * same size ceiling a tool result does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RESOURCES_LISTED,
  hasResources,
  parseResourceList,
  parseResourceRead,
  parseTemplateList,
  renderResourceList,
} from "./resources.js";
import { resultsDir } from "./resultStore.js";
import { McpManager } from "./manager.js";
import { mcpResourceTool } from "../tools/mcpResources.js";
import type { ToolContext } from "../tools/types.js";
import type { McpServerConfig } from "./config.js";

test("a resource without a URI is not a resource", () => {
  const parsed = parseResourceList("srv", {
    resources: [
      { uri: "file:///a.md", name: "A", description: "first", mimeType: "text/markdown" },
      { name: "no uri" },
      { uri: "file:///a.md", name: "duplicate" },
      { uri: "file:///b.md" },
    ],
  });
  assert.deepEqual(parsed.map((r) => r.uri), ["file:///a.md", "file:///b.md"]);
  assert.equal(parsed[0]!.name, "A");
  assert.equal(parsed[1]!.name, "file:///b.md", "a nameless resource falls back to its URI");
});

test("templates keep their placeholders", () => {
  const parsed = parseTemplateList("srv", {
    resourceTemplates: [{ uriTemplate: "logs://{date}", name: "Daily log" }, { name: "no template" }],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.uriTemplate, "logs://{date}");
});

test("resources/read is parsed from `contents`, not `content`", () => {
  // The shape trap. A parser written against tools/call returns nothing here and the
  // resource silently reads as empty.
  const blocks = parseResourceRead({
    contents: [
      { uri: "file:///a.md", mimeType: "text/markdown", text: "# hello" },
      { uri: "file:///b.png", mimeType: "image/png", blob: "aGk=" },
      { uri: "file:///c" },
    ],
  });
  assert.deepEqual(blocks.map((b) => b.kind), ["text", "binary"]);
  assert.equal((blocks[0] as { text: string }).text, "# hello");
});

test("a listing tells the model what to pass back, and marks templates as templates", () => {
  const rendered = renderResourceList(
    parseResourceList("db", { resources: [{ uri: "postgres://main/schema", name: "Schema", mimeType: "application/json" }] }),
    parseTemplateList("db", { resourceTemplates: [{ uriTemplate: "postgres://main/table/{name}" }] }),
  );
  assert.match(rendered, /\[db\] postgres:\/\/main\/schema/);
  assert.match(rendered, /read one with read_mcp_resource/);
  assert.match(rendered, /Fill in the \{placeholders\}|fill in the \{placeholders\}/i);
  assert.match(rendered, /postgres:\/\/main\/table\/\{name\}/);
});

test("a flood of templates is capped, exactly as a flood of resources is", () => {
  // The resources branch capped at 200; the templates branch iterated all of them. The
  // length is chosen by a third party, and an unbounded external payload is a failure
  // this project has already had once.
  const templates = Array.from({ length: MAX_RESOURCES_LISTED + 12 }, (_, i) => ({
    server: "db", uriTemplate: `logs://{date}/${i}`, name: `t${i}`, description: "", mimeType: "",
  }));
  const out = renderResourceList([], templates);
  assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, MAX_RESOURCES_LISTED);
  assert.match(out, /… and 12 more/, "a silent cut misrepresents what the server offers");
});

test("a server without a resources capability is not asked", () => {
  assert.equal(hasResources({}), false);
  assert.equal(hasResources({ resources: { listChanged: true } }), true);
});

/** A server with a small resource, a huge one, and a template. */
const RESOURCE_SERVER = [
  'let buf = "";',
  'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => {',
  "  buf += c;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.id === undefined) continue;",
  '    if (msg.method === "server/discover") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } } }); continue; }',
  '    if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }); continue; }',
  '    if (msg.method === "resources/list") { send({ jsonrpc: "2.0", id: msg.id, result: { resources: [{ uri: "db://schema", name: "Schema", mimeType: "text/plain" }, { uri: "db://dump", name: "Everything" }] } }); continue; }',
  '    if (msg.method === "resources/templates/list") { send({ jsonrpc: "2.0", id: msg.id, result: { resourceTemplates: [{ uriTemplate: "db://table/{name}" }] } }); continue; }',
  '    if (msg.method === "resources/read") {',
  '      if (msg.params.uri === "db://dump") { send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri: "db://dump", mimeType: "text/plain", text: "DUMP HEAD\\n" + "q".repeat(150000) }] } }); continue; }',
  '      if (msg.params.uri === "db://schema") { send({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri: "db://schema", mimeType: "text/plain", text: "CREATE TABLE users (id int);" }] } }); continue; }',
  '      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Resource not found" } }); continue;',
  "    }",
  '    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });',
  "  }",
  "});",
].join("\n");

const cfg: McpServerConfig = { type: "stdio", name: "db", command: process.execPath, args: ["-e", RESOURCE_SERVER] };

async function pool(root?: string): Promise<McpManager> {
  const mgr = new McpManager();
  if (root) mgr.setProjectRoot(root);
  await mgr.start([cfg]);
  return mgr;
}

test("both resource tools accept the server name the model was actually shown", async () => {
  // A server configured as `db.` is shown to the model as `db`, because that is what
  // survives being embedded in a tool name. list_mcp_resources hand-rolled its own
  // normalization (no run-collapsing, no edge-trimming) while read_mcp_resource used the
  // shared one — so the listing rejected the exact name the read accepted.
  const mgr = new McpManager();
  await mgr.start([{ ...cfg, name: "db." }]);
  const ctx = { mcp: mgr } as unknown as ToolContext;
  try {
    const listed = await mcpResourceTool.execute({ server: "db" }, ctx);
    assert.notEqual(listed.isError, true, "the listing rejected the name the model is shown");
    assert.match(listed.output, /db:\/\/schema/);

    const read = await mcpResourceTool.execute({ server: "db", uri: "db://schema" }, ctx);
    assert.notEqual(read.isError, true);
    assert.match(read.output, /CREATE TABLE users/);
  } finally {
    await mgr.dispose();
  }
});

test("resources are listed on demand and read by URI", async () => {
  const mgr = await pool();
  try {
    const { resources, templates } = await mgr.listResources();
    assert.deepEqual(resources.map((r) => r.uri), ["db://dump", "db://schema"]);
    assert.equal(templates.length, 1);
    assert.deepEqual(mgr.resourceServers(), ["db"]);

    const read = await mgr.readResource("db", "db://schema");
    assert.equal(read.isError, false);
    assert.match(read.text, /CREATE TABLE users/);
    // Server content is third-party text landing where the model trusts tool output.
    assert.match(read.text, /<mcp_result server="db">/);
  } finally {
    await mgr.dispose();
  }
});

test("a huge resource goes to disk like a huge tool result", async () => {
  const project = mkdtempSync(join(tmpdir(), "mw-res-"));
  const mgr = await pool(project);
  try {
    const read = await mgr.readResource("db", "db://dump");
    assert.ok(read.text.length < 10_000, `the model got ${read.text.length} chars`);
    assert.match(read.text, /DUMP HEAD/);
    assert.match(read.text, /Result truncated here/);
    const files = await fs.readdir(resultsDir(project));
    assert.equal(files.length, 1);
    assert.ok((await fs.readFile(join(resultsDir(project), files[0]!), "utf8")).length > 150_000);
  } finally {
    await mgr.dispose();
  }
});

test("a missing resource is an error the model can act on, not a crash", async () => {
  const mgr = await pool();
  try {
    const read = await mgr.readResource("db", "db://nope");
    assert.equal(read.isError, true);
    assert.match(read.text, /Could not read 'db:\/\/nope'/);
  } finally {
    await mgr.dispose();
  }
});

test("the tools refuse an unfilled template instead of asking the server about it", async () => {
  const mgr = await pool();
  const ctx = { mcp: mgr } as unknown as ToolContext;
  try {
    const result = await mcpResourceTool.execute({ server: "db", uri: "db://table/{name}" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.output, /is a template/);

    const listed = await mcpResourceTool.execute({}, ctx);
    assert.match(listed.output, /db:\/\/schema/);
    assert.match(listed.summary ?? "", /2 resources/);
  } finally {
    await mgr.dispose();
  }
});

test("with no resource servers the tools say so rather than returning nothing", async () => {
  const mgr = new McpManager();
  const ctx = { mcp: mgr } as unknown as ToolContext;
  const listed = await mcpResourceTool.execute({}, ctx);
  assert.match(listed.output, /No connected MCP server exposes resources/);
  assert.ok(!listed.isError, "an empty project is not an error");
});
