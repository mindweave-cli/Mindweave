/**
 * client.ts — the Anthropic wire layer.
 *
 * The single place that knows how to talk to Anthropic's Messages API. Nothing
 * above the driver knows about URLs, headers, or keys.
 *
 * This is a bigger translation than an OpenAI-compatible provider needs, because
 * the stored transcript and Anthropic's wire format disagree in five places:
 *
 *   1. `system` is a top-level request field, not the first message.
 *   2. Assistant tool calls are `tool_use` content BLOCKS, and their arguments are
 *      a parsed object — the transcript stores them as a JSON string.
 *   3. Tool results are `tool_result` blocks inside a USER message; there is no
 *      `role: "tool"`.
 *   4. All results from one assistant turn must arrive in a SINGLE user message.
 *      The transcript records them as consecutive `role: "tool"` entries, so runs
 *      of them are coalesced here. Splitting them would quietly teach the model to
 *      stop making parallel tool calls.
 *   5. Caching is explicit: `cache_control` breakpoints mark the stable prefix,
 *      where an OpenAI-compatible provider just caches the longest identical one.
 *
 * All of that is format. None of it changes what the model is asked to do — the
 * system prompt is the same bytes here as on any other provider.
 */
import Anthropic from "@anthropic-ai/sdk";
import { basename } from "node:path";
import type {
  ModelRequest,
  SearchOptions,
  SearchResult,
  SearchSource,
  StreamEvent,
  StreamOptions,
  StreamResult,
  ToolCall,
  StopReason,
  Turn,
  TurnOptions,
  Usage,
} from "../types.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";

const MODEL = process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;

/** Output ceiling. This caps thinking AND answer together, so it needs headroom
 *  at the higher effort levels; both models accept up to 128K when streaming. */
const MAX_TOKENS_STREAM = 64_000;
/** Buffered calls are the small internal ones (summaries, page distillation), and
 *  a non-streaming request that runs long risks an HTTP timeout. The value lives
 *  in the manifest because core reserves room for it when setting the compaction
 *  bars — one constant, so the request and the reservation can't drift apart. */
const MAX_TOKENS_BUFFERED = BUFFERED_OUTPUT_TOKENS;

let client: Anthropic | null = null;

/** The shared SDK client, or a clear setup error if no key is configured yet. */
function api(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No ANTHROPIC_API_KEY found. Add your key to the global config so Mindweave works " +
          "in every project:\n" +
          "  ~/.mindweave/.env  →  ANTHROPIC_API_KEY=your-key-here\n" +
          "(A per-project .env or an exported shell variable also works.)",
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Parse a tool call's stored JSON-string arguments into the object the API wants.
 *  A malformed string becomes an empty object rather than failing the whole turn. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Convert the stored transcript into Anthropic messages, coalescing each run of
 * tool results into one user message (see note 4 in the header).
 *
 * Any system message that sneaks into the conversation is pulled out and returned
 * separately: Anthropic has no in-conversation system role, and dropping it would
 * silently lose instructions.
 */
export function renderMessages(req: ModelRequest): {
  messages: Anthropic.MessageParam[];
  extraSystem: string[];
} {
  const messages: Anthropic.MessageParam[] = [];
  const extraSystem: string[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const msg of req.messages) {
    if (msg.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: msg.content || "(no output)",
      });
      continue;
    }
    flushResults();

    if (msg.role === "system") {
      if (msg.content.trim()) extraSystem.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Images first: the model reads an image-then-text message more reliably than
      // the reverse, and each one is labelled so a later turn can refer to it by name.
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const img of msg.images ?? []) {
        blocks.push({ type: "text", text: `Image (${basename(img.path)}):` });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
        });
      }
      if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });
      if (blocks.length > 0) messages.push({ role: "user", content: blocks });
      continue;
    }

    // Assistant: prose and/or tool calls, in that order.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });
    for (const call of msg.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArgs(call.function.arguments),
      });
    }
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
  }
  flushResults();

  return { messages, extraSystem };
}

/** Attach a cache breakpoint to the last content block of the last message, so the
 *  conversation so far is served from cache on the next turn. No-op when the last
 *  message has no block array to mark. */
function markStablePrefix(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content === "string") return;
  const block = last.content[last.content.length - 1];
  if (block && typeof block === "object") {
    (block as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  }
}

