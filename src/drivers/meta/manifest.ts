/**
 * manifest.ts — what Meta offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer — Meta's Model API serves an explicitly
 * "OpenAI-compatible" `/chat/completions` surface at `https://api.meta.ai/v1`.
 *
 * Meta retired its hosted Llama API in July 2026; Llama itself is not served here
 * at all any more. Muse Spark, a closed model from the newly formed Meta
 * Superintelligence Labs, is the only thing on this endpoint now. 1.1 is
 * deliberately not offered: 1.3 and 1.2 both supersede it at the same price, the
 * same superseded-tier rule every other driver here follows. 1.2 stays because a
 * saved config naming it must keep working and because its rates are unchanged.
 *
 * THE CONTRIBUTOR TIER. This is the one fact in this file worth reading twice. A
 * `-contributor` id is not a cheaper flag on the same model — it is a SEPARATE
 * model id whose price is roughly 12x lower than Standard in exchange for
 * Meta training on your prompts and completions. Both directions are real: the
 * discount is real, and so is the data use. Neither is the default. See `MODELS`
 * below for how that trade-off is worded to the person choosing it.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const MUSE_SPARK_13 = "muse-spark-1.3";
export const MUSE_SPARK_13_CONTRIBUTOR = "muse-spark-1.3-contributor";
export const MUSE_SPARK_12 = "muse-spark-1.2";
export const MUSE_SPARK_12_CONTRIBUTOR = "muse-spark-1.2-contributor";

/** The model used when nothing is saved and no env override is set. Standard
 *  tier, so no one is opted into sharing their data with anything but a choice. */
export const DEFAULT_MODEL = MUSE_SPARK_13;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Meta.
 *
 * The contributor entry's description states the trade-off in the picker itself,
 * not just in a comment nobody choosing it will read: what it costs, and what you
 * give up for that price. A model this consequential does not get a euphemism.
 */
export const MODELS: ModelChoice[] = [
  { id: MUSE_SPARK_13, label: "Muse Spark 1.3", description: "the default — your prompts stay yours" },
  {
    id: MUSE_SPARK_13_CONTRIBUTOR,
    label: "Muse Spark 1.3 (Contributor)",
    description: "~12x cheaper input — in exchange, Meta trains on your prompts and completions",
  },
  { id: MUSE_SPARK_12, label: "Muse Spark 1.2", description: "the previous Spark, at the same rate" },
  {
    id: MUSE_SPARK_12_CONTRIBUTOR,
    label: "Muse Spark 1.2 (Contributor)",
    description: "the previous Spark, on the same data-for-price trade",
  },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * Muse Spark has no reasoning parameter at all in Meta's own API reference — not a
 * toggle, not an effort rung, nothing. One honest level, same shape as a model with
 * no dial elsewhere in this codebase (see xAI's non-`GROK_43` entries): offering a
 * switch wired to nothing would be worse than not offering one.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [{ label: "Standard", description: "this model has no reasoning dial", thinking: false, effort: "high" }];
}

/**
 * List prices (USD / 1M tokens). The contributor discount is not a rounding
 * difference — cached input alone is 75x cheaper, because the trade is data, not a
 * volume deal.
 */
const PRICES: Record<string, ModelPrice> = {
  // 1.3 ships at 1.2's rates, on both tiers.
  [MUSE_SPARK_13]: { cacheHit: 0.15, cacheMiss: 1.25, output: 4.25 },
  [MUSE_SPARK_13_CONTRIBUTOR]: { cacheHit: 0.002, cacheMiss: 0.1, output: 0.2 },
  [MUSE_SPARK_12]: { cacheHit: 0.15, cacheMiss: 1.25, output: 4.25 },
  [MUSE_SPARK_12_CONTRIBUTOR]: { cacheHit: 0.002, cacheMiss: 0.1, output: 0.2 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Every model here stores 1,048,576 tokens with no
 * documented billing cliff inside it, unlike xAI's or Gemini's Pro tier — but on
 * BYOK every token in the window is still the user's money on every turn, so this
 * is the same 200K ceiling used elsewhere once a window is chosen for cost rather
 * than for what the provider will hold.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
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
 * Vision is deliberately NOT declared. Meta's own docs describe Muse Spark as
 * multimodal (text, image, video, audio, PDF input), but the shared
 * OpenAI-compatible wire layer (`../openaiCompat/wire.ts`) never renders
 * `ChatMessage.images` into the request body — only the two SDK-backed drivers
 * (Anthropic, OpenAI) do that today. Declaring it here would mean core attaching
 * bytes this path silently never sends.
 */

/** The one effort rung this provider's single level uses. There is no ladder to
 *  clamp against — a model with no dial has nothing for `/think` to choose. */
const EFFORTS: Effort[] = ["high"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * There is no per-model rule to enforce: no model here has a reasoning dial, so
 * thinking is always false and the effort is inert filler, present only because
 * the shared `ModelConfig` shape requires one.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
  return { model, thinking: false, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const metaManifest: DriverManifest = {
  id: "meta",
  label: "Meta",
  apiKeyEnv: "MODEL_API_KEY",
  keysUrl: "https://developer.meta.com/ai/products/meta-model-api/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
