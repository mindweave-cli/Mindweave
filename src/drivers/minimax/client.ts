/**
 * client.ts — the MiniMax wire layer.
 *
 * MiniMax serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are all handled by the shared layer in `../openaiCompat/wire.js`. This
 * file supplies only the facts that differ.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_MINIMAX_URL ?? "https://api.minimax.io/v1";

/**
 * MiniMax's reasoning field: a nested `{type: "adaptive" | "disabled"}`, sent
 * EXPLICITLY every call rather than omitted when off. MiniMax's own docs say
 * thinking defaults ON when the field is absent, so relying on that default would
 * mean every internal buffered call (which carries no `ModelConfig`) silently
 * reasons at the higher rate. Explicit here, the same reflex Qwen's driver needed
 * for the opposite reason.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  return { thinking: { type: config?.thinking !== false ? "adaptive" : "disabled" } };
}

/** MiniMax reports its cache hit the standard OpenAI-compatible way, the same
 *  shape Qwen, GLM, xAI, Mistral, Groq, Cerebras and Gemini all return. */
export const cacheSplit = standardCacheSplit;

/** Everything the shared wire layer needs to talk to MiniMax. */
export const minimaxProvider: CompatProvider = {
  label: "MiniMax",
  baseUrl: BASE_URL,
  apiKeyEnv: "MINIMAX_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(minimaxProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(minimaxProvider, req, options.onEvent, options.signal);
}
