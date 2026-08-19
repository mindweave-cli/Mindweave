/**
 * spend.ts — accumulate what a session actually costs, turn by turn.
 *
 * `summarizeTask` answers "what did THIS turn cost". This answers "what has this
 * session cost", which is the question a user actually asks and the one nothing could
 * answer before: the per-turn figure was rendered into the status line and discarded,
 * so a finished session left no record of its own spend anywhere on the machine.
 *
 * Pure, so the arithmetic that will be shown as money is unit-tested rather than
 * trusted. Every field is a sum except `estimated`, which is sticky in the pessimistic
 * direction — see below.
 */
import type { SessionSpend } from "../memory/types.js";
import type { TaskUsage } from "./pricing.js";

/** A session that has run nothing yet. */
export function emptySpend(): SessionSpend {
  return {
    billed: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    turns: 0,
    estimated: false,
  };
}

/**
 * Fold one finished turn into the session's running total.
 *
 * `estimated` is STICKY: once any turn had to be inferred, the session total is partly
 * inferred forever, and a later well-reported turn does not make the earlier guess
 * true. Erring toward "approximate" is the only honest direction — the alternative is a
 * figure that silently claims more precision than it has, which is the exact defect
 * that made a normal turn read 147K.
 */
export function addTurn(prev: SessionSpend, turn: TaskUsage): SessionSpend {
  return {
    billed: prev.billed + turn.billedTokens,
    cacheHit: prev.cacheHit + turn.cacheHitTokens,
    cacheMiss: prev.cacheMiss + turn.cacheMissTokens,
    cacheWrite: prev.cacheWrite + turn.cacheWriteTokens,
    output: prev.output + turn.outputTokens,
    costUsd: prev.costUsd + turn.costUsd,
    turns: prev.turns + 1,
    estimated: prev.estimated || turn.estimated,
  };
}

/**
 * Share of input served from cache, 0–100.
 *
 * Derived rather than stored, because a stored percentage of two moving sums goes stale
 * the moment either one changes. Meaningless with no input at all, which reads as 0.
 */
export function cachePct(spend: SessionSpend): number {
  const input = spend.cacheHit + spend.cacheMiss;
  return input > 0 ? Math.round((spend.cacheHit / input) * 100) : 0;
}
