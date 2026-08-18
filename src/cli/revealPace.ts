/**
 * revealPace.ts — the tempo the transcript reveals at.
 *
 * A turn's events arrive in bursts. The engine can resolve five tool calls in the
 * time it takes to read one row, and painting them as they land drops the whole
 * burst on screen at once. That reads as output being thrown at you rather than as
 * work being done, and the difference is not cosmetic: it is the entire signal the
 * user has for whether the thing is deliberate or careless.
 *
 * So every block that APPEARS waits for the same beat. Not a decay, not a budget,
 * not a catch-up. One constant, start to finish, every turn.
 *
 * WHY UNIFORM, given a shrinking gap would finish sooner. A gap that decays means
 * the tool visibly accelerates as the turn goes on, and an accelerating rhythm reads
 * as rushing — it starts careful and gets bored. A cap is worse still, because the
 * moment it trips is the most visible event in the turn: twenty seconds of composure
 * and then everything dumps. Constant tempo is the whole product here. A metronome
 * is calming precisely because it never changes its mind.
 *
 * WHY THIS IS NOT JUST ADDED LATENCY. Buell and Norton (Management Science, 2011)
 * ran five experiments where people preferred a slower service to an instant one
 * returning identical results, when the wait showed the work happening. The measured
 * mediator was perceived effort producing reciprocity, so the effect only fires when
 * the delay is OCCUPIED — Maister's first principle, and the reason every chatbot
 * study finds bare latency harmful while latency behind a typing indicator is not.
 *
 * Which is the constraint this file lives under, and the reason the number here can
 * be well above the ~1s that the latency literature calls a ceiling. Those studies
 * measure dead time before any output: an empty screen and a spinner. This gap sits
 * BETWEEN blocks that are already arriving, with the previous one still being read
 * and the status line's clock still running. It is occupied time, which is the
 * condition where the effect is positive rather than the one where it is negative.
 *
 * The gap is a MINIMUM SINCE THE LAST REVEAL, never an added sleep. That falls out
 * of one subtraction and it matters more than it looks: at the start of a turn the
 * last reveal was minutes ago, so the first block appears IMMEDIATELY. Dead time
 * stays under Nielsen's one-second flow limit and only occupied time is paced,
 * without needing a special case to say so.
 */

/**
 * The beat, in milliseconds. One number, deliberately alone on its line: it is the
 * only thing here that cannot be settled by reasoning, because whether it reads as
 * considered or as sluggish is a judgement no test can make. Change it and re-run.
 */
export const REVEAL_GAP_MS = 3000;

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
