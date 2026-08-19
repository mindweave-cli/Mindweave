import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolSchemas } from "./registry.js";
import { DEFERRED_TOOLS, deferredToolsIndex, matchDeferred } from "./deferredNative.js";
import type { ToolContext } from "./types.js";
import { DEFER_THRESHOLD } from "../mcp/deferred.js";

test("toolSchemas advertises every tool by default, except plan-only and deferred ones", () => {
  // The point of this test is that nothing gets accidentally dropped from the model's
  // view. Two deliberate exceptions: `planOnly` tools exist only because planning is
  // happening, and `deferred` tools are held back until searched for. Counted from the
  // registry rather than hard-coded, so adding any kind is safe.
  const planOnly = TOOLS.filter((t) => t.planOnly);
  const deferred = TOOLS.filter((t) => t.deferred);
  assert.ok(planOnly.length > 0, "this exception should describe something real");
  assert.ok(deferred.length > 0, "so should this one");
  assert.equal(toolSchemas().length, TOOLS.length - planOnly.length - deferred.length);

  const inPlan = toolSchemas({ planMode: true }).map((s) => s.function.name);
  for (const tool of planOnly) assert.ok(inPlan.includes(tool.name), `${tool.name} missing in plan mode`);
});

test("the advertised set stays at or under the project's own deferral threshold", () => {
  // src/mcp/deferred.ts sets DEFER_THRESHOLD = 25 with the reasoning that selection
  // accuracy degrades measurably past it. The native registry exceeded its own stated
  // threshold by 13 tools until the merges and the deferred pool landed. This is what
  // stops it drifting back: adding a tool now means deferring or merging another, or
  // making the deliberate case to raise the threshold itself.
  assert.ok(
    toolSchemas().length <= DEFER_THRESHOLD,
    `${toolSchemas().length} advertised tools exceeds DEFER_THRESHOLD (${DEFER_THRESHOLD}); defer or merge one`,
  );
});

test("a deferred tool is never advertised, no matter what has been searched", () => {
  // The advertised list is FIXED for the whole session. That is the point: it is the
  // bytes the provider hashes for its prompt cache, and the old behaviour — searching a
  // tool added it to the list — rewrote the entire cached prefix to save a few hundred
  // tokens of schema. Discovery is append-only now; find_tools hands the model the
  // schema in its result and the list never moves.
  const deferred = TOOLS.find((t) => t.deferred)!;
  const names = toolSchemas().map((s) => s.function.name);
  assert.ok(!names.includes(deferred.name), "deferred tools must not be advertised");
  assert.deepEqual(toolSchemas(), toolSchemas(), "the advertised list must be a pure function of the session");
});

test("every deferred tool is reachable by searching its own name", () => {
  // The pool is only safe because search is a reliable door. A tool whose own name
  // finds nothing is unreachable in practice — the capability would be gone, not
  // merely deferred, and the model has no way to discover that.
  for (const tool of DEFERRED_TOOLS) {
    const hits = matchDeferred(tool.name).map((t) => t.name);
    assert.ok(hits.includes(tool.name), `${tool.name} cannot be found by its own name`);
  }
});

test("the prompt index names every deferred tool", () => {
  // The index is what tells the model these capabilities exist at all. A tool missing
  // from it is one the model will never think to search for.
  const index = deferredToolsIndex();
  for (const tool of DEFERRED_TOOLS) {
    assert.ok(index.includes(tool.name), `${tool.name} is absent from the deferred index`);
  }
  assert.match(index, /find_tools/, "and the index has to name the door");
});

test("a relevantWhen tool is hidden when it has nothing to act on", () => {
  // `use_skill` in a project with no skills is not "rare", it is INERT — every call it
  // could attract can only fail. Distinct from `deferred`: this costs no search round
  // trip when the tool IS wanted, because it reappears on its own.
  const noSkills = { governance: { skills: [] } } as unknown as ToolContext;
  const withSkills = { governance: { skills: [{ name: "ship" }] } } as unknown as ToolContext;

  const hidden = toolSchemas({ ctx: noSkills }).map((s) => s.function.name);
  assert.ok(!hidden.includes("use_skill"), "a project with no skills must not be offered use_skill");

  const shown = toolSchemas({ ctx: withSkills }).map((s) => s.function.name);
  assert.ok(shown.includes("use_skill"), "one skill is enough to bring it back");
  assert.equal(shown.length, hidden.length + 1, "and it changes exactly that one tool");
});

