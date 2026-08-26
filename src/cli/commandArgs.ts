/**
 * commandArgs.ts — turning what someone typed after a command into a choice.
 *
 * `/model`, `/think` and `/compact` all took an argument and threw it away without a
 * word. Naming a model after `/model` opened the picker as if you had typed nothing,
 * which reads as the app not having heard you — and is worse than an error, because an
 * error tells you to try something else and silence tells you nothing.
 *
 * Claude Code accepts an argument on all three (`[model]`,
 * `[low|medium|high|max|auto]`, `<optional custom summarization instructions>`), so
 * anyone arriving from it will type them.
 *
 * Nothing here knows any provider's lineup: the candidates are handed in by the caller,
 * which reads them from the registry. That is the rule for core code, and it is also
 * what makes this testable without a key.
 *
 * The matching is deliberately forgiving in a bounded way: exact id, then exact label,
 * then a UNIQUE prefix, then a UNIQUE substring. Never a "closest guess" — picking a
 * model or a reasoning budget is a decision with a cost attached, and quietly choosing
 * the nearest thing to a typo is how you end up billed for the wrong one. Ambiguity
 * and misses both come back as a message naming the real options.
 */

export interface Candidate {
  /** Machine name, e.g. a model id. Optional — `/think` levels have only a label. */
  id?: string;
  /** What the picker shows, e.g. a model's display name or "Thinking". */
  label: string;
}

export type Resolution =
  | { kind: "match"; index: number }
  /** Nothing matched, or too much did. `message` is ready to show. */
  | { kind: "error"; message: string };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** "a, b or c" — a list a person reads, not a machine dump. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * Which candidate the typed argument means.
 *
 * `what` names the thing being chosen, so the message reads as a sentence rather than
 * as a template ("No model called…", "No reasoning level called…").
 */
export function resolveChoice(arg: string, candidates: readonly Candidate[], what: string): Resolution {
  const wanted = norm(arg);
  if (!wanted) return { kind: "error", message: `Which ${what}?` };

  const names = candidates.map((c) => c.label);

  // Exact wins outright, and is checked against BOTH the id and the label — the id is
  // what a script or a copied command line carries, the label is what the picker shows.
  const exact = candidates.findIndex((c) => norm(c.label) === wanted || (c.id !== undefined && norm(c.id) === wanted));
  if (exact >= 0) return { kind: "match", index: exact };

  const starts = matchesFor(candidates, (c) => startsWith(c, wanted));
  if (starts.length === 1) return { kind: "match", index: starts[0]! };
  if (starts.length > 1) return { kind: "error", message: ambiguous(arg, starts.map((i) => names[i]!)) };

  const contains = matchesFor(candidates, (c) => includes(c, wanted));
  if (contains.length === 1) return { kind: "match", index: contains[0]! };
  if (contains.length > 1) return { kind: "error", message: ambiguous(arg, contains.map((i) => names[i]!)) };

  return {
    kind: "error",
    message: `No ${what} called "${arg.trim()}". Available: ${list(names)}.`,
  };
}

function matchesFor(candidates: readonly Candidate[], pred: (c: Candidate) => boolean): number[] {
  const out: number[] = [];
  candidates.forEach((c, i) => {
    if (pred(c)) out.push(i);
  });
  return out;
}

function startsWith(c: Candidate, wanted: string): boolean {
  return norm(c.label).startsWith(wanted) || (c.id !== undefined && norm(c.id).startsWith(wanted));
}

function includes(c: Candidate, wanted: string): boolean {
  return norm(c.label).includes(wanted) || (c.id !== undefined && norm(c.id).includes(wanted));
}

function ambiguous(arg: string, matched: readonly string[]): string {
  return `"${arg.trim()}" matches ${list(matched)}. Which one?`;
}
