/**
 * liveMeter.ts — the token figure that moves while a turn is working.
 *
 * Modelled directly on Claude Code's spinner counter, because a previous attempt to
 * improve on it was worse in a way worth recording.
 *
 * THE QUANTITY IS OUTPUT ONLY, estimated from the characters that have streamed back.
 * Not billed tokens, not the prompt, not the context. The previous version showed a
 * running BILLED total so the live figure and the end-of-turn receipt would agree, and
 * the reasoning was sound but the result was not: input is not a thing that ARRIVES, so
 * the moment a call went out the figure leapt by the size of the prompt and then sat
 * still. A number that jumps 20,000 and freezes is not a progress indicator, and worse,
 * it invited exactly the question it should answer — what were those tokens spent on? —
 * about tokens that were mostly served from cache and barely cost anything.
 *
 * What streams is what moves. Output is the only quantity that grows continuously while
 * a turn runs, so it is the only honest thing to animate. The receipt afterwards is
 * where the turn's real cost belongs, and the two are different measurements on purpose.
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