test("with no ctx, a relevantWhen tool is shown rather than silently dropped", () => {
  // Schema-shape checks and counts pass no session. Hiding the tool there would be a
  // false negative about what the registry actually contains.
  assert.ok(toolSchemas().map((s) => s.function.name).includes("use_skill"));
});

test("web covers both search and fetch, and refuses an ambiguous call", async () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.web_search, undefined, "web_search merged into web");
  assert.equal(byName.web_fetch, undefined, "web_fetch merged into web");
  assert.match(byName.web!.description, /SEARCH/);
  assert.match(byName.web!.description, /READ/);
  assert.equal(byName.web!.readOnly, true, "must stay usable while planning");

  const ctx = {} as unknown as ToolContext;
  const neither = await byName.web!.execute({}, ctx);
  assert.ok(neither.isError);
  assert.match(neither.output, /`query`.*or.*`url`/);

  // Both is refused rather than silently picking one: it means the model was unsure,
  // and quietly answering half the request is the worse outcome.
  const both = await byName.web!.execute({ query: "x", url: "example.com" }, ctx);
  assert.ok(both.isError);
  assert.match(both.output, /not both/);
});

test("no parameter is named like a CLI flag", () => {
  // `grep` shipped a parameter literally called `-i`. JSON Schema allows it, but a
  // property name starting with a dash is handled inconsistently across providers'
  // function-calling implementations, and a parameter the model cannot reliably send
  // is worse than a longer name. It was the only one in the registry shaped like that;
  // this keeps it that way. Checked over the advertised schemas, which is what actually
  // reaches a provider.
  for (const schema of toolSchemas()) {
    const props = schema.function.parameters?.properties ?? {};
    for (const name of Object.keys(props)) {
      assert.ok(
        !name.startsWith("-"),
        `${schema.function.name}.${name} is named like a CLI flag; spell it out (e.g. ignore_case)`,
      );
    }
  }
});

test("the editing tools route to each other, so the model can pick correctly", () => {
  // Which tool to reach for is decided entirely by these descriptions — the model has
  // nothing else to go on. When they don't cross-reference, the observed cost is real:
  // repeated single edits where one batched call belonged, or a whole-file rewrite to
  // change three lines. Each tool has to name the neighbour that beats it, so the
  // routing survives someone rewording one of them in isolation.
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.description]));

  // The single largest routing decision used to be edit_file vs multi_edit, and it was
  // decided badly and inconsistently (three shapes across four runs on identical input).
  // Merging them deleted the decision rather than describing it better. Guard the merge:
  // reintroducing either name brings the ambiguity back with it.
  assert.equal(byName.edit_file, undefined, "edit_file was merged into edit; do not reintroduce the split");
  assert.equal(byName.multi_edit, undefined, "multi_edit was merged into edit; do not reintroduce the split");

  // edit is the default for changing an existing file, and covers both shapes itself.
  assert.match(byName.edit!, /DEFAULT/);
  assert.match(byName.edit!, /one entry for a single change/i);
  assert.match(byName.edit!, /several entries/i);
  assert.match(byName.edit!, /ONE FILE PER CALL/);

  // write_file is the last resort, and points at the targeted tool.
  assert.match(byName.write_file!, /\bedit\b/);

  // replace_symbol_body owns whole definitions and defers for changes inside one.
  assert.match(byName.replace_symbol_body!, /\bedit\b/);
});

test("plan mode advertises only read-only tools", () => {
  const names = new Set(toolSchemas({ planMode: true }).map((t) => t.function.name));
  const mutating = TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
  // No mutating tool is offered…
  for (const m of mutating) assert.ok(!names.has(m), `${m} should be withheld in plan mode`);
  // …and edit/write/run are exactly the kind that must be gone.
  for (const m of ["write_file", "edit_file", "run_command"]) assert.ok(!names.has(m));
  // Read-only discovery stays available.
  assert.ok(names.has("read_file"));
});
