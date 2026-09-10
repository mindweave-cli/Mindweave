/**
 * blockHeights.ts — bounding the table of measured block heights.
 *
 * The heights themselves live in a ref inside App; this is the one rule about them
 * worth testing on its own, because getting it wrong is invisible in both directions.
 *
 * The table used to be a WeakMap, which needed no bounding at all: a block dropped past
 * the scrollback cap became unreachable and took its height with it. It is a Map now,
 * keyed by block id, because a resize has to walk every entry to rescale it and a
 * WeakMap cannot be walked. That buys the rescale and inherits a leak: a long session
 * appends blocks forever and nothing would ever remove their heights.
 *
 * Ids are handed out by the reducer in ascending order and never reused, so "older than
 * the oldest block still on screen" is simply a smaller id, and pruning is a threshold
 * rather than a set difference. Kept generous, because the cost of dropping a height
 * that is still wanted is far higher than the cost of keeping one that is not: the block
 * has to be laid out in full again to get it back.
 */

/** How many heights to keep. Comfortably more than the scrollback cap, so pruning can
 *  never reach a block that is still being rendered. */
export const MAX_TRACKED_HEIGHTS = 600;

/** Prune when the table grows past the cap, oldest ids first (in place). */
export function pruneHeights(table: Map<number, unknown>, cap = MAX_TRACKED_HEIGHTS): void {
  if (table.size <= cap) return;
  // Ascending, so the ids removed are the oldest blocks — the ones already dropped past
  // the scrollback cap and therefore never rendered again.
  const ids = [...table.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ids.length - cap; i++) table.delete(ids[i]!);
}

/** A recorded height, and whether it is a measurement or an estimate. */
export interface HeightEntry {
  height: number;
  /** The exact block object the height was taken from. */
  block: unknown;
  /** True when a width change RESCALED this rather than it being measured. */
  scaled?: boolean;
}

/**
 * Whether a block that is about to be laid out still owes a real measurement (pure).
 *
 * Two ways it can. The obvious one is a block that changed — the reducer hands back a
 * new object, so the height recorded against the old one describes different content.
 *
 * The one that was missed for longer is a SCALED entry. A width change multiplies every
 * recorded height by the ratio of the widths, which keeps the scroll arithmetic roughly
 * right without laying the whole scrollback out again. But the entry it leaves behind
 * still points at the same block object, so a check for "did the block change" says no
 * and the estimate is never paid off. It then sizes a spacer in the virtual window
 * forever, and since a paragraph that wrapped to one row does not become 1.4 rows at a
 * narrower width but two, blocks land a row or two from where they belong — text that
 * will not settle, worst where the terminal is narrowest.
 *
 * The entry stays USABLE either way; this only decides whether it is worth re-measuring
 * when the block happens to be rendered. That keeps the cost bounded by what is on
 * screen rather than by the length of the session.
 */
export function needsMeasure(entry: HeightEntry | undefined, block: unknown): boolean {
  if (entry === undefined) return true;
  if (entry.block !== block) return true;
  return entry.scaled === true;
}
