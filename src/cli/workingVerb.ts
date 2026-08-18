/**
 * workingVerb.ts — the word the status line shows while a turn runs.
 *
 * `Working…` on every turn of every session is a label, not a signal: it says the
 * thing the spinner already says. A word that differs per turn tells you at a glance
 * that this is a NEW turn and not the last one still going — which is the one thing
 * the line is there to answer.
 *
 * Held for the whole turn, derived from the turn's start time rather than stored, so
 * the once-a-second re-render cannot make it flicker between words. Pure, so the
 * choice is testable without a clock.
 */

/** Present participles only, and none that claim progress the harness cannot see
 *  ("Almost done", "Finishing") — those would be a guess dressed as a status. */
const VERBS = [
  "Scampering",
  "Tinkering",
  "Rummaging",
  "Untangling",
  "Puzzling",
  "Burrowing",
  "Whirring",
  "Pondering",
  "Noodling",
  "Sifting",
  "Weaving",
  "Chewing",
];

/** The verb for the turn that began at `startedAt`. Stable for that whole turn. */
export function workingVerb(startedAt: number): string {
  // Milliseconds, not seconds: two turns started in the same second still differ.
  const i = Math.abs(Math.floor(startedAt)) % VERBS.length;
  return VERBS[i]!;
}

/** Exposed for the test — the pool must stay free of progress claims. */
export const WORKING_VERBS: readonly string[] = VERBS;
