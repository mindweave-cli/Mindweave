/**
 * deferred.test.ts — the search a model actually performs.
 *
 * The ranking itself is blunt keyword matching and not very interesting. What matters
 * is the failure modes: a query that returns nothing reads to the model as "that tool
 * does not exist", so it stops searching and guesses instead. Every special case below
 * exists to stop search being a dead end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFER_THRESHOLD, renderResults, scoreTool, searchCatalog, shouldDefer } from "./deferred.js";
import type { McpToolDef } from "./catalog.js";

const def = (server: string, name: string, description = ""): McpToolDef => ({
  server,
  name,
  description,
  inputSchema: { type: "object" },
  readOnly: false,
});

const CATALOG: McpToolDef[] = [
  def("github", "create_issue", "Open a new issue on a repository"),
  def("github", "search_code", "Search code across repositories"),
  def("github", "list_prs", "List pull requests"),
  def("postgres", "run_query", "Execute a read-only SQL query"),
  def("postgres", "list_tables", "List tables in the database"),
  def("slack", "post_message", "Send a message to a channel"),
];

test("small catalogs are not deferred, because search would be strictly worse", () => {
  // Hiding three tools behind a menu costs a round trip to reach what could just have
  // been shown.
  assert.equal(shouldDefer(3), false);
  assert.equal(shouldDefer(DEFER_THRESHOLD), false, "at the threshold, still shown");
  assert.equal(shouldDefer(DEFER_THRESHOLD + 1), true);
});

test("an exact tool name resolves to exactly that tool", () => {
  // A model that already knows the name passes it verbatim. Keyword ranking would
  // scatter that across several results.
  assert.deepEqual(searchCatalog("create_issue", CATALOG).map((d) => d.name), ["create_issue"]);
  assert.deepEqual(searchCatalog("mcp__github__create_issue", CATALOG).map((d) => d.name), ["create_issue"]);
});

test("a server name returns that server's tools, with or without the prefix", () => {
  assert.deepEqual(searchCatalog("postgres", CATALOG).map((d) => d.name), ["run_query", "list_tables"]);
  assert.deepEqual(searchCatalog("mcp__postgres", CATALOG).map((d) => d.name), ["run_query", "list_tables"]);
});

test("an action phrase finds the right tool", () => {
  const names = searchCatalog("create issue", CATALOG).map((d) => d.name);
  assert.equal(names[0], "create_issue", `expected create_issue first, got ${names.join(", ")}`);
});

test("a description-only match is found, but ranks below a name match", () => {
  const names = searchCatalog("search", CATALOG).map((d) => d.name);
  assert.equal(names[0], "search_code", "the name match wins");
  // "Search code across repositories" also matches, but a description hit alone is weak.
  assert.ok(names.length >= 1);
});

test("results are stable between identical searches", () => {
  // An unstable order would make an already-loaded tool look like a different one.
  assert.deepEqual(searchCatalog("list", CATALOG), searchCatalog("list", CATALOG));
});

test("a query that matches nothing returns nothing, rather than noise", () => {
  assert.deepEqual(searchCatalog("kubernetes", CATALOG), []);
  assert.deepEqual(searchCatalog("", CATALOG), []);
  assert.deepEqual(searchCatalog("   ", CATALOG), []);
});

test("results are capped so one search cannot flood the context", () => {
  const many = Array.from({ length: 50 }, (_, i) => def("srv", `tool_${i}`, "a thing"));
  assert.ok(searchCatalog("thing", many).length <= 8);
});

test("scoring prefers a whole-word name hit over a substring or description hit", () => {
  const exactWord = def("github", "search_code", "");
  const substring = def("github", "researcher", "");
  const descOnly = def("github", "other", "you can search with this");
  const terms = ["search"];
  assert.ok(scoreTool(exactWord, terms) > scoreTool(substring, terms));
  assert.ok(scoreTool(substring, terms) > scoreTool(descOnly, terms));
  assert.equal(scoreTool(def("x", "unrelated", ""), terms), 0);
});

test("rendered results hand over the whole callable definition", () => {
  // The WHOLE thing — full description and parameter schema — not a summary line. A
  // summary only announces that a tool exists; the tool then had to be added to the
  // advertised list before it could be called, and that rewrote the provider's cached
  // prefix (tools, system AND messages) at full price. Delivered here it rides in an
  // appended message the cache does not care about, and dispatch resolves against the
  // catalog, so a name plus a schema is all the model needs.
  const text = renderResults([def("github", "create_issue", "Open a new issue\nTakes a title and body")]);
  const parsed = JSON.parse(text.replace(/^<function>/, "").replace(/<\/function>$/, "")) as {
    name: string;
    description: string;
    parameters: unknown;
  };
  assert.equal(parsed.name, "mcp__github__create_issue", "the name it must call");
  assert.match(parsed.description, /Takes a title/, "a truncated description cannot be called from");
  assert.ok(parsed.parameters, "without parameters the model cannot construct the call");
});
