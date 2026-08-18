import { test } from "node:test";
import assert from "node:assert/strict";
import { toolKind, toolDisplay, KIND_COLOR, UNKNOWN_TOOL } from "./toolDisplay.js";
import { TOOLS } from "../tools/registry.js";

test("an mcp__ prefixed name is detected as the mcp kind by prefix, not a static map entry", () => {
  assert.equal(toolKind("mcp__sqlite-local__execute_query"), "mcp");
  assert.equal(toolKind("mcp__anything__at_all"), "mcp");
});

test("web_fetch and web_search share the websearch kind, not codebase search", () => {
  assert.equal(toolKind("web_fetch"), "websearch");
  assert.equal(toolKind("web_search"), "websearch");
});

test("screenshot has its own kind", () => {
  assert.equal(toolKind("screenshot"), "screenshot");
});

test("an unknown tool name still falls back to meta", () => {
  assert.equal(toolKind("something_nobody_registered"), "meta");
});

test("every ToolKind used by toolKind() has a KIND_COLOR entry", () => {
  const kinds = ["read", "search", "edit", "write", "run", "check", "agent", "websearch", "screenshot", "mcp", "checkpoint", "governor", "meta"] as const;
  for (const k of kinds) {
    assert.ok(KIND_COLOR[k], `${k} needs a KIND_COLOR entry`);
  }
});

test("mcp__server__tool parses back into MCPServer(server) for the header", () => {
  const d = toolDisplay("mcp__sqlite-local__execute_query", {});
  assert.equal(d.name, "MCPServer");
  assert.equal(d.arg, "sqlite-local");
  assert.equal(d.kind, "mcp");
});

test("web_search's arg is its query, not the generic path/symbol fallback", () => {
  const d = toolDisplay("web_search", { query: "DeepSeek V4 Flash context window" });
  assert.equal(d.arg, "DeepSeek V4 Flash context window");
});

test("a long web_search query is clipped like other long args", () => {
  const d = toolDisplay("web_search", { query: "x".repeat(80) });
  assert.ok(d.arg!.length <= 48);
  assert.ok(d.arg!.endsWith("…"));
});

test("screenshot's arg is the window title, not the generic fallback", () => {
  const d = toolDisplay("screenshot", { window: "Chrome — DeepSeek API Documentation" });
  assert.equal(d.arg, "Chrome — DeepSeek API Documentation");
});

test("screenshot with no window arg has no arg, not an empty string", () => {
  const d = toolDisplay("screenshot", {});
  assert.equal(d.arg, undefined);
});

test("web_fetch's display name and arg extraction are unchanged by the kind fix", () => {
  const d = toolDisplay("web_fetch", { url: "https://docs.deepseek.com/api/endpoints" });
  assert.equal(d.name, "Fetch");
  assert.equal(d.arg, "https://docs.deepseek.com/api/endpoints");
  assert.equal(d.kind, "websearch");
});

test("EVERY registered tool has a display name — no snake_case can reach a row", () => {
  // The defect this closes was on screen: a tool with no entry fell through to the
  // capitalize-the-raw-name fallback, so `replace_symbol_body` would have rendered as
  // `Replace_symbol_body`. The fallback is now reserved for names that are not tools
  // at all, which only works while every real tool is covered here.
  const missing = TOOLS.filter((t) => toolDisplay(t.name, {}).name === UNKNOWN_TOOL).map((t) => t.name);
  assert.deepEqual(missing, [], `these registered tools have no DISPLAY_NAME entry: ${missing.join(", ")}`);
});

test("a tool the model invented renders under a plain name, not title-cased snake_case", () => {
  // Seen live: the model called `index_results`, which does not exist, and the row
  // read "Index_results". The call still gets a row — it happened and it failed — but
  // the invented name belongs in the argument, not in the header.
  const d = toolDisplay("index_results", {});
  assert.equal(d.name, UNKNOWN_TOOL);
  assert.equal(d.arg, "index_results");
  assert.equal(d.kind, "meta");
});

test("an MCP server's tool is never mistaken for an invented one", () => {
  // mcp__ names are generated per-server, so they can't be in the static map.
  const d = toolDisplay("mcp__sqlite-local__execute_query", {});
  assert.equal(d.name, "MCPServer");
  assert.equal(d.arg, "sqlite-local");
});
