/**
 * manifest.ts — what xAI offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain data
 * and pure functions. The wire code lives in `client.ts`, a thin binding over the
 * shared OpenAI-compatible layer.
 *
 * The rule to keep in view: `reasoning_effort` is served by ONE model in this
 * lineup. The others are not "reasoning off", they simply have no dial, and sending
 * them one is a parameter they do not accept.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const GROK_46 = "grok-4.6";
export const GROK_45 = "grok-4.5";
export const GROK_43 = "grok-4.3";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = GROK_46;

/** The models offered by `/model`. First entry is this provider's default. */
export const MODELS: ModelChoice[] = [
  { id: GROK_46, label: "Grok 4.6", description: "the current model, strong at code — the default" },
  { id: GROK_45, label: "Grok 4.5", description: "the previous generation" },
  { id: GROK_43, label: "Grok 4.3", description: "the reasoning tier, with a 1M window" },
];

/** Whether a model takes the `reasoning_effort` dial. Only Grok 4.3 does. */
export function takesEffort(model: ModelId): boolean {
  return model === GROK_43;
}

/**
 * The reasoning levels offered by `/think`.
 *
 * xAI's ladder is `none`/`low`/`medium`/`high` — a shorter one than the shared type
 * carries, and notably WITHOUT `xhigh` or `max`. `none` is the off switch rather
 * than a separate flag, the same shape OpenAI uses.
 *
 * The models with no dial get a single level, and that is an honest statement
 * rather than a stub: they reason as they reason, and there is no request to make
 * about it. Offering a switch wired to nothing would be worse.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (takesEffort(model)) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "low" },
      { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "medium" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "high" },
    ];
  }
  return [{ label: "Standard", description: "this model has no reasoning dial", thinking: false, effort: "low" }];
}

/**
 * List prices (USD / 1M tokens).
 *
 * Two caveats. xAI TIERS by prompt size: a request over 200K input tokens bills at
 * DOUBLE these rates, across the whole request rather than the excess. The shared
 * `ModelPrice` shape holds one rate, so these are the base tier — right for ordinary
 * sessions, low for very long ones, which is also why `contextWindow` below sits
 * where it does.
 *
 * Second: only Grok 4.6's figures are confirmed against xAI's own pricing table.
 * The other two are estimates in its neighbourhood and are marked as such — a wrong
 * price shows a wrong estimate, where a wrong model id would fail outright, so the
 * ids were the part worth being certain about.
 */
const PRICES: Record<string, ModelPrice> = {
  [GROK_46]: { cacheHit: 0.5, cacheMiss: 2, output: 6 },
  // Estimated.
  [GROK_45]: { cacheHit: 0.5, cacheMiss: 2, output: 6 },
  // Estimated.
  [GROK_43]: { cacheHit: 0.75, cacheMiss: 3, output: 15 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. These models store 500K (Grok 4.3, 1M), but
 * this is deliberately far below that, and here the reason is billing as much as
 * attention: crossing 200K input DOUBLES the rate on the entire request, so letting
 * a transcript drift past that line silently doubles the cost of every later turn.
 * 128K keeps ordinary sessions well clear of it.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. Core
 * reserves exactly this much room below the window, and `client.ts` sends the same
 * constant, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. xAI serves image understanding, but through
 * the separate `grok-imagine-*` line rather than any model offered here.
 */

/** The effort rungs this provider accepts, weakest first — note the absent top two. */
const EFFORTS: Effort[] = ["low", "medium", "high"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * The result is snapped onto a rung `/think` lists, which is what keeps the request
 * legal: this provider's ladder stops at `high`, so a config carrying `xhigh` or
 * `max` from another provider must not reach the wire.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = takesEffort(model) ? config.thinking === true : false;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "low";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers. Ties
 * break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, because
 * silently spending more of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(model: ModelId, thinking: boolean, effort: Effort): Effort {
  const ladder: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const offered = thinkLevels(model).filter((l) => l.thinking === thinking);
  if (offered.length === 0) return thinkLevels(model)[0]!.effort;
  if (offered.some((l) => l.effort === effort)) return effort;

  const want = ladder.indexOf(effort);
  let best = offered[0]!;
  for (const level of offered) {
    const d = Math.abs(ladder.indexOf(level.effort) - want);
    const bestD = Math.abs(ladder.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && ladder.indexOf(level.effort) < ladder.indexOf(best.effort))) {
      best = level;
    }
  }
  return best.effort;
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const xaiManifest: DriverManifest = {
  id: "xai",
  label: "xAI",
  apiKeyEnv: "XAI_API_KEY",
  keysUrl: "https://console.x.ai/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
