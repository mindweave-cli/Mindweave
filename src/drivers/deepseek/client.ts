/**
 * client.ts — the DeepSeek wire layer.
 *
 * The single place that knows how to talk to DeepSeek's HTTP API. Nothing above
 * the driver knows about URLs, headers, or keys: it asks for a turn and gets back
 * either text or tool calls.
 *
 * DeepSeek's API is OpenAI-compatible, so this is a plain chat/completions call
 * with native function-calling (`tools[]` → `tool_calls`). We use native tool
 * calls — not a homemade text protocol — because the structured form can't be
 * mis-parsed and is markedly more reliable.
 */
import type {
  ChatMessage,
  ModelRequest,
  SearchOptions,
  SearchResult,
  StreamEvent,
  StreamOptions,
  StreamResult,
  StopReason,
  ToolCall,
  Turn,
  TurnOptions,
  Usage,
  WireToolCall,
} from "../types.js";
import { extractSearch, SEARCH_MAX_USES, SEARCH_SYSTEM } from "../searchBlocks.js";
import { parseInlineToolCalls } from "./inlineTools.js";
import { DEFAULT_MODEL } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;

/**
 * Where DeepSeek serves its own web search.
 *
 * DeepSeek speaks two protocols on one account and one key. Chat and tools run over
 * the OpenAI-compatible path above; the native web search is served ONLY over this
 * Anthropic-Messages-compatible one, as a server-side tool. So this driver talks to
 * both, and which one a request uses is decided by the OPERATION rather than by
 * configuration — there is nothing for the user to choose and no second key.
 *
 * Only the search call moves. Putting the whole driver here would cost real things:
 * this endpoint ignores `cache_control` (so the prompt cache the OpenAI path relies
 * on would be gone) and does not carry MCP tools, images, or code execution.
 */
const ANTHROPIC_BASE_URL = process.env.MINDWEAVE_DEEPSEEK_ANTHROPIC_URL ?? "https://api.deepseek.com/anthropic";

/** Output ceiling for the buffered search call. */
const SEARCH_MAX_TOKENS = 8_000;

/**
 * Render a ModelRequest to OpenAI-shape wire messages: the stable system prompt,
 * the stable conversation, then the volatile context as a trailing block. Keeping
 * `context` strictly last is what preserves the cacheable prefix — DeepSeek (like
 * any OpenAI-compatible provider) caches the longest identical prefix from token 0,
 * so anything volatile must come after everything we want cached.
 */
export function renderMessages(req: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: req.system }, ...req.messages];
  if (req.context && req.context.trim()) {
    // A trailing USER message is the most universally accepted shape across
    // OpenAI-compatible providers (a non-leading system message is not guaranteed
    // to be honored). It's clearly framed as current context, not the human talking.
    messages.push({ role: "user", content: `<current_context>\n${req.context}\n</current_context>` });
  }
  return messages;
}

/**
 * Build the shared request body for both the buffered and streaming paths.
 *
 * Reasoning is a body toggle on DeepSeek V4: thinking mode adds
 * `thinking: { type: "enabled" }` plus a `reasoning_effort` budget. The `thinking`
 * field is ALWAYS sent, one way or the other — DeepSeek's own docs say omitting it
 * entirely defaults to enabled at high effort, not disabled. So every internal
 * call that never sets `req.model` (the session-memory summarizer, the web-page
 * distiller) was silently paying for full reasoning it never asked for and the UI
 * was never going to show, since reasoning deltas are discarded unconditionally.
 * Sending an explicit `{ type: "disabled" }` is what actually turns it off.
 *
 * (Thinking mode also returns a separate `reasoning_content`, which reaches the
 * live UI as a delta — never the stored transcript.)
 */
