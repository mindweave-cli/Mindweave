/**
 * manifest.ts — what Gemini offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer — Google serves Gemini through an
 * OpenAI-compatible `/chat/completions` surface at
 * `https://generativelanguage.googleapis.com/v1beta/openai/`, so the same shared
 * layer every other compat provider uses applies here too.
 *
 * The lineup is the Gemini 3 generation only. Every model in it ALWAYS reasons —
 * Google's own docs are explicit that thinking cannot be disabled on Gemini 3 (the
 * "none" effort value that turns it off only works on the older 2.5 line, which is
 * deliberately not offered here). So unlike xAI or OpenAI there is no "Standard,
 * no thinking" rung on this ladder at all; every level here reasons, at a rung
 * `reasoning_effort` accepts (`low`/`medium`/`high` — the shared type's `xhigh`
 * and `max` are not in Gemini's vocabulary and are clamped down).
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const FLASH_37 = "gemini-3.7-flash";
export const PRO_31 = "gemini-3.1-pro-preview";
export const FLASH_LITE_35 = "gemini-3.5-flash-lite";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = FLASH_37;

/** The models offered by `/model`. First entry is this provider's default. */
export const MODELS: ModelChoice[] = [
  { id: FLASH_37, label: "Gemini 3.7 Flash", description: "the current flash model, built for coding — the default" },
  { id: PRO_31, label: "Gemini 3.1 Pro", description: "the deepest reasoning tier, for the hardest problems" },
  { id: FLASH_LITE_35, label: "Gemini 3.5 Flash-Lite", description: "cheap and quick, for high-volume work" },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * No off switch — see the file header. All three rungs are real settings a Gemini
 * 3 model will run at, not a stub standing in for one that does not exist.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "lighter reasoning budget — this model always reasons", thinking: true, effort: "low" },
    { label: "Thinking", description: "more reasoning before answering", thinking: true, effort: "medium" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), the ≤200K-token tier where one applies.
 *
 * Two of these carry a promotional rate that Google has stated ends 2026-12-31,
 * after which Flash's input/output both double. Not modelled here — a rate that
 * changes on a calendar date belongs in a review before that date, not a branch in
 * this function guessing today's date against it.
 */
const PRICES: Record<string, ModelPrice> = {
  [FLASH_37]: { cacheHit: 0.075, cacheMiss: 0.75, output: 3.75 },
  [PRO_31]: { cacheHit: 0.2, cacheMiss: 2, output: 12 },
  [FLASH_LITE_35]: { cacheHit: 0.03, cacheMiss: 0.3, output: 2.5 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window.
 *
 * Gemini 3.1 Pro is billed in two tiers — the price table above is the ≤200K-token
 * rate, and crossing that line DOUBLES the rate on the whole request, the same
 * shape xAI's Grok 4.3 has. 128K keeps ordinary sessions clear of it, for the same
 * reason and the same number as that driver.
 *
 * The two Flash models carry no such cliff; 200K is the ordinary ceiling this
 * codebase uses elsewhere once a window is chosen for cost rather than storage —
 * both models store far more, but the point of a usable window is what the user's
 * money should still be paying to carry, not what the provider will hold.
 */
export function contextWindow(model: ModelId): number {
  return model === PRO_31 ? 128_000 : 200_000;
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
 * Vision is deliberately NOT declared, even though Gemini itself reads images
 * fine. The shared OpenAI-compatible wire layer (`../openaiCompat/wire.ts`) never
 * renders `ChatMessage.images` into the request body at all — only the two
 * SDK-backed drivers (Anthropic, OpenAI) do that today. Declaring it here would
 * mean core attaching bytes this path silently never sends. Add it once the shared
 * layer carries image parts.
 */

/** The effort rungs this provider accepts, weakest first — note the absent top two. */
const EFFORTS: Effort[] = ["low", "medium", "high"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * Thinking is forced true unconditionally — there is no model in this lineup for
 * which it could legally be false — and the effort then snaps onto a rung
 * `/think` actually lists, which is what keeps `xhigh`/`max` from another
 * provider's config from ever reaching the wire.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "low";
  return { model, thinking: true, effort: snapToOfferedRung(model, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers. Ties
 * break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, because
 * silently spending more of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(model: ModelId, effort: Effort): Effort {
  const ladder: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const offered = thinkLevels(model);
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
export const geminiManifest: DriverManifest = {
  id: "gemini",
  label: "Gemini",
  apiKeyEnv: "GEMINI_API_KEY",
  keysUrl: "https://aistudio.google.com/apikey",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
