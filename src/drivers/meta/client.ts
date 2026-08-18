/**
 * client.ts — the Meta wire layer.
 *
 * Meta's Model API serves an explicitly "OpenAI-compatible" `/chat/completions`
 * surface, so the request shape, SSE framing, fragmented tool-call arguments and
 * cache-token reporting are all handled by the shared layer in
 * `../openaiCompat/wire.js`. This file supplies only the facts that differ, and
 * for Meta there is barely anything to supply — Muse Spark has no reasoning
 * parameter at all (see the manifest header).
 */
import type { ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_META_URL ?? "https://api.meta.ai/v1";

/** Muse Spark takes no reasoning field of any kind — sending one would be an
 *  unrecognised parameter this API has never documented accepting. */
export function reasoningFields(): Record<string, unknown> {
  return {};
}

/** Meta reports its cache hit the standard OpenAI-compatible way, the same shape
 *  Qwen, GLM, xAI, Mistral, Groq, Cerebras and Gemini all return. */
export const cacheSplit = standardCacheSplit;

/** Everything the shared wire layer needs to talk to Meta. */
export const metaProvider: CompatProvider = {
  label: "Meta",
  baseUrl: BASE_URL,
  apiKeyEnv: "MODEL_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(metaProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(metaProvider, req, options.onEvent, options.signal);
}
