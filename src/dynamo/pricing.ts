/**
 * pricing.ts — turn raw token usage into what a task actually means and costs.
 *
 * The status meter used to sum every model call's `total_tokens`. In an agent loop
 * each step re-sends the whole growing conversation, so that sum counts the same
 * (mostly cached) context once per step — which is why every multi-step task looked
 * like ~700K tokens regardless of its real size or cost. This module computes the
 * numbers that actually mean something instead:
 *   - ctx     — the size of the LAST call's prompt = how full the context window is.
 *   - cost    — cache-aware USD, since cached input is ~1/10 the price of fresh input.
 *   - cache % — how much of the input was served from the provider's prompt cache.
 *
 * Pure (no I/O beyond reading an env override) so it is trivially unit-tested. The
 * per-model rates come from whichever driver serves that model, so this math stays
 * provider-agnostic. Prices are estimates a user can override, so the figure is
 * honest about being approximate.
 */
import { manifestForModel } from "../drivers/registry.js";
import type { ModelPrice, Usage } from "../drivers/types.js";

export type { ModelPrice };

/**
 * The price for a model id. A `MINDWEAVE_PRICE="hit,miss,out"` env override wins for
 * every model (handy for correcting an estimate without a rebuild); otherwise the
 * owning driver's rate table answers.
 */
export function priceFor(modelId?: string): ModelPrice {
  const override = parseEnvPrice(process.env.MINDWEAVE_PRICE);
  if (override) return override;
  return manifestForModel(modelId ?? "").price(modelId ?? "");
}

/** Parse `MINDWEAVE_PRICE="hit,miss,out"` into a ModelPrice, or null if unset/invalid. */
function parseEnvPrice(raw: string | undefined): ModelPrice | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { cacheHit: parts[0]!, cacheMiss: parts[1]!, output: parts[2]! };
}

/** What a finished task amounts to, derived from each call's reported usage. */
export interface TaskUsage {
  /**
   * The turn's REAL token cost: unique input the model had to read, plus everything
   * it generated. This is the number to show a human.
   *
   * It is deliberately NOT `totalTokens`. A turn re-sends its whole prompt on every
   * tool round, so summing per-call totals counts the same text once per step: a
   * five-step turn over a 30K context reports ~150K, and the figure climbs with tool
   * use rather than with work done. Cache HITS are exactly those re-reads — the
   * tokens were already counted as a miss the first time they were sent — so adding
   * misses and output counts every token precisely once.
   *
   * Concretely, over two steps of a 30K conversation that grows by a 1K tool result:
   * misses are 30K then 1K, hits are 0 then 29K. `billedTokens` is 31K plus output,
   * which is the unique text that existed. `totalTokens` would say 60K.
   */
  billedTokens: number;
  /** Sum of every call's reported total. Kept because it is what the provider's own
   *  dashboard shows (it bills cache reads too, just cheaply), but it inflates with
   *  tool rounds — see `billedTokens`, which is what the UI displays. */
  totalTokens: number;
  /** Current context-window occupancy = the last call's prompt size. NOT a sum. */
  ctxTokens: number;
  /** Input served from cache, summed across the task's calls. */
  cacheHitTokens: number;
  /** Fresh input, summed (inclusive of cache writes). */
  cacheMissTokens: number;
  /** The part of `cacheMissTokens` that was also written to the cache, summed. Priced
   *  at the write rate, which is higher than plain input on providers that charge for
   *  storing as well as processing. */
  cacheWriteTokens: number;
  /** Generated tokens, summed. */
  outputTokens: number;
  /** Share of input (0–100) that came from cache. */
  cachePct: number;
  /** Estimated, cache-aware cost in USD (computed but not shown for now). */
  costUsd: number;
  /**
   * True when NO call reported a cache split, so the figures above are inferred
   * rather than measured.
   *
   * This is not a nicety. Some providers cache and simply do not say so — Gemini's
   * OpenAI-compatible endpoint returns only `prompt_tokens`/`completion_tokens`/
   * `total_tokens`, with no `prompt_tokens_details.cached_tokens`, while Gemini 2.5
   * caches implicitly all the same. Treating "reported nothing" as "cached nothing"
   * charged the full prompt again on every tool round, so a five-step turn over a 25K
   * context read ~150K and looked like the model had run wild. It had not; the meter
   * had. When this flag is set the UI must present the number as approximate.
   */
  estimated: boolean;
}

