/**
 * costView.ts — render a session's spend as something a person can act on.
 *
 * The figure that matters is what the provider BILLS, which is not the number an agent
 * loop makes it easy to show. Two traps this deliberately avoids:
 *
 *  1. Summing each call's reported total counts the cached prefix once per tool round.
 *     A five-step turn over a 25K context reads ~150K that way, which is what made a
 *     routine turn look like a runaway one. `billed` counts every token once.
 *  2. A cached read is ~1/10 the price of fresh input, and on some providers a cache
 *     WRITE is 1.25x it. A raw token count hides both, so two sessions with identical
 *     totals can differ several-fold in cost. The money line is the honest summary.
 *
 * Pure: takes a spend record, returns lines. No I/O, no formatting of things it was not
 * given — a display that computes is a display that can disagree with the engine.
 */
import type { SessionSpend } from "../memory/types.js";
import { formatTokens, formatCost } from "../dynamo/pricing.js";
import { cachePct } from "../dynamo/spend.js";

/**
 * Lines describing what this session has cost, most useful first.
 *
 * `estimated` is surfaced rather than buried: when no call reported a cache split, the
 * split is inferred and the number is a floor, not a measurement. Presenting an inferred
 * figure with the authority of a measured one is the defect that started this whole
 * thread — see `TaskUsage.estimated`.
 */
export function costLines(spend: SessionSpend | undefined, model: string): string[] {
  if (!spend || spend.turns === 0) {
    return ["Nothing spent yet this session."];
  }
  const approx = spend.estimated ? "~" : "";
  const pct = cachePct(spend);
  const lines = [
    `**${formatCost(spend.costUsd)}** over ${spend.turns} turn${spend.turns === 1 ? "" : "s"} on \`${model}\``,
    "",
    `- Billed tokens: ${approx}${formatTokens(spend.billed)}  (fresh input + output, each counted once)`,
    `- Served from cache: ${formatTokens(spend.cacheHit)}  (${pct}% of all input)`,
    `- Fresh input: ${formatTokens(spend.cacheMiss)}`,
  ];
  // Only when the provider distinguishes it — a zero here would read as "no writes"
  // when it usually means "this provider never told us".
  if (spend.cacheWrite > 0) {
    lines.push(`- ...of which written to cache: ${formatTokens(spend.cacheWrite)}  (billed above fresh rate)`);
  }
  lines.push(`- Output: ${formatTokens(spend.output)}`);
  if (spend.estimated) {
    lines.push(
      "",
      "> This provider does not report which input came from its cache, so the split is " +
        "inferred and the cost is a FLOOR, not a measurement. Your provider's own billing " +
        "page is authoritative.",
    );
  } else {
    lines.push("", "> Estimated from list prices. Your provider's billing page is authoritative.");
  }
  return lines;
}
