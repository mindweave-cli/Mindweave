/**
 * revealPace.ts — the tempo the transcript reveals at.
 *
 * A turn's events arrive in bursts, and this once held every block that appeared to a
 * three-second beat so a burst of tool calls did not land at once. The reasoning was
 * about perceived effort: a wait that shows work happening reads as deliberate rather
 * than slow.
 *
 * IT DOES NOT. Used in anger it reads as an animation — words arriving with motion,
 * the chat still moving after the work is done — which is the opposite of the
 * impression it was aiming for. That was always the one thing here no test could
 * settle, and the file said so: change it and re-run. It has now been run.
 *
 * Claude Code paces nothing at all. There is no reveal delay, no typewriter, no gap
 * between a block arriving and being painted, and it is the fastest-feeling terminal
 * agent there is. A tool that is quick should look quick.
 *
 * The mechanism is kept because it still SERIALISES: blocks reveal in order, one pump
 * at a time, and Esc still flushes. Only the wait is gone.
 */

/**
 * The beat, in milliseconds. Zero: content appears when it arrives.
 *
 * Left as a named constant rather than deleted along with the arithmetic, because the
 * question it answers is a real one and a future change here should be a number, not a
 * re-derivation. Anything above zero is visible as animation — that is measured by use,
 * not by a test.
 */
export const REVEAL_GAP_MS = 0;

/** Everything the wait depends on. */
export interface PaceInput {
  now: number;
  /** When the last block was revealed. 0 at the start of a turn. */
  lastRevealAt: number;
  /** Esc was pressed: the user has asked to see the rest now. */
  flush: boolean;
}

/**
 * How long to hold before revealing the next block.
 *
 * Time already spent counts toward the beat, so a model that took four seconds
 * between two tool calls pays nothing here — the rhythm was already right.
 */
export function revealWait({ now, lastRevealAt, flush }: PaceInput): number {
  if (flush) return 0;
  return Math.max(0, REVEAL_GAP_MS - (now - lastRevealAt));
}

/**
 * Whether unsealed narration is waiting, and would actually become a visible block.
 *
 * Streamed text accumulates silently and renders nothing until it seals (whole-block
 * reveal, see transcript.ts), and `toolStart` seals it as part of its own action. So
 * a sentence and the tool row it introduces reach the terminal in the SAME paint,
 * landing together as one clump — the thing the beat exists to prevent, happening in
 * the one place the pacer could not see.
 *
 * Sealing it on its own beat first lets the sentence land alone and be read before
 * the row arrives under it. That is worth a beat only when a block will actually
 * appear, which is why `narrated` is checked here: the narration budget is one line
 * per TURN, so a second sentence seals to nothing (sealAssistant's `suppressed`) and
 * pausing for it would buy an empty three seconds.
 */
export function narrationPending(s: { openAsstId: number | null; raw: string; narrated: boolean }): boolean {
  return s.openAsstId !== null && !s.narrated && s.raw.trim().length > 0;
}