/**
 * Fold a task's per-call usage samples into the meaningful summary above. `ctx` is
 * the LAST sample's prompt (the live window size), while hit/miss/output are summed
 * because those are the tokens actually billed. If a provider doesn't report the
 * cache split (hit and miss both 0 but a prompt exists), the whole prompt is treated
 * as a cache miss — a safe over-estimate, never an under-estimate. Returns null when
 * there's nothing to summarize.
 */
export function summarizeTask(samples: Usage[], modelId?: string): TaskUsage | null {
  if (samples.length === 0) return null;
  const price = priceFor(modelId);
  let hit = 0;
  let miss = 0;
  let out = 0;
  let total = 0;
  // Did ANY call tell us what it served from cache? One that did is enough: it proves
  // the provider reports the split, so a later zero is a real zero rather than silence.
  let reported = false;
  // The largest prompt any single call sent. Within a turn the prompt only grows —
  // the system prompt is fixed, messages append, and the volatile tail is replaced
  // rather than accumulated — so the biggest one is a close read on how much distinct
  // text existed, where SUMMING them counts the stable prefix once per step.
  let maxPrompt = 0;
  let writes = 0;
  for (const s of samples) {
    writes += s.cacheWriteTokens ?? 0;
    if (s.cacheHitTokens > 0 || s.cacheMissTokens > 0) reported = true;
    hit += s.cacheHitTokens;
    miss += s.cacheMissTokens;
    out += s.completionTokens;
    total += s.totalTokens;
    if (s.promptTokens > maxPrompt) maxPrompt = s.promptTokens;
  }
  // Writes are a SLICE of misses, so a fallback that rewrites `miss` must drop them
  // too — otherwise the estimate charges tokens the estimate itself invented.
  if (!reported && maxPrompt > 0) {
    writes = 0;
    // Nothing was reported, so nothing is known. Charge the distinct prompt ONCE and
    // say the figure is estimated, rather than charging it once per step and saying
    // nothing. This is a floor: the volatile tail (the working-set block especially)
    // genuinely is re-sent uncached each step, and that is not counted here. A floor
    // labelled as an estimate is honest; an inflated number presented as exact is not.
    miss = maxPrompt;
    hit = 0;
  }
  const ctxTokens = samples[samples.length - 1]!.promptTokens;
  const totalIn = hit + miss;
  const cachePct = totalIn > 0 ? Math.round((hit / totalIn) * 100) : 0;
  // Three input rates, not two. `writes` is a subset of `miss`, so the plain-input
  // rate applies only to what is left after the written slice is charged separately —
  // adding them would double-count the same tokens.
  const writeRate = price.cacheWrite ?? price.cacheMiss;
  const plainMiss = Math.max(0, miss - writes);
  const costUsd =
    (hit * price.cacheHit + plainMiss * price.cacheMiss + writes * writeRate + out * price.output) / 1_000_000;
  return {
    // Misses + output: every token counted exactly once. See the field's own note
    // for why this is not `total`.
    billedTokens: miss + out,
    totalTokens: total,
    ctxTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cacheWriteTokens: writes,
    outputTokens: out,
    cachePct,
    costUsd,
    estimated: !reported,
  };
}

/** Optional per-task ceilings. 0 disables a limit. */
export interface TaskLimits {
  maxUsd: number;
  maxSeconds: number;
}

/**
 * A short reason string if a task has hit its cost or time ceiling, else null.
 * Pure — the engine reads env into `limits` and passes the running usage + elapsed
 * time. A 0 limit is disabled. Cost is checked before time so the message names the
 * more actionable cause first.
 */
export function taskLimitReason(usage: TaskUsage | null, elapsedMs: number, limits: TaskLimits): string | null {
  if (limits.maxUsd > 0 && usage && usage.costUsd >= limits.maxUsd) {
    return `cost ceiling of ${formatCost(limits.maxUsd)} for one task (about ${formatCost(usage.costUsd)} spent)`;
  }
  if (limits.maxSeconds > 0 && elapsedMs / 1000 >= limits.maxSeconds) {
    return `time ceiling of ${limits.maxSeconds}s for one task`;
  }
  return null;
}

/** A compact token count: 8123 → "8.1K", 56000 → "56K", 540 → "540". */
export function formatTokens(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** An estimated-cost string: "<$0.001" for tiny, "~$0.018" under a dollar, "~$1.42" above. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.001) return "<$0.001";
  return `~$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}
