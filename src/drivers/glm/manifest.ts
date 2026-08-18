/**
 * manifest.ts — what GLM offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer.
 *
 * WHICH GLM THIS IS. Z.ai serves the same models from several endpoints: the
 * international OpenAI-compatible one used here, a China endpoint on a different
 * host, an Anthropic-protocol endpoint, and a separate Coding Plan path. They do
 * not share prices, and the Coding Plan carries models with no published per-token
 * rate at all. This driver targets the international pay-per-token endpoint.
 *
 * v1 ships four models spanning the price ladder, and deliberately not the long
 * tail: Z.ai still serves the whole 4.5 series, several `-air`/`-x` variants and a
 * vision line, all superseded for this purpose by what is listed below. GLM-5.3 is
 * also absent — it exists, but only through the Coding Plan subscription, with no
 * per-token rate to quote, so offering it here would promise billing this driver
 * cannot describe.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const GLM_52 = "glm-5.2";
export const GLM_5 = "glm-5";
export const GLM_47 = "glm-4.7";
export const GLM_47_FLASHX = "glm-4.7-flashx";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = GLM_52;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to GLM.
 *
 * The flagship leads here, unlike the other drivers, because on this provider it is
 * not the expensive choice: GLM-5.2 runs well under half of Claude Sonnet's rate,
 * and it is the only model in the lineup with a reasoning dial. The cheaper rungs
 * are a real ladder below it rather than the sensible middle.
 */
export const MODELS: ModelChoice[] = [
  { id: GLM_52, label: "GLM-5.2", description: "the flagship, with a reasoning dial — the default" },
  { id: GLM_5, label: "GLM-5", description: "the previous flagship, a little cheaper" },
  { id: GLM_47, label: "GLM-4.7", description: "strong value for everyday work" },
  { id: GLM_47_FLASHX, label: "GLM-4.7 FlashX", description: "very cheap and quick, for simple work" },
];

/**
 * Whether a model takes the `reasoning_effort` dial. Only GLM-5.2 does; the rest
 * have thinking as a plain on/off toggle, and sending them an effort would be a
 * parameter they do not know.
 */
export function takesEffort(model: ModelId): boolean {
  return model === GLM_52;
}

/**
 * The reasoning levels offered by `/think`.
 *
 * GLM-5.2's `reasoning_effort` accepts seven values, but they COLLAPSE: `none` and
 * `minimal` skip thinking, `low` and `medium` both map up to `high`, and `xhigh`
 * maps up to `max`. So there are two real thinking levels behind seven names.
 *
 * Only the two are offered. Listing `low` and `medium` as separate rungs would put
 * choices in front of the user that provably do nothing — the same reason Fable 5
 * has no "answer directly" rung on the Anthropic driver. A menu should not contain
 * a switch that is wired to the same place as the one above it.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (takesEffort(model)) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), international endpoint. Cached input is billed
 * separately and far lower, which is what keeps a re-sent conversation cheap.
 *
 * The China endpoint charges different rates for the same model ids. This driver
 * targets international, so these are the figures that apply to it.
 */
const PRICES: Record<string, ModelPrice> = {
  [GLM_52]: { cacheHit: 0.26, cacheMiss: 1.4, output: 4.4 },
  [GLM_5]: { cacheHit: 0.2, cacheMiss: 1, output: 3.2 },
  [GLM_47]: { cacheHit: 0.11, cacheMiss: 0.6, output: 2.2 },
  [GLM_47_FLASHX]: { cacheHit: 0.014, cacheMiss: 0.07, output: 0.4 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. GLM-5.2 stores 1M, but this is deliberately
 * the sharp window rather than the storage cap: on BYOK every token in the window is
 * the user's money on every turn, so anchoring compaction at 1M would mean carrying
 * an enormous prompt long after it stopped earning its cost. Same reasoning, and the
 * same figure, as the other drivers.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. These
 * models accept up to 128K output, but a non-streaming request that runs long risks
 * an HTTP timeout, so the buffered path — core's small internal calls — is capped
 * far lower. `client.ts` sends the same constant, and core reserves exactly this
 * much room below the window, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Z.ai does serve vision, but through a
 * separate `glm-*v*` line rather than any model offered here. Declaring it would
 * mean core attaching bytes these ids cannot read.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * No per-model rule to enforce beyond the effort dial: every model here can have
 * thinking turned off. The result is snapped onto a rung `/think` actually lists,
 * which is also what keeps the request legal — the ladder holds only values the
 * model accepts, so snapping to it is what stops the shared type's other rungs from
 * reaching a model that has no dial at all.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = config.thinking === true;
  const effort: Effort = takesEffort(model) ? config.effort : "high";
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
  if (offered.length === 0) return effort;
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
export const glmManifest: DriverManifest = {
  id: "glm",
  label: "GLM",
  apiKeyEnv: "ZAI_API_KEY",
  keysUrl: "https://z.ai/manage-apikey/apikey-list",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
