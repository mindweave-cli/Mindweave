/**
 * manifest.ts — what OpenAI offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code (and the SDK) live in `client.ts`, which
 * only loads once a GPT model is actually selected.
 *
 * v1 ships the GPT-5.6 family — Sol, Terra and Luna. They are one model at three
 * price/latency points rather than three different surfaces: identical context
 * window, identical output ceiling, identical reasoning ladder. So unlike the
 * Anthropic manifest, which has to carry a table of per-model wire rules, this one
 * needs a single set of facts and a price row per model.
 *
 * Older GPT tiers (5.5, 5.4, 4.1, the o-series) are deliberately not offered. They
 * are still served, but they bring older request surfaces with different reasoning
 * support, which is a second wire path to carry for models the current family
 * already covers more cheaply.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const SOL = "gpt-5.6-sol";
export const TERRA = "gpt-5.6-terra";
export const LUNA = "gpt-5.6-luna";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = TERRA;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to OpenAI.
 *
 * Terra leads because it is the balanced tier — Sol is roughly 2.5x its rate and
 * Luna a tenth of it, so Terra is the one that is rarely the wrong answer.
 */
export const MODELS: ModelChoice[] = [
  { id: TERRA, label: "GPT-5.6 Terra", description: "balanced intelligence and cost — the default" },
  { id: SOL, label: "GPT-5.6 Sol", description: "the frontier tier, for the hardest problems" },
  { id: LUNA, label: "GPT-5.6 Luna", description: "cheap and quick, for high-volume work" },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * OpenAI expresses reasoning as a single `effort` rung with `none` as its off
 * switch, rather than a separate on/off flag plus a budget. That maps onto the
 * shared shape cleanly: `thinking: false` becomes `none` on the wire, and the four
 * thinking rungs are sent as themselves. All three models take the same ladder.
 *
 * The provider also accepts `minimal` between `none` and `low`. It is not offered:
 * it would be a fifth rung whose difference from `low` no user could predict, and
 * the ladder is more useful short.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "medium" },
    { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "high" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

/**
 * List prices (USD / 1M tokens). Cached input bills at a tenth of fresh input,
 * which is what keeps a re-sent conversation cheap.
 */
const PRICES: Record<string, ModelPrice> = {
  [SOL]: { cacheHit: 0.5, cacheMiss: 5, output: 30 },
  [TERRA]: { cacheHit: 0.2, cacheMiss: 2, output: 12 },
  [LUNA]: { cacheHit: 0.02, cacheMiss: 0.2, output: 1.2 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. All three STORE 1.05M tokens (922K of it
 * input), but this is deliberately the sharp window rather than the storage cap:
 * on BYOK every token in the window is the user's money on every turn, so
 * anchoring compaction at 1M would mean carrying an enormous prompt long after it
 * stopped earning its cost. Same reasoning, and the same number, as Anthropic's.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call.
 *
 * All three models accept 128K output, but a non-streaming request that runs that
 * long risks an HTTP timeout, so the buffered path — core's small internal calls,
 * like a compaction summary — is capped far lower. `client.ts` sends this value and
 * `dynamo/contextWindow.ts` reserves it; one exported constant means the request
 * and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 16_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** The effort rungs this provider accepts, weakest first. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Every model in this family takes image input alongside text. */
export function acceptsImages(_model: ModelId): boolean {
  return true;
}

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * There is no per-model rule to enforce here — the family shares one ladder, so an
 * unknown model id falls back and an unknown effort clamps, and that is all. The
 * result is then snapped onto a rung `/think` actually lists, so a config carried
 * in from another provider by `/model` cannot leave the user on a setting the menu
 * has no tick beside.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = config.thinking === true;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers.
 *
 * Ties break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, never
 * the dearer one, because silently spending more of the user's money than the level
 * they were on is the worse of the two ways to be wrong.
 */
function snapToOfferedRung(model: ModelId, thinking: boolean, effort: Effort): Effort {
  const offered = thinkLevels(model).filter((l) => l.thinking === thinking);
  if (offered.length === 0) return effort;
  if (offered.some((l) => l.effort === effort)) return effort;

  const want = EFFORTS.indexOf(effort);
  let best = offered[0]!;
  for (const level of offered) {
    const d = Math.abs(EFFORTS.indexOf(level.effort) - want);
    const bestD = Math.abs(EFFORTS.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && EFFORTS.indexOf(level.effort) < EFFORTS.indexOf(best.effort))) {
      best = level;
    }
  }
  return best.effort;
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const openaiManifest: DriverManifest = {
  id: "openai",
  label: "OpenAI",
  apiKeyEnv: "OPENAI_API_KEY",
  keysUrl: "https://platform.openai.com/api-keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  normalize,
};