export function buildBody(req: ModelRequest): Record<string, unknown> {
  const cfg = req.model;
  const tools = req.tools ?? [];
  const body: Record<string, unknown> = {
    model: cfg?.model ?? MODEL,
    messages: renderMessages(req),
  };
  if (cfg?.thinking) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = cfg.effort;
  } else {
    body.thinking = { type: "disabled" };
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

/**
 * Ask the model for one turn. Pass the tools it may call; an empty `tools`
 * array forces a tool-less, plain-text answer (used to wrap a run up).
 */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const body = { ...buildBody(req), stream: false };

  const data = (await post(body, options.signal)) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: WireToolCall[] };
      finish_reason?: string | null;
    }[];
  };

  const message = data.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments || "{}",
  }));

  // Same DSML-leak guard as the streaming path: recover inline tool calls and
  // strip the markup from the content.
  const inline = parseInlineToolCalls(content);
  if (toolCalls.length === 0 && inline.toolCalls.length > 0) toolCalls.push(...inline.toolCalls);

  return { content: inline.cleaned, toolCalls, stop: toStop(data.choices?.[0]?.finish_reason) };
}

/**
 * Map an OpenAI-shaped `finish_reason` onto the shared stop reason. `stop` and
 * `tool_calls` are both a normal finish; `length` means the answer was cut off
 * mid-sentence, which the engine has to be able to tell apart from a real ending.
 *
 * `insufficient_system_resource` is DeepSeek-specific, not part of the OpenAI
 * spec: the request was cut off by DeepSeek's own infrastructure, not a token
 * limit or a safety decision. Without a case for it, it fell through to `"end"` —
 * a resource-starved, incomplete reply reported as a clean finish.
 */
export function toStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "length":
      return "truncated";
    case "content_filter":
      return "refused";
    case "insufficient_system_resource":
      return "overloaded";
    default:
      return "end";
  }
}

/**
 * Ask the model for one turn, STREAMING. Identical request to `toolTurn` but with
 * `stream: true`, so the answer (and the model's reasoning, and each tool call's
 * arguments) arrive as Server-Sent Events. Each delta is handed to `onEvent` for
 * the live UI; the assembled turn is the return value, in the exact same shape the
 * engine already records — so the transcript stays well-formed whether we streamed
 * or not.
 *
 * `stream_options.include_usage` asks DeepSeek to append a final chunk carrying the
 * token counts, which we surface for the "elapsed · tokens" footer.
 */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const body = { ...buildBody(req), stream: true, stream_options: { include_usage: true } };
  const response = await postStream(body, options.signal);
  return consumeStream(response, options.onEvent);
}

/**
 * Read an SSE response into a finished turn, emitting each delta along the way.
 * OpenAI-shaped streaming: every `data:` line is a chunk whose `choices[0].delta`
 * carries some of `content`, `reasoning_content`, or `tool_calls`. Tool calls are
 * fragmented — the first fragment for an index brings the id + name, later ones
 * append `arguments` text — so we accumulate them by index. A trailing `usage`
 * object (from include_usage) gives the token counts.
 */
export async function consumeStream(
  response: Pick<Response, "body">,
  onEvent?: (event: StreamEvent) => void,
): Promise<StreamResult> {
  let content = "";
  // Tool calls under construction, keyed by their streaming index. `started`
  // guards the one-time tool_start emit (fired when the name first appears).
  const tools = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  let usage: Usage | undefined;
  let finishReason: string | null | undefined;

  for await (const data of sseLines(response)) {
    if (data === "[DONE]") break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue; // ignore keep-alive comments / malformed lines
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        cacheHitTokens: chunk.usage.prompt_cache_hit_tokens ?? 0,
        cacheMissTokens: chunk.usage.prompt_cache_miss_tokens ?? 0,
      };
    }

    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      onEvent?.({ type: "reasoning", delta: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onEvent?.({ type: "text", delta: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      let acc = tools.get(index);
      if (!acc) {
        acc = { id: "", name: "", args: "", started: false };
        tools.set(index, acc);
      }
      if (tc.id) acc.id = tc.id;
      // Name usually arrives whole in the first fragment, but append defensively
      // in case a provider splits it — the accumulator stays correct either way.
      if (tc.function?.name) acc.name += tc.function.name;
      // Emit tool_start once we know the name (id may still be filling in).
      if (!acc.started && acc.name) {
        acc.started = true;
        onEvent?.({ type: "tool_start", index, id: acc.id, name: acc.name });
      }
      const argFragment = tc.function?.arguments;
      if (argFragment) {
        acc.args += argFragment;
        onEvent?.({ type: "tool_args", index, delta: argFragment });
      }
    }
  }

  const toolCalls: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ id: t.id, name: t.name, arguments: t.args || "{}" }));

  // Recover any tool calls DeepSeek leaked into the text stream as DSML markup
  // (so they actually run), and strip that markup from the content either way.
  const inline = parseInlineToolCalls(content);
  if (toolCalls.length === 0 && inline.toolCalls.length > 0) toolCalls.push(...inline.toolCalls);

  return { content: inline.cleaned, toolCalls, usage, stop: toStop(finishReason) };
}

