/**
 * cacheBreak.test.ts — the detector that would have caught the two expensive bugs.
 *
 * Both shipped, both were invisible, and both were found by reading a session file after
 * the fact: a skill catalog inside the system prompt that varied with which files had
 * been read, and a tool search that added what it found to the advertised list. Each test
 * below is one of those shapes, plus the ordering rule that makes a report actionable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefixPrint, diffPrefix, hashString } from "./cacheBreak.js";
import type { ToolSchema } from "../tools/types.js";
import type { ChatMessage } from "../drivers/types.js";

const tool = (name: string, description = "does a thing"): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

const print = (model = "m", system = "SYSTEM", tools: ToolSchema[] = [tool("read"), tool("edit")]) =>
  prefixPrint(model, system, tools);

test("an unchanged prefix reports nothing", () => {
  assert.equal(diffPrefix(print(), print()), null);
});

test("REGRESSION: a system prompt that varies with session state", () => {
  // The skill-catalog bug. The catalog was filtered by which files had been read, so
  // reading a matching file rewrote the system prompt and invalidated tools, system AND
  // messages — the most expensive invalidation the API has — with nothing on screen.
  const broke = diffPrefix(print(), print("m", "SYSTEM\n- deploy: does deploy"));
  assert.equal(broke?.kind, "system");
  assert.match(broke!.detail, /system prompt changed/);
  assert.match(broke!.detail, /\+\d+ chars/, "the size of the change is what tells you which section moved");
});

test("REGRESSION: a search that adds what it found to the advertised list", () => {
  // The find_tools bug. One search re-billed the whole prefix to save a few hundred
  // tokens of schema. The report has to NAME the tool, or the next person is guessing.
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read"), tool("edit"), tool("sessions")]));
  assert.equal(broke?.kind, "tools");
  assert.match(broke!.detail, /\+sessions/);
});

test("a tool whose schema changes under a stable name is caught and named", () => {
  // The case a name-and-count check cannot see: same tools, same order, different bytes,
  // because a description is built from live state. It breaks the cache every call.
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read"), tool("edit", "does a thing (3 open)")]));
  assert.equal(broke?.kind, "tool-schema");
  assert.match(broke!.detail, /^edit /, "the changed tool must be named, not just counted");
});

test("a removed tool is reported as removed", () => {
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read")]));
  assert.equal(broke?.kind, "tools");
  assert.match(broke!.detail, /-edit/);
});

test("the outermost cause wins when several things moved", () => {
  // The parts are nested: on a model switch every downstream difference is meaningless,
  // so reporting "the tool list changed" would send someone chasing a non-problem.
  const broke = diffPrefix(print(), print("other-model", "DIFFERENT", [tool("read")]));
  assert.equal(broke?.kind, "model");
});

test("the fingerprint is small enough to hold for a session", () => {
  // It is kept per session and compared every call. Storing the content instead of
  // hashes would mean carrying a second copy of the whole prompt for diagnostics.
  const p = print("m", "x".repeat(50_000));
  assert.equal(typeof p.system, "number");
  assert.ok(Object.values(p.tools).every((h) => typeof h === "number"));
  assert.ok(JSON.stringify(p).length < 2_000);
});

test("the hash actually distinguishes near-identical text", () => {
  assert.notEqual(hashString("tool_a"), hashString("tool_b"));
  assert.notEqual(hashString("abc"), hashString("acb"));
  assert.equal(hashString("same"), hashString("same"));
});

const msg = (content: string): ChatMessage => ({ role: "user", content });

test("appending to the conversation is not a break", () => {
  // The normal case, and it must stay silent or every call reports one. Growth costs
  // nothing: every earlier byte is untouched, which is the whole point of append-only.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  assert.equal(diffPrefix(before, after), null);
});

test("REGRESSION: rewriting an earlier message is caught and located", () => {
  // The blind spot this closes. Microcompaction clearing an old tool body, a read being
  // de-duplicated, an image ref dropped — each rewrites history in place, invalidating
  // everything after it, and NONE of them touch the system prompt or a tool schema. The
  // detector reported nothing at all for this whole class of break.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("CLEARED"), msg("three")]);
  const broke = diffPrefix(before, after);
  assert.equal(broke?.kind, "history");
  assert.match(broke!.detail, /message 2 /, "the report must locate the rewrite, not just announce it");
});

test("a dropped turn is a rewrite even when every surviving message matches", () => {
  // Overflow recovery drops the oldest rounds. Nothing was edited, but everything moved.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two")]);
  assert.equal(diffPrefix(before, after)?.kind, "history");
});

test("the first rewritten message wins, not the last", () => {
  // Everything after the first break is a consequence of it. Reporting the last one
  // points at a symptom and sends someone looking in the wrong turn.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("a"), msg("b"), msg("c")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("a"), msg("X"), msg("Y")]);
  assert.match(diffPrefix(before, after)!.detail, /message 2 /);
});
