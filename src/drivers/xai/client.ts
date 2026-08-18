/**
 * client.ts — the xAI wire layer.
 *
 * xAI serves an OpenAI-compatible `/chat/completions` surface, so the request shape,
 * SSE framing, fragmented tool-call arguments and the `reasoning_content` channel
 * are all handled by the shared layer in `../openaiCompat/wire.js`. This file
 * supplies only the facts that differ.
 */
import type {
  ModelConfig,
  ModelRequest,
  StopReason,
  StreamOptions,
  StreamResult,
  Turn,
  TurnOptions,
} from "../types.js";
import { compatStreamTurn, compatToolTurn, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, takesEffort } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_XAI_URL ?? "https://api.x.ai/v1";

/** The model a request runs on, matching the shared layer's own fallback so the
 *  reasoning fields can never be built for a different model than is being called. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * xAI's reasoning fields.
 *
 * `reasoning_effort` is served by ONE model here, so it is sent only for that one.
 * On the others it is not a tolerated extra: they do not accept the parameter.
 *
 * Unlike Qwen, GLM and DeepSeek, there is nothing to send when reasoning is off on a
 * model that has no dial — this provider does not default to thinking-on, so an
 * absent field is genuinely absent rather than a hidden bill. Stated because the
 * opposite is true of three other drivers here, and the reflex by now is to send it.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!takesEffort(modelOf(config))) return {};
  return { reasoning_effort: config?.thinking ? (config.effort ?? "low") : "none" };
}

/**
 * `end_turn` is xAI's own spelling of a normal finish, alongside the standard
 * `stop`. It already falls through to `"end"`, but it is mapped explicitly so the
 * value is recorded as KNOWN — an unrecognised reason reaching the default is
 * exactly how a real stop condition gets reported as a clean finish elsewhere.
 */
export function extraStop(reason: string): StopReason | undefined {
  return reason === "end_turn" ? "end" : undefined;
}

/** xAI reports its cache hit as `prompt_tokens_details.cached_tokens`, where
 *  `prompt_tokens` is the FULL prompt including the cached part. */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const hit = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  if (hit === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit) };
}

/** Everything the shared wire layer needs to talk to xAI. */
export const xaiProvider: CompatProvider = {
  label: "xAI",
  baseUrl: BASE_URL,
  apiKeyEnv: "XAI_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  extraStop,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(xaiProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(xaiProvider, req, options.onEvent, options.signal);
}
