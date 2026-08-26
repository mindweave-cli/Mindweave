/**
 * scope.test.ts — glob-scoped rules are decided when a path is touched, not when the
 * prompt is rendered.
 *
 * The shape being replaced: every model call rebuilt the set of every path the session
 * had ever touched and matched every scoped rule against all of it — O(paths x rules)
 * per step, against a set that only grew. Resolving a conditional rule at the moment a
 * file is touched is the only version of it that stays correct.
 *
 * Two properties matter and neither is visible from a render: that a fired rule STAYS
 * fired across a compaction, and that rendering does no path work at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRuleScope, noteScopePath, rescope } from "./scope.js";
import { renderRules, activeRules } from "./rules.js";
import type { Rule } from "./types.js";

const ROOT = process.platform === "win32" ? "D:\proj" : "/proj";
const abs = (...parts: string[]) => join(ROOT, ...parts);

const ALWAYS: Rule = { name: "pm", description: "", body: "Use pnpm." };
const API: Rule = { name: "api", description: "", body: "Kebab-case routes.", globs: ["src/api/**"] };
const WEB: Rule = { name: "web", description: "", body: "Web is TSX.", globs: ["src/web/**"] };
const RULES = [ALWAYS, API, WEB];

test("a scoped rule fires only for its own paths", () => {
  const s = createRuleScope();
  noteScopePath(s, RULES, ROOT, abs("src", "api", "users.ts"));
  assert.deepEqual([...s.matched], ["api"]);
  assert.equal(activeRules(RULES, s.matched).length, 2, "always-on + api");
});

test("a fired rule survives a compaction, because the MATCH is what is remembered", () => {
  // The original bug: scoping rode on the read ledger, and a compaction clears it — so
  // a rule scoped to a folder stopped applying the moment the session was summarised.
  // The first fix carried every path forward. This one has nothing to carry: a name in
  // `matched` is never removed, so there is no state a compaction could clear.
  const s = createRuleScope();
  noteScopePath(s, RULES, ROOT, abs("src", "api", "users.ts"));
  const beforeCompaction = renderRules(RULES, s.matched);
  assert.match(beforeCompaction, /Kebab-case/);

  // A compaction clears `ctx.reads` and touches nothing here. Simulated by doing
  // exactly that — nothing.
  assert.equal(renderRules(RULES, s.matched), beforeCompaction, "the rule stopped applying");
});

test("rendering never looks at a path, so its cost cannot grow with the session", () => {
  // The property the rewrite exists for. A scope carrying thousands of paths must cost
  // the same to render as an empty one, because rendering reads `matched` alone.
  const s = createRuleScope();
  for (let i = 0; i < 5_000; i++) noteScopePath(s, RULES, ROOT, abs("docs", `n${i}.md`));
  assert.equal(s.matched.size, 0, "unrelated paths must not fire anything");
  assert.equal(renderRules(RULES, s.matched), "- Use pnpm.");
  // And the remembered set is capped, so it is not a leak either.
  assert.ok(s.paths.size <= 2_000, `remembered paths must be bounded, got ${s.paths.size}`);
});

test("a rule added AFTER the work is re-judged against what the session already did", () => {
  // remember_rule, or the user hand-writing a rule mid-session. Scoping is decided at
  // touch time, so without a re-judge the new rule would sit inert until the model
  // happened to touch a matching file again.
  const s = createRuleScope();
  noteScopePath(s, [ALWAYS], ROOT, abs("src", "api", "users.ts")); // API does not exist yet
  assert.equal(s.matched.size, 0);

  rescope(s, RULES);
  assert.ok(s.matched.has("api"), "the newly added rule never saw the work already done");
  assert.ok(!s.matched.has("web"), "and it must not fire rules whose paths were never touched");
});

test("a rule deleted from disk stops rendering even though its name is remembered", () => {
  // `matched` is additive and never un-matches. What keeps a removed rule out is that
  // rendering filters the LIVE rule list, not the remembered names.
  const s = createRuleScope();
  noteScopePath(s, RULES, ROOT, abs("src", "api", "users.ts"));
  assert.ok(s.matched.has("api"));
  const afterDeletion = renderRules([ALWAYS, WEB], s.matched);
  assert.doesNotMatch(afterDeletion, /Kebab-case/, "a deleted rule was still being injected");
});

test("a project with no scoped rules does no matching work", () => {
  const s = createRuleScope();
  noteScopePath(s, [ALWAYS], ROOT, abs("anything.ts"));
  assert.equal(s.matched.size, 0);
  assert.equal(renderRules([ALWAYS], s.matched), "- Use pnpm.");
});

/**
 * The wiring, end to end. Everything above tests scope.ts in isolation, which proves
 * nothing about whether a real read reaches it — and a scoping engine nothing calls is
 * exactly as broken as one that computes the wrong answer.
 */
import { readFile as readFileTool } from "../tools/readFile.js";
import { writeFile as writeFileTool } from "../tools/writeFile.js";
import { promises as fsp, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ToolContext } from "../tools/types.js";

function ctxWithRules(rules: Rule[]): ToolContext {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-scopewire-")));
  return {
    cwd,
    reads: new Map(),
    todos: [],
    ruleScope: createRuleScope(),
    governance: { rules, skills: [], forbidden: { patterns: [], root: cwd } },
  } as unknown as ToolContext;
}

test("WIRING: reading a file fires the rule scoped to it", async () => {
  const rules: Rule[] = [
    ALWAYS,
    { name: "api", description: "", body: "Kebab-case routes.", globs: ["src/api/**"] },
  ];
  const ctx = ctxWithRules(rules);
  await fsp.mkdir(join(ctx.cwd, "src", "api"), { recursive: true });
  await fsp.writeFile(join(ctx.cwd, "src", "api", "users.ts"), "export const x = 1;\n");
  await fsp.writeFile(join(ctx.cwd, "notes.md"), "hello\n");

  await readFileTool.execute({ paths: ["notes.md"] }, ctx);
  assert.equal(ctx.ruleScope!.matched.size, 0, "an unrelated read fired a scoped rule");

  await readFileTool.execute({ paths: ["src/api/users.ts"] }, ctx);
  assert.ok(ctx.ruleScope!.matched.has("api"), "read_file did not reach the rule scope");
  assert.match(renderRules(rules, ctx.ruleScope!.matched), /Kebab-case/);
});

test("WIRING: writing a file fires the rule scoped to it", async () => {
  // Writes count as working in a folder just as reads do — a rule scoped to `src/api`
  // must apply to a session that is CREATING files there.
  const rules: Rule[] = [
    ALWAYS,
    { name: "api", description: "", body: "Kebab-case routes.", globs: ["src/api/**"] },
  ];
  const ctx = ctxWithRules(rules);
  await fsp.mkdir(join(ctx.cwd, "src", "api"), { recursive: true });

  await writeFileTool.execute({ path: "src/api/orders.ts", content: "export const y = 2;\n" }, ctx);
  assert.ok(ctx.ruleScope!.matched.has("api"), "write_file did not reach the rule scope");
});
