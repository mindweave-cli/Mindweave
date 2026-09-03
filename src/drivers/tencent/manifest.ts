/**
 * manifest.ts — what Tencent's Hy models offer, and the numbers that describe them.
 *
 * Loaded even when the user is running a different provider, so it stays plain data
 * and pure functions. The wire code lives in `client.ts`, a thin binding over the
 * shared OpenAI-compatible layer.
 *
 * WHICH ENDPOINT THIS IS. Tencent serves these models through TokenHub, and the
 * international console and the mainland one are different hosts with different
 * model ids for the same weights: `hy3` on the international endpoint targeted here,
 * `hunyuan-hy3` on the mainland one. A user on the mainland account sets
 * `MINDWEAVE_TENCENT_URL` and picks the id their console lists, the same override
 * shape the GLM driver uses for the same reason. Prices below are the published
 * international rates, which are identical across Singapore, Guangzhou and Silicon
 * Valley.
 *
 * The weights for Hy3 are open, and it runs locally under vLLM or SGLang. That is a
 * different thing from this driver, which speaks to the hosted endpoint over a key.
 * A local runtime is reached the way every other local runtime is.
 *
 * THINKING IS A DIAL WITH AN OFF POSITION, and both halves must be sent. Tencent
 * documents `thinking: {"type": "enabled"}` alongside `reasoning_effort`, defaulting
 * to `high` — so omitting the fields does not mean a direct answer, it means the
 * model reasons and bills for it. Every internal call that never sets a model would
 * otherwise pay for reasoning nobody reads.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const HY4_PREVIEW = "hy4-preview";
export const HY3 = "hy3";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = HY3;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Tencent.
 *
 * Hy3 leads rather than the newer model, and deliberately: hy4-preview is a preview
 * that costs about six times as much per input token, and a provider whose default
 * is the expensive preview picks a bill on the user's behalf. Both are listed; the
 * choice is theirs to make.
 */
export const MODELS: ModelChoice[] = [
  { id: HY3, label: "Hy3", description: "the value model — strong at code, 256K context" },
  { id: HY4_PREVIEW, label: "Hy4 Preview", description: "the newest, for agentic and long-context work" },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * Three rungs, and the lowest one genuinely stops the model reasoning: Tencent's API
 * takes `thinking.type` `enabled`/`disabled` as well as `reasoning_effort` of `low`
 * or `high`. There is no `max`, so none is offered — a rung wired to a value the
 * provider does not accept is worse than no rung.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Light", description: "reasons briefly", thinking: true, effort: "low" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), international endpoint.
 *
 * Cached input is billed at a quarter of fresh input on hy3 and at a twentieth on
 * hy4-preview, which is why the two are carried separately rather than as one input
 * rate — an agentic loop re-sends its prefix on every step, and on hy4-preview that
 * difference is most of the bill.
 */
const PRICES: Record<string, ModelPrice> = {
  [HY3]: { cacheHit: 0.033, cacheMiss: 0.132, output: 0.528 },
  [HY4_PREVIEW]: { cacheHit: 0.042, cacheMiss: 0.834, output: 2.501 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Hy3 stores 256K and hy4-preview 1M, but this is
 * deliberately the sharp window rather than the storage cap: on BYOK every token in
 * the window is the user's money on every turn, so anchoring compaction at the cap
 * would mean carrying an enormous prompt long after it stopped earning its cost.
 * Same reasoning, and the same figure, as the other drivers.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. Both models
 * accept far more, but a non-streaming request that runs long risks an HTTP timeout,
 * so the buffered path — core's small internal calls — is capped far lower.
 * `client.ts` sends the same constant, and core reserves exactly this much room below
 * the context window, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Neither model is documented as taking image
 * input on this endpoint, and the shared OpenAI-compatible wire layer never renders
 * `ChatMessage.images` into the request body regardless. Declaring it would mean core
 * attaching bytes this path silently never sends.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * The effort is snapped onto a rung the ladder above actually lists, which is what
 * keeps the request legal: the shared `ModelConfig` carries five rungs and this
 * provider accepts two, so a config arriving from another model must be brought down
 * to one of them rather than sent as it stands.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = config.thinking === true;
  return { model, thinking, effort: snapToOfferedRung(thinking, config.effort) };
}

/**
 * Move an effort onto the nearest rung the ladder offers. Ties break DOWNWARD: an
 * unlisted setting resolves to the cheaper neighbour, because silently spending more
 * of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(thinking: boolean, effort: Effort): Effort {
  const ladder: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const offered = thinkLevels(DEFAULT_MODEL).filter((l) => l.thinking === thinking);
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
export const tencentManifest: DriverManifest = {
  id: "tencent",
  label: "Tencent",
  apiKeyEnv: "TOKENHUB_API_KEY",
  keysUrl: "https://console.tencentcloud.com/tokenhub",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
