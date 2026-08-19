/**
 * chassis.test.ts — the pure graph core (no tree-sitter/LSP needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Redirect home so the on-disk chassis cache writes to a throwaway dir, not ~/.mindweave.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

import { CodeGraph, nestOutline } from "./graph.js";
import { CodeChassis, collectLspReferences } from "./index.js";
import { asFileId, makeSymbolId, type FileId, type SymbolNode } from "./types.js";

function def(graph: CodeGraph, file: FileId, name: string, line = 1): void {
  const node: SymbolNode = { id: makeSymbolId(file, name, line), name, kind: "function", file, line };
  graph.addSymbol(node);
}

/** A hub symbol referenced by three modules, plus an unreferenced leaf. */
function sampleGraph(): { g: CodeGraph; hub: FileId; leaf: FileId; a: FileId } {
  const g = new CodeGraph();
  const hub = asFileId("/p/hub.ts");
  const leaf = asFileId("/p/leaf.ts");
  const a = asFileId("/p/a.ts");
  const b = asFileId("/p/b.ts");
  const c = asFileId("/p/c.ts");
  def(g, hub, "hub");
  def(g, leaf, "leaf");
  for (const f of [a, b, c]) {
    def(g, f, `sym_${f}`);
    g.addRef("hub", { file: f, line: 2, confidence: "name-level" });
  }
  return { g, hub, leaf, a };
}

test("definition / references resolve by name", () => {
  const { g } = sampleGraph();
  const d = g.definition("hub");
  assert.equal(d.symbols.length, 1);
  assert.equal(d.symbols[0].file, "/p/hub.ts");
  const r = g.references("hub");
  assert.equal(r.refs.length, 3);
});

test("confidence is name-level until the files are LSP-resolved", () => {
  const { g, hub } = sampleGraph();
  assert.equal(g.definition("hub").confidence, "name-level");
  g.markResolved(hub);
  assert.equal(g.definition("hub").confidence, "resolved"); // hub.ts now resolved
  // references span a/b/c (not resolved) → still name-level
  assert.equal(g.references("hub").confidence, "name-level");
});


test("clearFile removes a file's symbols and refs (for re-parsing)", () => {
  const { g, hub } = sampleGraph();
  g.clearFile(hub);
  assert.equal(g.definition("hub").symbols.length, 0);
  assert.equal(g.counts().files, 4); // leaf + a + b + c remain
});

test("outlineForFile lists a file's symbols sorted by line", () => {
  const g = new CodeGraph();
  const f = asFileId("/p/x.ts");
  def(g, f, "second", 20);
  def(g, f, "first", 5);
  const outline = g.outlineForFile(f);
  assert.deepEqual(outline.map((o) => o.name), ["first", "second"]);
});

test("nestOutline nests symbols by span containment", () => {
  const f = asFileId("/p/c.ts");
  const sym = (name: string, line: number, endLine: number, doc?: string): SymbolNode => ({
    id: makeSymbolId(f, name, line), name, kind: "method", file: f, line, endLine, doc,
  });
  // A class spanning 1..10, with two methods inside, and a free function after.
  const tree = nestOutline([
    sym("Box", 1, 10, "A box."),
    sym("bump", 3, 5),
    sym("reset", 6, 8),
    sym("helper", 12, 14),
  ]);
  assert.deepEqual(tree.map((e) => e.name), ["Box", "helper"]);
  assert.equal(tree[0]!.doc, "A box.");
  assert.deepEqual((tree[0]!.children ?? []).map((c) => c.name), ["bump", "reset"]);
  assert.equal(tree[1]!.children, undefined); // helper is a leaf
});

test("nestOutline treats equal spans as siblings, not infinite nesting", () => {
  const f = asFileId("/p/d.ts");
  const s = (name: string): SymbolNode => ({ id: makeSymbolId(f, name, 1), name, kind: "variable", file: f, line: 1, endLine: 1 });
  const tree = nestOutline([s("a"), s("b")]);
  assert.equal(tree.length, 2);
});

test("CodeChassis builds from a real project and answers queries end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-chassis-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper() { return 1; }\n");
  await fs.writeFile(
    join(dir, "src/main.ts"),
    "import { helper } from './util';\nfunction run() { return helper(); }\nrun();\n",
  );
  const ch = new CodeChassis(dir, { lsp: false }); // tree-sitter tier only (deterministic)
  await ch.build();

  assert.ok(ch.status().ready);
  assert.ok(ch.status().symbols >= 2);

  const def = await ch.definition("helper");
  assert.equal(def.symbols.length, 1);
  assert.match(def.symbols[0].file, /util\.ts$/);
  assert.equal(def.confidence, "name-level"); // tree-sitter tier

  const refs = await ch.references("helper");
  assert.ok(refs.refs.length >= 1, "helper should be referenced from main.ts");

  const outline = await ch.outline(join(dir, "src/main.ts"));
  assert.ok(outline.some((o) => o.name === "run"));

  // span() bounds a symbol's full definition (tree-sitter tier → name-level).
  const spans = await ch.span("helper");
  assert.equal(spans.length, 1);
  assert.match(spans[0].file, /util\.ts$/);
  assert.equal(spans[0].start, 1);
  assert.equal(spans[0].end, 1); // single-line function
  assert.equal(spans[0].confidence, "name-level");
});

