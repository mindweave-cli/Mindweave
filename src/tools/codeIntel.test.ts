/**
 * codeIntel.test.ts — the chassis-backed tools (outline/definition/references).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outlineTool, definitionTool, referencesTool } from "./codeIntel.js";
import { grepDef } from "./grep.js";
import { readSymbolTool } from "./readSymbol.js";
import { CodeChassis } from "../alternator/chassis/index.js";
import { CodeGraph } from "../alternator/chassis/graph.js";
import { asFileId, makeSymbolId } from "../alternator/chassis/types.js";
import type { ToolContext } from "./types.js";

async function projectCtx(): Promise<ToolContext> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ci-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper() { return 1; }\n");
  await fs.writeFile(
    join(dir, "src/main.ts"),
    "import { helper } from './util';\nfunction run() { return helper(); }\nrun();\n",
  );
  const chassis = new CodeChassis(dir, { lsp: false }); // tree-sitter tier only
  await chassis.build();
  return { cwd: dir, reads: new Map(), chassis, todos: [] };
}

test("outline tool shows a file's symbols", async () => {
  const ctx = await projectCtx();
  const r = await outlineTool.execute({ path: "src/main.ts" }, ctx);
  assert.match(r.output, /run/);
  assert.match(r.output, /src\/main\.ts/);
});

test("definition tool locates a symbol with a confidence caveat", async () => {
  const ctx = await projectCtx();
  const r = await definitionTool.execute({ name: "helper" }, ctx);
  assert.match(r.output, /src\/util\.ts:1/);
  assert.match(r.output, /name-level match/); // tree-sitter tier
});

test("references tool finds use sites", async () => {
  const ctx = await projectCtx();
  const r = await referencesTool.execute({ name: "helper" }, ctx);
  assert.match(r.output, /src\/main\.ts:/);
});

test("tools degrade gracefully when no chassis is present", async () => {
  const ctx: ToolContext = { cwd: "/p", reads: new Map(), todos: [] };
  const r = await definitionTool.execute({ name: "x" }, ctx);
  assert.match(r.output, /isn't available/);
});

// ── relevant's description makes three specific claims ────────────────────────
// It is the one code tool that answers "what matters here" rather than "where is X",
// and the old wording never said so, which is why it went unused. The claims that
// replaced it are structural facts about the ranking, so they are pinned to it.

test("a reference in a comment or a string is NOT matched, as promised", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-refs-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/def.ts"), "export function target() { return 1; }\n");
  await fs.writeFile(
    join(dir, "src/use.ts"),
    "import { target } from './def';\n// target is mentioned here in a comment\nconst s = 'target';\nexport const r = target();\n",
  );
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  const ctx = { cwd: dir, reads: new Map(), chassis, todos: [] } as unknown as ToolContext;

  const r = await referencesTool.execute({ name: "target" }, ctx);
  // The real call on line 4 must be found; the comment (2) and string (3) must not be.
  assert.match(r.output, /use\.ts:4/, "the actual call site must be found");
  assert.doesNotMatch(r.output, /use\.ts:2\b/, "a comment mention is not a reference");
  assert.doesNotMatch(r.output, /use\.ts:3\b/, "a string mention is not a reference");
  assert.match(referencesTool.description, /comment or a string is never a match/i);
});

test("without a language server the answer is name-level, and says so", async () => {
  const ctx = await projectCtx(); // built with { lsp: false }
  const r = await referencesTool.execute({ name: "helper" }, ctx);
  assert.match(r.output, /name-level match/i, "the caveat must reach the model");
  assert.match(referencesTool.description, /a different symbol that happens to share the name/i);
});

test("references' stated cap is the real one", () => {
  assert.match(referencesTool.description, /up to 100/i);
});

test("grep's pointer at references does not overclaim", () => {
  // grep used to say references would not match "an unrelated file", which is false
  // at name-level. The two descriptions have to agree about what references can do.
  assert.doesNotMatch(grepDef.description, /unrelated file/i);
  assert.match(grepDef.description, /name-level answer/i);
});

// ── definition: every claim, pinned to observed behaviour ────────────────────

async function ambiguousCtx(): Promise<ToolContext> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-def-"));
  await fs.writeFile(join(dir, "a.ts"), "export function handle(x: number): string { return String(x); }\n");
  await fs.writeFile(join(dir, "b.ts"), "export function handle(y: boolean): number { return 1; }\n");
  await fs.writeFile(join(dir, "s.css"), ".hero-stats { color: red; }\n");
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  return { cwd: dir, reads: new Map(), chassis, todos: [] } as unknown as ToolContext;
}

test("an ambiguous name returns EVERY definition, not a best guess", async () => {
  // The old description promised "the exact file:line". A model believing that takes
  // the first row and edits the wrong file.
  const ctx = await ambiguousCtx();
  const r = await definitionTool.execute({ name: "handle" }, ctx);
  assert.match(r.output, /a\.ts:1/);
  assert.match(r.output, /b\.ts:1/, "both definitions must be shown");
  assert.match(definitionTool.description, /EVERY definition rather than/i);
  assert.doesNotMatch(definitionTool.description, /the exact file:line/i);
});

test("definition returns the declaration, which is why a read is often unnecessary", async () => {
  const ctx = await ambiguousCtx();
  const r = await definitionTool.execute({ name: "handle" }, ctx);
  assert.match(r.output, /x: number/, "the declaration itself must come back, not just a location");
  assert.match(definitionTool.description, /PLUS the declaration itself/i);
});

test("definition covers CSS, as the description claims", async () => {
  const ctx = await ambiguousCtx();
  const r = await definitionTool.execute({ name: "hero-stats" }, ctx);
  assert.match(r.output, /s\.css:1/, "a CSS class must resolve to its rule");
});

test("definition reports name-level certainty without a language server", async () => {
  const ctx = await ambiguousCtx();
  const r = await definitionTool.execute({ name: "handle" }, ctx);
  assert.match(r.output, /name-level match/i);
  assert.match(definitionTool.description, /otherwise a NAME match/i);
});

// ── outline + read_symbol: the claims that change what the model does ─────────

test("outline of a DIRECTORY leads with a rollup, which is why you point it at folders", async () => {
  const ctx = await projectCtx();
  const r = await outlineTool.execute({ path: "src" }, ctx);
  assert.match(r.output, /\bfiles?\b.*\bsymbols?\b/i, "the rollup line must be present");
  assert.match(outlineTool.description, /you get a rollup first/i);
});

test("outline's stated directory cap is the real one", () => {
  // Silent truncation is the failure: 40 files shown out of 200, and nothing says so.
  assert.match(outlineTool.description, /at most 40 files/i);
});

test("read_symbol does NOT guess an ambiguous name, it lists the candidates", async () => {
  const ctx = await ambiguousCtx();
  const r = await readSymbolTool.execute({ name: "handle" }, ctx);
  assert.match(r.output, /defined in several files/i);
  assert.match(r.output, /a\.ts/);
  assert.match(r.output, /b\.ts/);
  assert.match(readSymbolTool.description, /it does NOT guess/i);
});

test("read_symbol satisfies the read-before-edit gate, as it now claims", async () => {
  const ctx = await ambiguousCtx();
  const before = ctx.reads.size;
  await readSymbolTool.execute({ name: "handle", path: "a.ts" }, ctx);
  assert.ok(ctx.reads.size > before, "the read must be recorded, or an edit would be refused");
  assert.match(readSymbolTool.description, /COUNTS AS READING THE FILE/i);
});

test("read_symbol's stated line cap is the real one", () => {
  assert.match(readSymbolTool.description, /after 400 lines/i);
});

test("a truncated directory outline SAYS it is a sample, in the reply itself", async () => {
  // The description warns a cap exists, but a model reading one reply cannot tell
  // whether THIS answer hit it. Silent truncation looks like completeness.
  const dir = mkdtempSync(join(tmpdir(), "mindweave-cap-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  for (let i = 0; i < 45; i++) {
    await fs.writeFile(join(dir, "src", `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
  }
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  const ctx: ToolContext = { cwd: dir, reads: new Map(), chassis, todos: [] };

  const r = await outlineTool.execute({ path: "src" }, ctx);
  assert.match(r.output, /outlined 40 of 45 files/, "must state what it left out");
  assert.match(r.output, /sample/i);
});

test("an un-truncated outline does NOT claim to be a sample", async () => {
  const ctx = await projectCtx();
  const r = await outlineTool.execute({ path: "src" }, ctx);
  assert.doesNotMatch(r.output, /is a sample/i);
});

test("outline applies the same search exclusions as grep and glob", async () => {
  // outline reads file CONTENTS to build its answer, so it was the discovery tool
  // that most needed the exclusion and the one not applying it.
  const dir = mkdtempSync(join(tmpdir(), "mindweave-excl-"));
  await fs.writeFile(join(dir, "app.ts"), "export function keep() { return 1; }\n");
  await fs.mkdir(join(dir, ".claude"), { recursive: true });
  await fs.writeFile(join(dir, ".claude", "agent.ts"), "export function secretAgentThing() {}\n");
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  const ctx: ToolContext = { cwd: dir, reads: new Map(), chassis, todos: [] };

  const r = await outlineTool.execute({ path: "." }, ctx);
  assert.match(r.output, /keep/);
  assert.doesNotMatch(r.output, /secretAgentThing/, "excluded path was outlined");
});

test("the code GRAPH never indexes excluded paths, so no query can surface them", async () => {
  // Indexing is the source. If an excluded file reaches the graph, then definition,
  // references, relevant and outline's rollup can all surface it, each of which
  // would otherwise be refused by read_file/grep/glob.
  const dir = mkdtempSync(join(tmpdir(), "mindweave-graph-excl-"));
  await fs.writeFile(join(dir, "app.ts"), "export function keep() { return 1; }\n");
  await fs.mkdir(join(dir, ".claude"), { recursive: true });
  await fs.writeFile(join(dir, ".claude", "agent.ts"), "export function hiddenAgentFn() {}\n");
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();

  assert.equal((await chassis.definition("keep")).symbols.length, 1);
  assert.equal(
    (await chassis.definition("hiddenAgentFn")).symbols.length,
    0,
    "another agent's file reached the code graph",
  );
});