/** The slice of a streaming chunk we read (OpenAI-compatible SSE shape). */
interface StreamChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * Yield each SSE `data:` payload from a streamed response body. SSE frames are
 * separated by a blank line; a frame may carry one or more `data:` lines. We
 * decode incrementally and only emit once a full frame has arrived, so a payload
 * split across network packets is never parsed half-formed.
 */
async function* sseLines(response: Pick<Response, "body">): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  // `response.body` is a web ReadableStream; Node exposes it as async-iterable.
  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let sep: number;
    // Frames end at a blank line (\n\n); tolerate \r\n hosts too.
    while ((sep = firstFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
      const payload = frameData(frame);
      if (payload !== null) yield payload;
    }
  }
}

/** Index just past the first frame separator (blank line) in `buf`, or -1. */
function firstFrameEnd(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}

/** Join the `data:` lines of one SSE frame into its payload, or null if none. */
function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** POST a streaming request, returning the raw response for SSE reading. Shares the
 *  key/error handling with `post` but does not buffer or JSON-parse the body. */
async function postStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek API error ${response.status}: ${detail || response.statusText}`);
  }
  return response;
}

/**
 * Search the web, over DeepSeek's own Anthropic-protocol endpoint.
 *
 * DeepSeek runs the search on its own servers with the key the user already has.
 * Nothing third-party is involved and there is no second key — the same account,
 * reached over the protocol that happens to carry its search.
 *
 * The SDK is imported HERE rather than at the top of the file so that a DeepSeek
 * session that never searches does not load it. That lazy split is measured and
 * deliberate (it is why drivers load on demand at all), and a top-level import would
 * quietly undo it for every DeepSeek user.
 *
 * The model id is passed through as DeepSeek's own (`deepseek-v4-pro`), which is what
 * their documented example does. Their Claude-name mapping is a compatibility shim
 * for clients that only know Anthropic model names, and routing through it would mean
 * naming a Claude model to get a DeepSeek one — indirection with nothing to gain.
 */
export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: requireApiKey(),
    baseURL: ANTHROPIC_BASE_URL,
    // DeepSeek authenticates this endpoint with `x-api-key`, which is what the SDK
    // sends for `apiKey`. It ignores `anthropic-version` rather than requiring it.
  });
  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: SEARCH_MAX_TOKENS,
      system: SEARCH_SYSTEM,
      messages: [{ role: "user", content: query }],
      // The original tool version, not Anthropic's newer dated one: this is
      // DeepSeek's implementation of the protocol, and the widely-implemented
      // version is the one to send to a compatibility endpoint.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: SEARCH_MAX_USES }],
    },
    { signal: options.signal },
  );
  return extractSearch(message);
}

/** The DeepSeek API key, or a clear setup error if it isn't configured yet. */
function requireApiKey(): string {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No DEEPSEEK_API_KEY found. Add your key to the global config so Mindweave works " +
        "in every project:\n" +
        "  ~/.mindweave/.env  →  DEEPSEEK_API_KEY=your-key-here\n" +
        "(A per-project .env or an exported shell variable also works.)",
    );
  }
  return apiKey;
}

/** POST to chat/completions with the API key, surfacing errors as thrown text.
 *  An optional AbortSignal lets the caller (Esc to interrupt) cancel the request. */
async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek API error ${response.status}: ${detail || response.statusText}`,
    );
  }

  return response.json();
}
