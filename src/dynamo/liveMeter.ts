/**
 * liveMeter.ts — the token figure that moves while a turn is working.
 *
 * Shaped by how the best terminal agents do it, and by a previous attempt here that was
 * worse in a way worth recording.
 *
 * THE QUANTITY IS OUTPUT ONLY, estimated from the characters that have streamed back, and
 * accumulated across the whole task (reset only at task start). It is the task's OWN work.
 * Not the prompt, not the context, not a billed total: the conversation is re-sent on every
 * tool round, so a running billed figure counts the whole session's context once per round
 * and reports the session, not the task — the very thing the display must not do.
 *
 * What streams is what moves. Output is the only quantity that grows continuously while a
 * turn runs, so it is the only honest thing to animate; input does not "arrive". How full
 * the context is — the last prompt's size, which drives compaction — is a separate measure,
 * not this one.
 *
 * THE COUNTER IS EASED. Deltas arrive in lumps — a provider may deliver a whole sentence
 * in one chunk — so a counter that renders the raw total ticks in visible jerks. The
 * displayed value chases the real one a step at a time on the render clock, moving
 * faster the further behind it is, so it reads as counting rather than as stuttering.
 * It always converges: the step is never smaller than the gap's own growth for the
 * lumps a stream actually produces, and it is clamped so it can never overshoot.
 */

/** Characters per token. Deliberately the crude ratio rather than a tokenizer: this is a
 *  moving indicator, and being 10% off is invisible where being slow is not. */
const CHARS_PER_TOKEN = 4;

/** The meter's whole state. Plain data, so the reducers are testable without a UI. */
export interface MeterState {
  /** Characters of model output actually received this turn. */
  chars: number;
  /** Characters the counter has caught up to. Trails `chars`, never exceeds it. */
  shownChars: number;
}

export function meterReset(): MeterState {
  return { chars: 0, shownChars: 0 };
}

/** `count` more characters of model output have streamed in. */
export function meterDelta(s: MeterState, count: number): MeterState {
  return count > 0 ? { ...s, chars: s.chars + count } : s;
}

/**
 * Advance the displayed counter one render frame toward the real total.
 *
 * The three bands are the shape that reads as smooth: a near-caught-up counter creeps
 * so the last few characters do not snap into place, a moderate gap closes
 * proportionally so it never crawls behind a steady stream, and a large gap moves at a
 * flat ceiling so a big lump is absorbed over a handful of frames instead of one.
 */
export function meterTick(s: MeterState): MeterState {
  const gap = s.chars - s.shownChars;
  if (gap <= 0) return s;
  const step = gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50;
  return { ...s, shownChars: Math.min(s.shownChars + step, s.chars) };
}

/** The figure to render: estimated output tokens, as far as the counter has caught up. */
export function meterValue(s: MeterState): number {
  return Math.round(s.shownChars / CHARS_PER_TOKEN);
}

/** Has the counter finished catching up? Lets the UI stop ticking when nothing moves. */
export function meterSettled(s: MeterState): boolean {
  return s.shownChars >= s.chars;
}
