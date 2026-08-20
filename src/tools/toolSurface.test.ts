/**
 * toolSurface.test.ts — what the model is actually shown, and what it costs.
 *
 * The advertised tool list is the most expensive stable thing in the prompt after the
 * system message, and it is paid on every uncached request of every session. It is also
 * the list the model chooses from, so its length is an accuracy question as well as a
 * cost one. Both properties are easy to erode one convenient tool at a time, so they are
 * asserted rather than assumed.
 *
 * The rules being defended:
 *  - a tool the prompt tells the model to reach for is NEVER deferred behind a search;
 *  - the deferred pool is reachable and named, so a held-back tool is not a missing one;
 *  - a tool whose subject matter can be absent is gated on the subject, not on a search.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { toolSchemas, TOOLS } from "./registry.js";
import { DEFERRED_TOOLS, deferredToolsIndex, matchDeferred, renderToolSchema } from "./deferredNative.js";
import { basePrompt } from "../dynamo/prompt.js";
import { staticSystemPrompt } from "../dynamo/engine.js";
import type { ToolContext } from "./types.js";

/** A session that has done nothing yet: no shells, no skills. The common case. */
const freshCtx = () =>
  ({ cwd: process.cwd(), governance: { rules: [], skills: [], forbidden: [] } }) as unknown as ToolContext;

const advertised = (ctx?: ToolContext) =>
  (toolSchemas(ctx ? { ctx } : {}) as { name?: string; function?: { name?: string } }[]).map(
    (s) => s.name ?? s.function?.name ?? "",
  );

test("every deferred tool is in the pool, and every pool member is deferred", () => {
  // The two are separate declarations — a flag on the tool and an entry in the pool —
  // and either one alone is a silent failure: a flagged tool missing from the pool is
  // UNREACHABLE (hidden, and no search can find it), while a pool member without the
  // flag is advertised anyway and the entry does nothing.
  const flagged = TOOLS.filter((t) => t.deferred).map((t) => t.name).sort();
  const pooled = DEFERRED_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(pooled, flagged);
});

test("no deferred tool is advertised, and find_tools always is", () => {
  const names = advertised(freshCtx());
  for (const t of DEFERRED_TOOLS) {
    assert.ok(!names.includes(t.name), `${t.name} is deferred but still advertised`);
  }
  assert.ok(names.includes("find_tools"), "the way back to the deferred pool must never be deferred");
});

test("every deferred tool is findable by its own name", () => {
  // The pool is only as good as the search that reaches it. A tool the model can see
  // named in the index but cannot retrieve by that name is worse than not deferring it.
  for (const t of DEFERRED_TOOLS) {
    const found = matchDeferred(t.name).map((x) => x.name);
    assert.ok(found.includes(t.name), `find_tools("${t.name}") does not return it`);
  }
});

test("the index names every deferred tool", () => {
  const index = deferredToolsIndex();
  for (const t of DEFERRED_TOOLS) {
    assert.ok(index.includes(t.name), `${t.name} is hidden with nothing telling the model it exists`);
  }
});

test("a tool the prompt tells the model to use is either advertised or pointed at find_tools", () => {
  // The failure this catches is the expensive one: the prompt instructs a habit ("after
  // you edit, run diagnostics"), the tool is quietly deferred, and every session pays a
  // search round trip to obey an instruction it was given unconditionally.
  const prompt = basePrompt("bash");
  // Only DEFERRED tools. A `relevantWhen` tool is a different bargain: it is absent
  // exactly while its subject matter is, and it comes back on its own the moment there
  // is something to act on — no search, so no instruction to give.
  for (const tool of DEFERRED_TOOLS) {
    // Only names that unambiguously mean THE TOOL. Several tools are named after
    // ordinary English words — "Memory across sessions" is prose, not an instruction to
    // call `sessions` — so a bare word match reports a reference that is not there. A
    // name carrying an underscore, or one written in backticks, is always the tool.
    const word = new RegExp(
      tool.name.includes("_") ? String.raw`\b${tool.name}\b` : String.raw`\x60${tool.name}\x60`,
    );
    if (!word.test(prompt)) continue;
    // Checked per LINE (one bullet) rather than per sentence: a bullet may name the
    // tool several times while pointing at find_tools once, which is fine to read.
    const lines = prompt.split(/\r?\n/).filter((line) => word.test(line));
    assert.ok(
      lines.some((line) => /find_tools/.test(line)),
      `the prompt tells the model to use "${tool.name}", which is not advertised, without saying how to load it`,
    );
  }
});

