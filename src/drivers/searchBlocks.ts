/**
 * searchBlocks.ts — reading a server-side web search off the Anthropic wire.
 *
 * Not an Anthropic-specific file, despite the shape. Provider-native search is served
 * over one of two protocols, and several providers that speak OpenAI for chat serve
 * their search over the Anthropic Messages protocol instead — DeepSeek does exactly
 * that, on its own endpoint, with its own key. So this is a PROTOCOL parser that two
 * drivers share, in the same way both would share a JSON parser. Copying it into each
 * driver is how the two would quietly drift apart.
 *
 * The type import is erased at compile time, so nothing here loads the Anthropic SDK
 * at runtime. That matters: a DeepSeek user must not pay to import a provider they
 * are not using, which is the whole reason drivers load lazily.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SearchResult, SearchSource } from "./types.js";

/** How many searches one call may run before the provider stops. */
export const SEARCH_MAX_USES = 5;

/**
 * The thin system prompt for a search call.
 *
 * Model-work boundary: this is the whole of it. Search, answer from what is found,
 * say so when it is not there. No analysis rules, no house style, nothing about how
 * to judge a source — that judgment belongs to the model that asked for the search,
 * not to a prompt buried inside a tool.
 */
export const SEARCH_SYSTEM =
  "Search the web to answer the request. Answer only from what you find, " +
  "and say so plainly if the answer is not there. Include specifics — " +
  "versions, names, dates, code — rather than describing the pages.";

/**
 * Pull an answer and its citations out of a finished search message.
 *
 * Two shapes have to be handled and only one of them is a list. A failed search comes
 * back on a SUCCESSFUL response as a `web_search_tool_result` block whose `content` is
 * an error OBJECT rather than an array of results, so indexing it blind yields nonsense
 * instead of throwing. Hence the `Array.isArray` gate.
 *
 * Sources are de-duplicated by URL: the model commonly reads the same page across two
 * searches in one turn, and listing it twice reads as two separate findings.
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
      // The declared type says both fields are strings. A real provider disagreed:
      // a live DeepSeek search returned a result carrying neither, which rendered as
      // "undefined — undefined" in the source list. The wire is not bound by the SDK's
      // types, so a result without a usable URL is dropped rather than shown.
      const url = typeof hit.url === "string" ? hit.url.trim() : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = typeof hit.title === "string" ? hit.title.trim() : "";
      sources.push({ title: title || url, url });
    }
  }

  return {
    answer: answer.trim(),
    sources,
    // The provider's own search loop has a ceiling; past it the turn comes back paused
    // rather than finished. We keep what it found instead of resuming, and say so,
    // because a partial answer with its sources is still useful.
    partial: message.stop_reason === "pause_turn",
  };
}
