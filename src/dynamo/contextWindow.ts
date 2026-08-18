/**
 * contextWindow.ts — model-anchored compaction thresholds (pure).
 *
 * Compaction is anchored to the model's REAL context window rather than a fixed
 * number: reserve room for the summary output plus a safety buffer, then compact
 * when usage crosses what's left. That keeps the thresholds correct per model, and
 * automatically right when a stronger or longer model is wired in, instead of a
 * single hard-coded ceiling.
 *
 * The window itself is the driver's answer, and it is each model's SHARP window —
 * the span where attention stays reliable — not its storage maximum. A model that
 * stores 1M tokens can still degrade from tool-noise dilution long before that, and
 * on BYOK every token is the user's money, so compacting to the sharp window is
 * both more accurate and cheaper.
 *
 * THE DIVISION OF LABOUR. A driver reports facts it can measure — its window, and
 * the ceiling it puts on a buffered call. This module owns every decision made on
 * top of them: how much headroom to leave, where the bars land, and the invariant
 * that ties them together. A driver returning its own bars would be a decision in
 * the driver, which is the line this project doesn't cross; see BOUNDARY.md.
 */
import { manifestForModel } from "../drivers/registry.js";

/**
 * Reserve used when a driver declares no buffered ceiling of its own — it sends no
 * `max_tokens` and lets the provider's default apply, as the DeepSeek driver does.
 * With no number to reserve, core keeps the conservative one it has always used.
 */
const DEFAULT_SUMMARY_RESERVE = 20_000;

/** Headroom below the window so one turn's growth can't blow past it. */
const TURN_HEADROOM = 13_000;

/** Floor for the auto bar, so a tiny window still leaves a usable transcript. */
const MIN_AUTO_BAR = 20_000;

/** Share of the window micro-compaction aims at on an ordinary model. */
const MICRO_SHARE = 0.3;

/**
 * Absolute cap on the micro bar.
 *
 * A flat share of the window stops making sense once windows get large: at 30% a
 * 500K model would carry 150K of stale tool output on every turn, which is not a
 * lean working set on any model and is the user's money on BYOK. The purpose of
 * micro-compaction is a lean working set, and that purpose is absolute rather than
 * proportional, so the share gets a ceiling.
 *
 * 96K is a judgment call under absent data, chosen so it sits ABOVE the share for
 * every window we ship today (30% of 256K is 76.8K) and only engages past ~320K.
 * That is deliberate: no shipped model changes behaviour, and the cap exists for
 * the longer models it was written for. Revisit it if anyone measures where a
 * working set actually stops paying for itself.
 */
const MICRO_CEILING = 96_000;

/**
 * Hard guard: micro never rises above this share of the auto bar.
 *
 * The two bars are computed from different inputs, so a large enough reserve on a
 * small enough window could otherwise push micro past auto and invert them —
 * clearing tool bodies at the same moment we summarize. This keeps the ordering a
 * property of the arithmetic rather than something the numbers happen to satisfy.
 */
const MICRO_MAX_SHARE_OF_AUTO = 0.6;

/**
 * The part of the prompt that is NOT the transcript, measured rather than assumed:
 * what the provider said the whole prompt was, minus what we measured the transcript
 * to be on the way out. That remainder is the system prompt, every tool schema, the
 * working-set block, the relevance map, todos and the governor — none of which the
 * bars could see when they counted only the transcript.
 *
 * Clamped at zero. The transcript estimator is deliberately conservative and can read
 * HIGHER than the provider's real count; a negative overhead would then push the bars
 * later, which is precisely the failure this removes.
 */
export function measuredOverhead(promptTokens: number, transcriptTokens: number): number {
  return Math.max(0, promptTokens - transcriptTokens);
}

/** The model's usable context window, as its driver reports it. */
/**
 * What one compaction pass did, in tokens.
 *
 * Lives here rather than in the CLI because it is a fact about context accounting, not
 * about a terminal: the engine produces it and any client (a future server, a different
 * UI) renders it however it likes. The CLI's job is only to draw bars from it.
 */
export interface CompactionReport {
  /** Context in use before the pass. */
  before: number;
  /** Context in use after it. */
  after: number;
  /** The model's full context window. */
  window: number;
}

export function sharpContextWindow(model: string): number {
  return manifestForModel(model).contextWindow(model);
}

/**
 * How much room to keep free for a compaction summary, as the model's driver
 * reports it. A driver that declares no buffered ceiling falls back to core's
 * conservative default rather than reserving nothing.
 */
export function summaryReserveFor(model: string): number {
  const declared = manifestForModel(model).bufferedOutputTokens?.(model);
  return declared !== undefined && declared > 0 ? declared : DEFAULT_SUMMARY_RESERVE;
}

/**
 * Autocompact bar: summarize once the transcript crosses
 * (window − summary reserve − turn headroom). For a 256K window reserving 20K
 * that's 223K.
 */
export function autoBarFor(window: number, summaryReserve = DEFAULT_SUMMARY_RESERVE): number {
  return Math.max(MIN_AUTO_BAR, window - summaryReserve - TURN_HEADROOM);
}

/**
 * Microcompact bar: clear old tool-result bodies well before the autocompact bar,
 * so the working set stays lean continuously rather than only at the summary point.
 * A share of the window, capped in absolute terms, and always kept clear of the
 * auto bar.
 */
export function microBarFor(window: number, summaryReserve = DEFAULT_SUMMARY_RESERVE): number {
  return Math.min(
    Math.round(window * MICRO_SHARE),
    MICRO_CEILING,
    Math.round(autoBarFor(window, summaryReserve) * MICRO_MAX_SHARE_OF_AUTO),
  );
}

/** Autocompact bar for a model, anchored to its driver's numbers. */
export function autoCompactThreshold(model: string): number {
  return autoBarFor(sharpContextWindow(model), summaryReserveFor(model));
}

/** Microcompact bar for a model, anchored to its driver's numbers. */
export function microCompactThreshold(model: string): number {
  return microBarFor(sharpContextWindow(model), summaryReserveFor(model));
}
