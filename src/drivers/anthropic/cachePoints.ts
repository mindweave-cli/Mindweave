/**
 * cachePoints.ts — where to put Anthropic's cache breakpoints, and why more than one.
 *
 * A breakpoint does not scan the whole conversation for a prior cache entry. It walks
 * backward at most **20 content blocks**, and if it finds nothing in that window it
 * misses — silently, with no error and no signal in the response beyond a
 * `cache_read_input_tokens` of zero that looks exactly like a cold start.
 *
 * That limit is a poor fit for an agentic loop specifically. A round with three
 * parallel tool calls adds three `tool_use` blocks and three `tool_result` blocks; two
 * such rounds and the next request's single breakpoint is already looking past its own
 * window at the entry it needs. The conversation keeps growing, every request keeps
 * paying full price for all of it, and nothing anywhere says so.
 *
 * So a single breakpoint at the stable prefix is not enough. This spreads the available
 * budget backward through the conversation as a LADDER, close enough together that the
 * next request always lands within a window of one of them.
 *
 * Pure and unit-tested, because the failure it prevents is invisible at runtime: there
 * is no observation a live session can make that distinguishes "cache missed because of
 * the lookback window" from "cache missed because this is a new conversation".
 */

/**
 * Content blocks between consecutive breakpoints.
 *
 * 15 rather than 20: the limit is a hard 20, and the next request appends its own
 * blocks before its breakpoint goes looking. Sitting exactly at the limit means any
 * growth at all overshoots it, so the margin is the point.
 */
export const BLOCK_SPACING = 15;

/**
 * Anthropic allows 4 `cache_control` breakpoints per request. One is spent on the
 * system prompt (which also covers the tool definitions ahead of it), leaving three
 * for the conversation.
 */
export const MAX_BREAKPOINTS = 4;
export const MESSAGE_BREAKPOINTS = MAX_BREAKPOINTS - 1;

/**
 * Which message indexes should carry a breakpoint, given each message's block count.
 *
 * Returns indexes in ASCENDING order. The last message is always included: it is the
 * stable-prefix boundary the whole request shape is built around, and the one entry the
 * next request most wants to find.
 *
 * Walking BACKWARD from the end is deliberate. The recent end of the conversation is
 * where the next request will look, so when the budget runs out it should run out at
 * the far end — an unreachable breakpoint deep in history buys nothing.
 */
export function cacheBreakpoints(blockCounts: readonly number[], budget = MESSAGE_BREAKPOINTS): number[] {
  if (blockCounts.length === 0 || budget <= 0) return [];

  const picked: number[] = [blockCounts.length - 1];
  let sinceLast = 0;

  // From the message before the last one, backward. `sinceLast` counts the blocks
  // BETWEEN the previous breakpoint and here, which is exactly the distance the next
  // request's lookback has to cover.
  for (let i = blockCounts.length - 2; i >= 0 && picked.length < budget; i--) {
    sinceLast += Math.max(0, blockCounts[i] ?? 0);
    if (sinceLast >= BLOCK_SPACING) {
      picked.push(i);
      sinceLast = 0;
    }
  }
  return picked.reverse();
}

/**
 * Whether a conversation is long enough for the extra breakpoints to matter.
 *
 * Below the spacing there is only one place a breakpoint can usefully go, and spending
 * the budget anyway would mark blocks a single window already reaches. Cheap to ask,
 * and it keeps short sessions rendering exactly as they did before.
 */
export function needsLadder(blockCounts: readonly number[]): boolean {
  const total = blockCounts.reduce((n, c) => n + Math.max(0, c), 0);
  return total > BLOCK_SPACING;
}
