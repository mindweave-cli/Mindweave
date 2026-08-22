/**
 * manifest.ts — what DeepSeek offers, and the numbers that describe it.
 *
 * Everything here is DeepSeek-specific by design: the model list `/model` shows,
 * the reasoning levels `/think` shows, list prices, and the usable context window.
 * A new provider supplies its own version of this file and nothing in core changes.
 *
 * This file is loaded even when the user is running a different provider, so it
 * stays plain data and pure functions. The wire code lives in `client.ts`, which
 * only loads once DeepSeek is actually selected.
 *
 * v1 ships two models: `deepseek-v4-flash` (fast, cheap default) and
 * `deepseek-v4-pro` (stronger). Both are OpenAI-compatible, store 1M tokens, and
 * support Thinking / Non-Thinking modes. The older `deepseek-chat` /
 * `deepseek-reasoner` ids are deprecated and stop working after 2026-07-24.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const FLASH = "deepseek-v4-flash";
export const PRO = "deepseek-v4-pro";
/** The multimodal model, added 2026-08-21. `-exp` is DeepSeek's own suffix: they
 *  ship it as experimental, and the id is theirs, not a label we chose. */
export const VISION = "deepseek-v4-flash-vision-exp";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = FLASH;

/** The models offered by `/model`. First entry is the default. */
export const MODELS: ModelChoice[] = [
  { id: FLASH, label: "DeepSeek V4 Flash", description: "fast & cheap — the default" },
  { id: PRO, label: "DeepSeek V4 Pro", description: "stronger, for harder work" },
  { id: VISION, label: "DeepSeek V4 Flash Vision", description: "reads images — experimental" },
];

/**
 * The effort values DeepSeek's API actually accepts for `reasoning_effort`.
 *
 * The shared `Effort` type is the union of every provider's ladder and includes
 * rungs DeepSeek has never had (`medium`, `xhigh` — those are Anthropic's). Sending
 * one is not a soft failure: it's a value the API does not recognize. So this set
 * is the authority, `normalize` clamps to it, and a test asserts every level we
 * advertise survives that clamp.
 */
const ACCEPTED_EFFORTS = new Set<Effort>(["low", "high", "max"]);

/**
 * The reasoning levels offered by `/think`. DeepSeek V4 exposes thinking as a toggle
 * on the same model id plus a `reasoning_effort` budget, so the whole space is:
 *
 *   Standard (no thinking) · High (thinking, high) · Maximum (thinking, max)
 *
 * Pro's Maximum sends `max`. It previously sent `xhigh`, which DeepSeek does not
 * accept, so that level had never done anything — the rung had leaked in from the
 * shared type when a second provider was added.
 *
 * FLASH HAS A MAXIMUM TIER TOO, and used to be denied one here. The fix that removed
 * `xhigh` also scoped Maximum to Pro, on the assumption that the cheaper model had a
 * shorter ladder. It does not: DeepSeek documents `reasoning_effort` as low/high/max
 * for V4 Flash as well, unscoped by model. Withholding it meant the DEFAULT model —
 * the one most sessions run — silently could not reach its top reasoning setting.
 *
 * The ladder is identical for both, so it is built once. What differs between Flash
 * and Pro is the size of the model underneath, not the settings it accepts.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  const standard: ThinkLevel = { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" };
  // The vision model is offered WITHOUT a reasoning ladder, and the omission is
  // deliberate. DeepSeek's vision guide documents the request shape, the formats and
  // the image budget, and says nothing at all about `reasoning_effort` on this id.
  // This driver has already been bitten by assuming a rung exists: `xhigh` was
  // advertised for a year, is not a value DeepSeek accepts, and so the setting had
  // never once done anything. Advertising a level that may be rejected is worse than
  // withholding one that turns out to work, because only the first breaks a request.
  // Add the other two the moment the docs name them.
  if (model === VISION) return [standard];
  return [
    standard,
    { label: "High", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

// DeepSeek list prices (USD / 1M). Cache hits are ~1/10 of misses — the whole
// reason re-sent context stays cheap. `-pro` is estimated higher; correct it if
// needed. These are best-effort defaults a user can override without a rebuild.
const PRICES: Record<string, ModelPrice> = {
  [FLASH]: { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 },
  [PRO]: { cacheHit: 0.028, cacheMiss: 0.28, output: 0.56 },
  // DeepSeek's price list gives vision exactly Flash's rates, so it is written as the
  // same numbers rather than derived from them: if Flash's estimate is corrected one
  // day, that is a judgment about Flash and should not silently move a second model.
  [VISION]: { cacheHit: 0.014, cacheMiss: 0.14, output: 0.28 },
};
const DEFAULT_PRICE: ModelPrice = PRICES[FLASH]!;

/** Cache-aware list price for a model, falling back to Flash's for unknown ids. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

/**
 * The model's USABLE context window — where retrieval and attention stay reliable,
 * not the raw storage cap. Both models store 1M tokens (native pretraining, not a
 * RoPE-extended stretch), but V4 runs hybrid sparse attention (CSA at 4x KV
 * compression alternating with HCA at 128x), and compression is where accuracy
 * leaks at range.
 *
 * The number that matters for an agent is MULTI-needle retrieval, not single: a
 * coding session recalls many scattered facts (files read, decisions made, which
 * command failed), which is the multi-needle shape. That is also V4's weakest
 * axis — its single-to-multi drop at 1M is the largest in the field.
 *
 * Published V4-Pro figures (NIAH-2 / MRCR):
 *   200K  single 96%   multi-8 84%
 *   256K              multi-8 ~0.82   ← still flat
 *   1M    single 78%   multi-8 41%    ← cliff
 *
 * So Pro anchors at 256K: the top of the demonstrated flat region. Past it the
 * evidence thins to a single bad endpoint, and on BYOK the user pays for every
 * token we let the transcript grow into.
 */