test("the shell tools are hidden until a shell exists, and stay once one has", () => {
  const none = advertised(freshCtx());
  assert.ok(!none.includes("shells"), "shells is advertised in a session that has never backgrounded anything");
  assert.ok(!none.includes("kill_shell"), "kill_shell is advertised with no shell to kill");

  // A FINISHED shell still counts. The gate reads `list()`, not `running()`, so the tool
  // list latches once per session instead of flipping the cached prefix on every exit.
  const ctx = freshCtx();
  (ctx as { backgroundShells?: unknown }).backgroundShells = { list: () => [{ id: 1, status: "exited" }] };
  const some = advertised(ctx);
  assert.ok(some.includes("shells"), "a session with a finished shell cannot read its output");
  assert.ok(some.includes("kill_shell"));
});

test("neither deferral nor gating can hide a tool from dispatch", () => {
  // Being unadvertised is a display decision. If the model names one anyway — from the
  // index, from a resumed transcript — it must still RUN, not 404.
  const names = new Set(TOOLS.map((t) => t.name));
  for (const t of DEFERRED_TOOLS) assert.ok(names.has(t.name), `${t.name} left the registry`);
  assert.ok(names.has("shells") && names.has("kill_shell"));
});

test("discovery is append-only: a search hands over a callable schema", () => {
  // The economics that forced this. Deferral saved ~2.6k tokens of schema; advertising a
  // found tool changed the `tools` bytes, which re-billed the ENTIRE cached prefix —
  // tools, system and messages — for roughly ten thousand. One search wiped out a
  // session's saving several times over. So the schema is delivered in the result.
  for (const t of DEFERRED_TOOLS) {
    const rendered = renderToolSchema(t);
    const parsed = JSON.parse(rendered.replace(/^<function>|<\/function>$/g, "")) as {
      name: string;
      description: string;
      parameters: unknown;
    };
    assert.equal(parsed.name, t.name);
    assert.ok(parsed.description.length > 0, `${t.name} was handed over with no description`);
    assert.deepEqual(parsed.parameters, t.parameters, `${t.name}'s parameters did not survive`);
  }
});

test("the advertised list cannot be moved by anything a turn does", () => {
  // The invariant, stated as an invariant: whatever happens in a session, the bytes the
  // provider hashes are the same bytes. There is no longer an argument that could change
  // them, which is stronger than remembering not to pass one.
  const a = JSON.stringify(toolSchemas({ ctx: freshCtx() }));
  const b = JSON.stringify(toolSchemas({ ctx: freshCtx() }));
  assert.equal(a, b);

  // And structurally, because the behavioural check above passes trivially once the
  // capability is gone: there must be no way to ASK for a deferred tool to be advertised.
  // The old signature took an `activated` set, and every caller that passed one was
  // buying a prefix rewrite it could not see.
  const source = readFileSync(new URL("./registry.ts", import.meta.url), "utf8");
  assert.ok(!/activated/.test(source), "toolSchemas can still be asked to advertise a deferred tool");
});

test("a search for one tool does not hand over five others", () => {
  // Measured from a real session: searching "session" returned SIX tools, because the
  // word appears in four other descriptions in passing ("for the rest of this session")
  // and a description mention scored enough to qualify. Every match is answered with a
  // full schema now, so a loose match is not a spare line, it is a few hundred tokens
  // the model did not ask for.
  const hits = matchDeferred("session").map((t) => t.name);
  assert.deepEqual(hits, ["sessions"], `a name match must beat passing mentions, got ${hits.join(", ")}`);
});

test("a description-only match still comes back", () => {
  // The floor is relative on purpose. When nothing matched by name, the best description
  // hit IS the answer, and a fixed threshold tuned to kill passing mentions would throw
  // it away — leaving a reachable tool unreachable by the word that describes it.
  const hits = matchDeferred("remember");
  assert.ok(hits.length > 0, "a query that only matches a description must still find it");
});

test("no search can hand over the whole pool", () => {
  // A broad query used to be uncapped: every tool that scored at all came back with its
  // schema attached. The MCP side has always had a cap; the native side had none.
  for (const q of ["a e i o u", "tool", "file", "the"]) {
    assert.ok(matchDeferred(q).length <= 5, `"${q}" returned ${matchDeferred(q).length} tools`);
  }
});

test("the prompt never names a tool that does not exist", () => {
  // The failure this catches, seen live: the prompt told the model to call
  // `list_sessions` and `read_session`, which were merged into one `sessions` tool long
  // ago. The model obeyed, got "unknown tool", and burned two round trips recovering —
  // one on the dead name and one searching for the real one.
  // The WHOLE system prompt, not just the static base. The line that caused this lives
  // in the session-composed half, so a check that read only basePrompt would have missed
  // the exact bug it was written for — and did, until a red-check showed it passing with
  // the dead name put back.
  const prompt =
    basePrompt("bash") +
    staticSystemPrompt("", "", "/memory", "", { forbidden: "", skills: "", rules: "" } as never, "", 3);
  const known = new Set(TOOLS.map((t) => t.name));
  // Only backticked snake_case words: that shape in a prompt is always a tool name.
  for (const m of prompt.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) {
    const name = m[1]!;
    assert.ok(known.has(name), `the prompt tells the model to call "${name}", which is not a registered tool`);
  }
});
