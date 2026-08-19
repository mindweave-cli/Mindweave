/**
 * chassisMux.ts — query the right code map(s) in a multi-root workspace.
 *
 * Each session root has its own chassis (a code map only knows its own files). The
 * code-intelligence tools route through here so they stay correct across roots:
 *   - path queries (outline) hit the chassis that OWNS the file;
 *   - name queries (definition/references) MERGE across every root;
 *   - relevance ranks within each root, then merges by score.
 * Single-root sessions fall straight through to the one chassis — no overhead.
 */
import { isAbsolute, relative } from "node:path";
import type { ToolContext } from "./types.js";
import { asFileId, type Chassis, type Confidence, type Ref, type SymbolNode, type SymbolSpan } from "../alternator/chassis/types.js";
import { CodeGraph, combineGraphs } from "../alternator/chassis/graph.js";

/** Every chassis in play (per-root set, or just the primary). */
export function allChassis(ctx: ToolContext): Chassis[] {
  if (ctx.chassisByRoot && ctx.chassisByRoot.size > 0) return [...ctx.chassisByRoot.values()];
  return ctx.chassis ? [ctx.chassis] : [];
}

/** The chassis whose root contains `abs`, or the primary as a fallback. */
export function chassisForPath(ctx: ToolContext, abs: string): Chassis | undefined {
  if (ctx.chassisByRoot) {
    for (const [root, chassis] of ctx.chassisByRoot) {
      const rel = relative(root, abs);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return chassis;
    }
  }
  return ctx.chassis;
}

/**
 * Confidence for a MERGED list, which is the confidence of its weakest part.
 *
 * The merged list is one list to the reader, and the caveat printed from this value
 * governs all of it. So a root running a language server must not vouch for a root
 * that is on the tree-sitter tier: taking the best there marks name-level entries
 * `resolved` purely by association, and `resolved` is exactly what suppresses the
 * "verify with grep" note those entries need. Each `Ref` still carries its own
 * per-entry confidence for anyone who wants the finer answer.
 */
function mergedConfidence(values: Confidence[]): Confidence {
  return values.every((c) => c === "resolved") && values.length > 0 ? "resolved" : "name-level";
}

/** Where a symbol is defined, merged across every root. */
export async function mergedDefinition(
  ctx: ToolContext,
  name: string,
): Promise<{ symbols: readonly SymbolNode[]; confidence: Confidence }> {
  const list = allChassis(ctx);
  if (list.length === 1) return list[0]!.definition(name);
  const symbols: SymbolNode[] = [];
  const confidences: Confidence[] = [];
  for (const ch of list) {
    const r = await ch.definition(name);
    symbols.push(...r.symbols);
    if (r.symbols.length) confidences.push(r.confidence);
  }
  return { symbols, confidence: mergedConfidence(confidences) };
}

/** Who references a symbol, merged across every root. */
export async function mergedReferences(
  ctx: ToolContext,
  name: string,
): Promise<{ refs: readonly Ref[]; confidence: Confidence }> {
  const list = allChassis(ctx);
  if (list.length === 1) return list[0]!.references(name);
  const refs: Ref[] = [];
  const confidences: Confidence[] = [];
  for (const ch of list) {
    const r = await ch.references(name);
    refs.push(...r.refs);
    if (r.refs.length) confidences.push(r.confidence);
  }
  return { refs, confidence: mergedConfidence(confidences) };
}

/** The span(s) of a named symbol's definition, across every root. A `path` is only
 *  ever inside one root, so passing it naturally narrows the result to that root. */
export async function symbolSpans(
  ctx: ToolContext,
  name: string,
  opts: { path?: string; line?: number } = {},
): Promise<readonly SymbolSpan[]> {
  const list = allChassis(ctx);
  if (list.length === 0) return [];
  if (list.length === 1) return list[0]!.span(name, opts);
  const spans: SymbolSpan[] = [];
  for (const ch of list) spans.push(...(await ch.span(name, opts)));
  return spans;
}

/** A chassis's underlying code graph, if it exposes one (CodeChassis does; the
 *  null/test chassis may not). */
function graphOf(chassis: Chassis): CodeGraph | null {
  const g = (chassis as { graphRef?: () => CodeGraph }).graphRef?.();
  return g instanceof CodeGraph ? g : null;
}

