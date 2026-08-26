/**
 * scope.ts — which glob-scoped rules this session has activated.
 *
 * A rule may carry `globs`, meaning "apply this once the work heads that way". The
 * question is when that gets decided.
 *
 * It used to be decided AT RENDER: every model call rebuilt the set of every path the
 * session had ever touched, relativized each one, and matched every scoped rule's globs
 * against all of them. That is O(paths x rules) on every step of every turn, against a
 * path set that only ever grew — so the cost of a rule the user set once climbed for as
 * long as the session lasted.
 *
 * It is now decided AT ACCESS, which is the only shape that stays correct
 * (`getManagedAndUserConditionalRules(targetPath, processedPaths)` resolves conditional
 * rules for the ONE file being touched, with a processed-set for dedup). When a path is
 * read or written we test it once, against only the rules that have not already fired,
 * and remember the NAMES that matched. Rendering is then a set lookup per rule.
 *
 * Remembering the match rather than the path is what makes this durable. A compaction
 * clears the read ledger because the contents it described are gone from the screen —
 * but "this session has worked in src/api" is not a fact about the screen, and a name
 * already in `matched` is never removed. The earlier fix for that bug carried a second
 * copy of every path forward to re-derive the same answer; this needs no carry at all.
 */
import { relative } from "node:path";
import { anyPathMatches } from "./glob.js";
import type { Rule } from "./types.js";

/**
 * How many project-relative paths are kept for RE-EVALUATION.
 *
 * Only used when the rule set itself changes (the user edits a rule file, or the model
 * writes a new one) and rules that never ran must be judged against work already done.
 * Matching for rules that have already fired does not consult this at all — those names
 * are sticky — so overflowing the cap can only mean a NEWLY ADDED scoped rule misses
 * paths touched long ago. It still fires on the next matching path.
 *
 * Bounded because this is the one structure here that would otherwise grow with session
 * length, which is exactly the property being removed.
 */
const MAX_REMEMBERED_PATHS = 2_000;

export interface RuleScope {
  /**
   * Names of glob-scoped rules that have fired. Sticky for the session: a rule that
   * became relevant does not stop being relevant because the transcript was rewritten.
   */
  matched: Set<string>;
  /** Project-relative POSIX paths, capped — see MAX_REMEMBERED_PATHS. Insertion-ordered. */
  paths: Set<string>;
}

export function createRuleScope(): RuleScope {
  return { matched: new Set(), paths: new Set() };
}

/** Project-relative POSIX form, computed ONCE per path instead of once per render. */
function relPosix(root: string, absPath: string): string {
  return relative(root, absPath).split("\\").join("/");
}

/**
 * Record that the session touched `absPath`, and fire any scoped rule it matches.
 *
 * Cheap by construction: a rule already in `matched` is skipped, so the work per path
 * shrinks as rules fire, and a project with no scoped rules does no matching at all.
 */
export function noteScopePath(
  scope: RuleScope,
  rules: readonly Rule[],
  root: string,
  absPath: string,
): void {
  const rel = relPosix(root, absPath);
  if (scope.paths.size < MAX_REMEMBERED_PATHS) scope.paths.add(rel);
  const one = [rel];
  for (const rule of rules) {
    if (!rule.globs || rule.globs.length === 0) continue; // always-on: nothing to decide
    if (scope.matched.has(rule.name)) continue; // already fired — never re-tested
    if (anyPathMatches(one, rule.globs)) scope.matched.add(rule.name);
  }
}

/**
 * Re-judge every remembered path against the CURRENT rule set.
 *
 * Called when the rules themselves change — a reload from disk, or the model writing a
 * new one — because a rule that did not exist when a path was touched never got its
 * chance. This is the only O(paths x rules) pass left, and it runs on rule changes
 * rather than on every model call.
 *
 * Additive: it never un-matches. A rule deleted from disk simply stops being rendered,
 * because rendering filters by the live rule list, not by this set.
 */
export function rescope(scope: RuleScope, rules: readonly Rule[]): void {
  const paths = [...scope.paths];
  if (paths.length === 0) return;
  for (const rule of rules) {
    if (!rule.globs || rule.globs.length === 0) continue;
    if (scope.matched.has(rule.name)) continue;
    if (anyPathMatches(paths, rule.globs)) scope.matched.add(rule.name);
  }
}