const PRO_WINDOW = 256_000;

/**
 * Flash gets its own, lower value rather than inheriting Pro's curve.
 *
 * Flash is 284B with 13B active against Pro's 1.6T/49B, and there is NO published
 * multi-needle data for it at any length. The one datapoint (100% single-needle
 * NIAH at 435K) is the easy axis and says nothing about the axis we care about.
 * 192K is a deliberate judgment call under absent data: clearly above the old
 * shared 128K, clearly inside Pro's proven-flat region, and revisable the moment
 * someone publishes a Flash multi-needle curve.
 */
const FLASH_WINDOW = 192_000;

export function contextWindow(model: ModelId): number {
  // Vision anchors to Flash. DeepSeek documents the same 1M store for all three and
  // states its pure-text ability is on par with Flash, so the sharp-window judgment
  // made for Flash is the one that applies; inventing a separate number for a model
  // with no published multi-needle curve of its own would be a guess wearing a
  // decimal point.
  return model === PRO ? PRO_WINDOW : FLASH_WINDOW;
}

/**
 * Only the vision model takes image input, and only since 2026-08-21.
 *
 * This used to be absent entirely, with a comment recording that as a fact rather
 * than an oversight. It is now true of exactly one id, so the check is by id and not
 * by provider: pointing an image at Flash or Pro still degrades before anything is
 * sent, which is what core does with a false answer here.
 */
export function acceptsImages(model: ModelId): boolean {
  return model === VISION;
}

/**
 * Coerce a stored or unknown config onto a model this driver actually serves, and
 * keep the reasoning intent valid. DeepSeek accepts three of the five shared effort
 * rungs (`low`, `high`, `max`), so anything else clamps to `high`.
 *
 * No model-scoped step-down any more: both models take the same three rungs, so
 * switching between them preserves the user's reasoning choice instead of quietly
 * demoting it. See thinkLevels for why the old Pro-only Maximum was wrong.
 */
export function normalize(config: ModelConfig): ModelConfig {
  // Three ids now, so this can no longer be "PRO or else FLASH": that shape would
  // have quietly rewritten a vision selection back to Flash, and the user would have
  // watched their chosen model change itself with no message.
  const model: ModelId = config.model === PRO ? PRO : config.model === VISION ? VISION : FLASH;
  // Thinking is forced off on vision for the reason thinkLevels gives none: the flag
  // is undocumented there, and this is the gate that stops a config saved on another
  // model carrying one in.
  const thinking = model === VISION ? false : config.thinking === true;
  // Anything outside DeepSeek's accepted set becomes `high`. That covers a config
  // saved by an older build (which stored `xhigh`) and a rung belonging to another
  // provider. `max` is accepted on BOTH models and is no longer stepped down.
  const effort: Effort = ACCEPTED_EFFORTS.has(config.effort) ? config.effort : "high";
  return { model, thinking, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const deepseekManifest: DriverManifest = {
  id: "deepseek",
  label: "DeepSeek",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  keysUrl: "https://platform.deepseek.com/api_keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  acceptsImages,
  normalize,
};
