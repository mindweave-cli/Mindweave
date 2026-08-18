/**
 * groupReveal.ts — the pure decision for HOW to reveal a NEW discovery group
 * (a burst of file reads folding into one "● Read N files" row).
 *
 * Revealing a group's opening call the instant it happens meant it showed up
 * bare — "Reading 2 files…" with nothing under it — then visibly grew into its
 * finished shape once the reads resolved. The reference design never shows
 * that transient state at all: every block in it is already resolved.
 *
 * So a NEW group is held — not dispatched — until it's SETTLED: the model has
 * moved on to something else, detected by a later, non-group action already
 * queued behind its opening call. At that point the whole burst reveals at
 * once, fully resolved — header and complete list together, never a
 * transition. There is deliberately no time-based fallback that shows partial
 * progress after a grace period: between two SEQUENTIAL reads in a real turn
 * there's a full model round-trip (seconds, not the single-digit milliseconds
 * a local file read takes), so any short grace elapses almost every time and
 * the group ends up shown live-updating anyway — exactly the bug this file
 * exists to avoid. The hold can't get stuck forever either way: every turn
 * ends with a `finishReply` action that goes through the same queue, which
 * counts as "not a group member" and settles any group still open.
 */

/** Whether an action is part of an in-progress group's burst — a further
 *  grouped call opening, or any tool's end resolving. */
export function isGroupMember(a: { type: string; group?: boolean }): boolean {
  return (a.type === "toolStart" && a.group === true) || a.type === "toolEnd";
}

/** Has the model already moved past this group? True once something that
 *  ISN'T part of the burst has queued up behind its opening call. */
export function groupSettled(queueAfterFront: readonly { type: string; group?: boolean }[]): boolean {
  return queueAfterFront.some((a) => !isGroupMember(a));
}

/**
 * Whether a STANDALONE tool call may be shown yet: only once its own result is
 * queued behind it, so the row arrives already carrying its diff/output instead
 * of appearing as a bare `Update(home.html)` that grows a body a beat later.
 *
 * Same principle as the group hold above, and the same absence of a timer. The
 * caller releases the hold when the stream ends (no further event can arrive) or
 * when the user flushes with Esc.
 */
export function resultQueued(toolId: string, queue: readonly { type: string; toolId?: string }[]): boolean {
  return queue.some((a) => a.type === "toolEnd" && a.toolId === toolId);
}

export type GroupRevealPlan = "flush" | "hold";

/** Decide how to reveal a new group's opening call: settled (or flushing
 *  outright, Esc) → "flush" the whole burst at once; otherwise "hold" — there
 *  is no partial/progress state, see the file header for why. */
export function planGroupReveal(settled: boolean, flushing: boolean): GroupRevealPlan {
  return settled || flushing ? "flush" : "hold";
}
