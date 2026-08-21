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

/**
 * How far below the auto bar to start telling the user context is filling up.
 *
 * A share rather than a fixed number, so it scales with the model the way every other
 * bar here does: 20K of warning is most of a small window's usable transcript and a
 * rounding error on a large one. The point is to give roughly a turn or two of notice,
 * and a turn is proportional to the window.
 */
const WARN_SHARE_OF_AUTO = 0.9;

/**
 * The point at which the user should be told, once, that a compaction is coming.
 *
 * Compaction rewrites the conversation. It is not a failure and it does not need
 * permission, but arriving with no notice is how a user ends up wondering why the
 * model forgot the middle of their session.
 */
export function warnBarFor(autoBar: number): number {
  return Math.round(autoBar * WARN_SHARE_OF_AUTO);
}

/** Autocompact bar for a model, anchored to its driver's numbers. */
export function autoCompactThreshold(model: string): number {
  return autoBarFor(sharpContextWindow(model), summaryReserveFor(model));
}

/** Microcompact bar for a model, anchored to its driver's numbers. */
export function microCompactThreshold(model: string): number {
  return microBarFor(sharpContextWindow(model), summaryReserveFor(model));
}

/**
 * How long a provider's prompt cache is assumed to survive between requests.
 *
 * 60 minutes, and the size matters more than it looks. This was 5 minutes — Anthropic's
 * default ephemeral TTL — on the reasoning that anything past it is certainly gone. That
 * is wrong in the DANGEROUS direction: the number decides when we clear tool bodies, and
 * clearing rewrites the cached prefix. Guess too SHORT and we destroy an entry that was
 * still alive, forcing a full-price rewrite that would never have happened. Guess too
 * long and we merely miss a saving.
 *
 * Five minutes is only Anthropic's default tier. Its 1h tier exists, DeepSeek's context
 * cache persists for hours, and several providers publish nothing at all — so a 5-minute
 * assumption would have been actively wrong on most of the lineup.
 *
 * 60 minutes is the smallest value that is safe everywhere: past an hour no provider in
 * the lineup is documented to still be holding the prefix, so clearing can only be
 * reclaiming something already lost. Being wrong is then free rather than expensive.
 */
export const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.MINDWEAVE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

/**
 * Below this share of the micro bar, a cold cache is not worth compacting for. A
 * session holding almost nothing has almost nothing to save, and clearing tool bodies
 * early costs real detail.
 */
const COLD_COMPACT_FLOOR = 0.5;

/**
 * Whether to microcompact because the provider's cache has gone cold, rather than
 * because context is filling up.
 *
 * The normal gate exists for a specific reason: clearing an old tool body REWRITES the
 * transcript, and the transcript is the cached half of the request, so on a warm cache
 * it trades a cheap cached read for a full prefix rewrite at 1.25x. That is a loss, and
 * it is why microcompaction waits for real pressure.
 *
 * None of that argument survives the cache expiring. Once the gap since the last call
 * exceeds the TTL there is no entry left to invalidate — the next request pays to write
 * the whole prefix no matter what it contains. Clearing stale tool bodies first is then
 * strictly free, and the tokens never have to be paid for again.
 *
 * `lastCallAt` of 0 means no call has been made yet (a fresh session), which is not a
 * cold cache — it is no cache, with nothing yet worth clearing.
 */
export function cacheLikelyCold(
  lastCallAt: number,
  now: number,
  used: number,
  microBar: number,
  ttlMs: number = CACHE_TTL_MS,
): boolean {
  if (lastCallAt <= 0) return false;
  if (now - lastCallAt <= ttlMs) return false;
  return used >= microBar * COLD_COMPACT_FLOOR;
}

/**
 * Fraction of the prefix a clear must reclaim to pay for the cache rewrite it causes.
 *
 * Clearing an old tool body is not free on a warm cache: it changes the cached prefix,
 * so the next request rewrites what remains at 1.25x instead of reading it at 0.1x.
 * Writing out the break-even, with P the prefix and R what the clear reclaims:
 *
 *     keep for N steps   = N * 0.1P
 *     clear, then N-1    = 1.25(P-R) + (N-1) * 0.1(P-R)
 *     break-even at       N = 11.5 * (P - R) / R
 *
 * which is brutal at small R: reclaiming 10% of a 40K prefix needs ~103 further steps
 * to pay off, 50% needs ~12, and 75% needs ~4. A turn does not have 103 steps. So a
 * clear that frees a little is not a small win, it is a real loss, and the only clears
 * worth making on a warm cache are the big ones.
 *
 * 0.35 sits where the break-even (~21 steps) is still optimistic but no longer absurd,
 * and it is deliberately a FRACTION rather than a token count: the thing being paid for
 * is proportional to the prefix, so the threshold has to be too.
 */
const CLEAR_WORTH_FRACTION = 0.35;

/**
 * Whether a proposed microcompaction should actually be committed.
 *
 * Three ways to say yes, and they are different kinds of reason:
 *
 *  - `cold`: the provider's cache has expired, so there is no entry to invalidate and
 *    the rewrite is free. Any reclaim at all is profit.
 *  - `urgent`: context is close enough to the autocompact bar that FITTING matters more
 *    than cost. A request that does not fit cannot be sent at any price.
 *  - otherwise: only when the clear reclaims enough of the prefix to out-earn the cache
 *    write it forces, per the arithmetic above.
 *
 * Pure, because the alternative is discovering the economics were wrong from a bill.
 */
export function clearIsWorthIt(opts: {
  /** Tokens the request carries now. */
  before: number;
  /** Tokens it would carry after the proposed clear. */
  after: number;
  /** Whether the provider's cache has already expired. */
  cold: boolean;
  /** The autocompact bar — past it, a summarization pass happens anyway. */
  autoBar: number;
}): boolean {
  const reclaimed = opts.before - opts.after;
  if (reclaimed <= 0) return false;
  if (opts.cold) return true;
  // Close to the bar, fitting beats saving: clearing here is what defers a far more
  // expensive summarization, and a prompt that overflows is not a cost question.
  if (opts.before >= opts.autoBar * 0.9) return true;
  return reclaimed >= opts.before * CLEAR_WORTH_FRACTION;
}