/** Translate the tool schemas from their stored OpenAI shape. */
function renderTools(req: ModelRequest): Anthropic.Tool[] {
  return (req.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Build the request body shared by both paths.
 *
 * Cache breakpoints go in two places, well under the four allowed: one on the last
 * system block (which covers the tools rendered before it) and one on the last
 * stable message. The volatile `context` is appended AFTER both, so a changing code
 * map or todo list never invalidates the prefix — the property the ModelRequest
 * split exists to guarantee.
 */
export function buildBody(req: ModelRequest, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  const cfg = req.model;
  const { messages, extraSystem } = renderMessages(req);

  const systemText = [req.system, ...extraSystem].filter((s) => s.trim()).join("\n\n");
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
  ];

  markStablePrefix(messages);

  if (req.context && req.context.trim()) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<current_context>\n${req.context}\n</current_context>` }],
    });
  }
  // Anthropic rejects an empty conversation; the engine never sends one, but a
  // tool-less internal call could in principle.
  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "(no input)" }] });
  }

  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: cfg?.model ?? MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    // Thinking is adaptive: the model decides depth per request, and `effort` sets
    // the overall budget. Fixed thinking budgets and sampling parameters are both
    // rejected by these models, so neither is ever sent.
    thinking: cfg?.thinking ? { type: "adaptive" } : { type: "disabled" },
    output_config: { effort: cfg?.effort ?? "high" },
  };

  const tools = renderTools(req);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  return body;
}

/** Fold Anthropic's usage into the shared shape. Note `input_tokens` is only the
 *  UNCACHED remainder — the full prompt is that plus both cache figures, which is
 *  what the cost summary needs to avoid under-reporting. */
export function toUsage(usage: Anthropic.Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const cacheHit = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const promptTokens = fresh + cacheWrite + cacheHit;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitTokens: cacheHit,
    // Cache WRITES are billed as fresh input, so they belong on the miss side.
    cacheMissTokens: fresh + cacheWrite,
  };
}

/** Map Anthropic's stop reason onto the shared one. `tool_use` and `end_turn` are
 *  both a normal finish; the rest are conditions the engine has to know about. */
export function toStop(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "max_tokens":
      return "truncated";
    case "refusal":
      return "refused";
    case "model_context_window_exceeded":
      return "overflow";
    default:
      return "end";
  }
}

/** Pull the assembled reply and tool calls out of a finished message. */
export function toTurn(message: Anthropic.Message): Turn {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        // Back to the JSON string the transcript stores.
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
    // `thinking` blocks are deliberately dropped: reasoning reaches the live UI as
    // deltas, never the stored transcript.
  }
  return { content, toolCalls, stop: toStop(message.stop_reason) };
}

/** How many searches one `web_search` call may run before the provider stops. */
const SEARCH_MAX_USES = 5;

/**
 * Pull an answer and its citations out of a finished search message.
 *
 * Two shapes have to be handled and only one of them is a list. A failed search
 * comes back on a SUCCESSFUL response as a `web_search_tool_result` block whose
 * `content` is an error OBJECT rather than an array of results, so indexing it
 * blind yields nonsense instead of throwing. Hence the `Array.isArray` gate.
 *
 * Sources are de-duplicated by URL: the model commonly reads the same page across
 * two searches in one turn, and listing it twice reads as two separate findings.
 */
export function extractSearch(message: Anthropic.Message): SearchResult {
  let answer = "";
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const block of message.content) {
    if (block.type === "text") {
      answer += block.text;
      continue;
    }
    if (block.type !== "web_search_tool_result") continue;
    // The error branch. Nothing to list; the answer text explains it.
    if (!Array.isArray(block.content)) continue;
    for (const hit of block.content) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      sources.push({ title: hit.title || hit.url, url: hit.url });
    }
  }

  return {
    answer: answer.trim(),
    sources,
    // The provider's own search loop has a ceiling; past it the turn comes back
    // paused rather than finished. We keep what it found instead of resuming,
    // and say so, because a partial answer with its sources is still useful.
    partial: message.stop_reason === "pause_turn",
  };
}

/**
 * Search the web.
 *
 * Model-work boundary: this is a model call inside a tool, and its prompt is
 * deliberately thin — search, answer from what you find, say when you didn't
 * find it. No analysis rules, no house style, nothing about how to judge a
 * source. The engineering judgment stays with the model that asked.
 */
export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const message = await api().messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS_BUFFERED,
      system:
        "Search the web to answer the request. Answer only from what you find, " +
        "and say so plainly if the answer is not there. Include specifics — " +
        "versions, names, dates, code — rather than describing the pages.",
      messages: [{ role: "user", content: query }],
      // The dated variant is the tool version, not a date to keep current. This
      // one filters results before they reach the context window, and it runs
      // code execution internally to do it — which is why `code_execution` must
      // NOT also be declared here: two execution environments confuse the model.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: SEARCH_MAX_USES }],
    },
    { signal: options.signal },
  );
  return extractSearch(message);
}

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const message = await api().messages.create(buildBody(req, MAX_TOKENS_BUFFERED), {
    signal: options.signal,
  });
  return toTurn(message);
}

/**
 * Ask the model for one turn, STREAMING. Deltas go to `options.onEvent` for the
 * live UI; the assembled turn is the return value, in the same shape the engine
 * records either way. The SDK assembles the final message (including each tool
 * call's JSON), so nothing here has to reassemble fragmented arguments by hand.
 */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const stream = api().messages.stream(buildBody(req, MAX_TOKENS_STREAM), {
    signal: options.signal,
  });

  if (options.onEvent) {
    for await (const event of stream) {
      emit(event, options.onEvent);
    }
  }

  const message = await stream.finalMessage();
  return { ...toTurn(message), usage: toUsage(message.usage) };
}

/**
 * Map one streaming event onto the shared event shape. Anthropic streams blocks
 * rather than a flat delta channel, so a tool call announces itself with a
 * `content_block_start` and then streams its arguments as `input_json_delta`.
 */
export function emit(event: Anthropic.MessageStreamEvent, onEvent: (e: StreamEvent) => void): void {
  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block.type === "tool_use") {
      onEvent({ type: "tool_start", index: event.index, id: block.id, name: block.name });
    }
    return;
  }
  if (event.type !== "content_block_delta") return;

  const delta = event.delta;
  if (delta.type === "text_delta" && delta.text) {
    onEvent({ type: "text", delta: delta.text });
  } else if (delta.type === "thinking_delta" && delta.thinking) {
    onEvent({ type: "reasoning", delta: delta.thinking });
  } else if (delta.type === "input_json_delta" && delta.partial_json) {
    onEvent({ type: "tool_args", index: event.index, delta: delta.partial_json });
  }
}