test("CodeChassis outline nests a method under its class and captures docs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-outline-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(
    join(dir, "src/box.ts"),
    [
      "/** A container of one value. */",
      "export class Box {",
      "  /** Increment the value. */",
      "  bump() {",
      "    this.value++;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  const ch = new CodeChassis(dir, { lsp: false });
  await ch.build();

  const outline = await ch.outline(join(dir, "src/box.ts"));
  const box = outline.find((o) => o.name === "Box")!;
  assert.ok(box, "Box should be a top-level entry");
  assert.equal(box.doc, "A container of one value.");
  const bump = (box.children ?? []).find((c) => c.name === "bump")!;
  assert.ok(bump, "bump should be nested under Box");
  assert.equal(bump.doc, "Increment the value.");
});

test("CodeChassis records import edges and directory summaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-imports-"));
  await fs.mkdir(join(dir, "src/a"), { recursive: true });
  await fs.mkdir(join(dir, "src/b"), { recursive: true });
  await fs.writeFile(join(dir, "src/a/one.ts"), "export function one() { return 1; }\n");
  await fs.writeFile(
    // TS ESM style: the specifier ends in .js but resolves to the .ts file.
    join(dir, "src/b/two.ts"),
    "import { one } from '../a/one.js';\nexport function two() { return one(); }\n",
  );
  const ch = new CodeChassis(dir, { lsp: false });
  await ch.build();

  const g = ch.graphRef();
  const oneId = asFileId(join(dir, "src/a/one.ts"));
  const twoId = asFileId(join(dir, "src/b/two.ts"));
  // The relative import resolved to an in-repo file → a dependency edge both ways.
  assert.deepEqual(g.dependencies(twoId), [oneId]);
  assert.deepEqual(g.dependents(oneId), [twoId]);

  // A directory rollup: counts + folder deps (b depends on the a/ folder).
  const summary = await ch.directorySummary(join(dir, "src/b"));
  assert.ok(summary, "summary for src/b");
  assert.equal(summary!.files, 1);
  assert.ok(summary!.symbols >= 1);
  assert.ok(summary!.dependsOn.some((d) => d.endsWith("/src/a")), `deps: ${summary!.dependsOn.join(",")}`);
});

test("cache: a second chassis warm-starts from disk without rebuilding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-cache-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper() { return 1; }\n");

  const a = new CodeChassis(dir, { lsp: false });
  await a.build();
  assert.equal(await a.saveToCache(), true);

  const b = new CodeChassis(dir, { lsp: false });
  assert.equal(await b.loadFromCache(), true); // restored, no build()
  assert.ok(b.status().ready);
  assert.equal((await b.definition("helper")).symbols.length, 1);
});

test("refresh re-indexes changed files and drops deleted ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-refresh-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "src/a.ts"), "export function one() {}\n");
  await fs.writeFile(join(dir, "src/b.ts"), "export function two() {}\n");

  const ch = new CodeChassis(dir, { lsp: false });
  await ch.build();
  assert.equal((await ch.definition("one")).symbols.length, 1);

  // Edit a.ts (size changes → re-indexed).
  await fs.writeFile(join(dir, "src/a.ts"), "export function oneRenamed() {}\nexport function extra() {}\n");
  await ch.refresh();
  assert.equal((await ch.definition("one")).symbols.length, 0, "old symbol gone");
  assert.equal((await ch.definition("oneRenamed")).symbols.length, 1, "new symbol indexed");
  assert.equal((await ch.definition("extra")).symbols.length, 1);

  // Delete b.ts → its symbols drop on the next refresh.
  await fs.rm(join(dir, "src/b.ts"));
  await ch.refresh();
  assert.equal((await ch.definition("two")).symbols.length, 0, "deleted file's symbols removed");
});

test("LSP references cover every definition of the name, not just the first", async () => {
  // Two classes both define `render`; each has its own caller. Asking only the
  // first definition returns half the answer while still claiming `resolved`.
  const hits = [
    { file: "/p/panel.ts", line: 10, character: 2 },
    { file: "/p/chart.ts", line: 20, character: 2 },
  ];
  const byDef: Record<string, { file: string; line: number }[]> = {
    "/p/panel.ts": [{ file: "/p/usesPanel.ts", line: 5 }],
    "/p/chart.ts": [{ file: "/p/usesChart.ts", line: 7 }],
  };
  const refs = await collectLspReferences(hits, async (f) => byDef[f] ?? []);
  const files = refs.map((r) => String(r.file)).sort();
  assert.deepEqual(files, ["/p/usesChart.ts", "/p/usesPanel.ts"]);
  assert.ok(refs.every((r) => r.confidence === "resolved"));
});

test("a call site shared by two definitions is reported once", async () => {
  const hits = [
    { file: "/p/a.ts", line: 1, character: 0 },
    { file: "/p/b.ts", line: 1, character: 0 },
  ];
  // An overload pair: both definitions resolve to the same call site.
  const refs = await collectLspReferences(hits, async () => [{ file: "/p/caller.ts", line: 9 }]);
  assert.equal(refs.length, 1);
});
