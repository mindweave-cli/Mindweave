/**
 * chassisMux.test.ts — code maps across multiple roots: route path queries to the
 * owning root, merge name queries, and rank relevance across roots.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { allChassis, chassisForPath, mergedDefinition, mergedReferences } from "./chassisMux.js";
import { asFileId, makeSymbolId, type Chassis, type SymbolNode } from "../alternator/chassis/types.js";
import { CodeGraph } from "../alternator/chassis/graph.js";
import type { ToolContext } from "./types.js";

function sym(file: string, name: string, line: number): SymbolNode {
  const f = asFileId(file);
  return { id: makeSymbolId(f, name, line), name, kind: "function", file: f, line };
}

function fakeChassis(defs: Record<string, SymbolNode[]>): Chassis {
  return {
    outline: async () => [],
    definition: async (name) => ({ symbols: defs[name] ?? [], confidence: "name-level" }),
    references: async () => ({ refs: [], confidence: "name-level" }),
    dependents: async () => [],
    span: async () => [],
    directorySummary: async () => null,
    diagnostics: async () => [],
    status: () => ({ ready: true, files: 1, symbols: 1, resolvedLanguages: [] }),
  };
}

/** A chassis backed by a real CodeGraph it exposes via graphRef (drives cross-root
 *  ranking, the same path CodeChassis takes). */
function fakeWithGraph(graph: CodeGraph): Chassis {
  return { ...fakeChassis({}), graphRef: () => graph } as Chassis & { graphRef: () => CodeGraph };
}

const ROOT_A = process.platform === "win32" ? "C:\\a" : "/a";
const ROOT_B = process.platform === "win32" ? "C:\\b" : "/b";

function ctxTwo(a: Chassis, b: Chassis): ToolContext {
  return {
    cwd: ROOT_A,
    roots: [ROOT_A, ROOT_B],
    reads: new Map(),
    todos: [],
    chassis: a,
    chassisByRoot: new Map([
      [ROOT_A, a],
      [ROOT_B, b],
    ]),
  };
}

test("allChassis lists every root's map; chassisForPath routes by owner", () => {
  const a = fakeChassis({});
  const b = fakeChassis({});
  const ctx = ctxTwo(a, b);
  assert.equal(allChassis(ctx).length, 2);
  assert.equal(chassisForPath(ctx, join(ROOT_A, "src", "x.ts")), a);
  assert.equal(chassisForPath(ctx, join(ROOT_B, "y.ts")), b);
});

test("mergedDefinition unions hits from both roots", async () => {
  const a = fakeChassis({ foo: [sym(join(ROOT_A, "x.ts"), "foo", 1)] });
  const b = fakeChassis({ foo: [sym(join(ROOT_B, "y.ts"), "foo", 9)] });
  const { symbols } = await mergedDefinition(ctxTwo(a, b), "foo");
  assert.equal(symbols.length, 2);
});

test("a merged list is only 'resolved' when EVERY root resolved it", async () => {
  // One root has a language server, the other is on the tree-sitter tier. The
  // merged list is one list to the reader, so it must not be marked resolved:
  // that is what suppresses the "verify with grep" caveat the name-level half needs.
  const resolvedRoot = fakeChassis({});
  resolvedRoot.definition = async (name) => ({
    symbols: [sym(join(ROOT_A, "x.ts"), name, 1)],
    confidence: "resolved",
  });
  const nameLevelRoot = fakeChassis({ foo: [sym(join(ROOT_B, "y.ts"), "foo", 9)] });

  const mixed = await mergedDefinition(ctxTwo(resolvedRoot, nameLevelRoot), "foo");
  assert.equal(mixed.symbols.length, 2);
  assert.equal(mixed.confidence, "name-level");

  // Both resolved is still resolved — the rule must not just always downgrade.
  const otherResolved = fakeChassis({});
  otherResolved.definition = async (name) => ({
    symbols: [sym(join(ROOT_B, "y.ts"), name, 9)],
    confidence: "resolved",
  });
  const both = await mergedDefinition(ctxTwo(resolvedRoot, otherResolved), "foo");
  assert.equal(both.confidence, "resolved");
});

test("mergedReferences carries the same weakest-wins rule", async () => {
  const resolvedRoot = fakeChassis({});
  resolvedRoot.references = async () => ({
    refs: [{ file: asFileId(join(ROOT_A, "x.ts")), line: 3, confidence: "resolved" as const }],
    confidence: "resolved",
  });
  const nameLevelRoot = fakeChassis({});
  nameLevelRoot.references = async () => ({
    refs: [{ file: asFileId(join(ROOT_B, "y.ts")), line: 4, confidence: "name-level" as const }],
    confidence: "name-level",
  });
  const { refs, confidence } = await mergedReferences(ctxTwo(resolvedRoot, nameLevelRoot), "foo");
  assert.equal(refs.length, 2);
  assert.equal(confidence, "name-level");
});

