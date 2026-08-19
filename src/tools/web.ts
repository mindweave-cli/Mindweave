/**
 * web.ts — the one door to the internet: search it, or read a page of it.
 *
 * These were `web_search` and `web_fetch`. Two tools, two schemas, and one decision the
 * model had to get right before it could start — when the decision is already implied by
 * what it has: a question is a search, a URL is a fetch. Merging them removes the
 * routing step rather than describing it better, which is the same reasoning that
 * collapsed the edit tools and the session tools.
 *
 * The two implementations are untouched and still live in `webSearch.ts` and
 * `webFetch.ts`; this only decides which one a call meant. That split matters because
 * they are genuinely different machines underneath — search runs through the provider's
 * own grounding, fetch goes out over HTTP through the SSRF guard — and pretending
 * otherwise in the code would be worse than the two tools ever were.
 *
 * Read-only, so it stays available while planning and to research sub-agents.
 */
import type { Tool, ToolResult } from "./types.js";
import { searchWeb } from "./webSearch.js";
import { fetchWeb } from "./webFetch.js";
import { DISTILL_OVER_CHARS } from "./webFetch.js";

export const web: Tool = {
  name: "web",
  /** Deferred: many coding sessions never touch the network at all. Cache-safe now that
   *  discovery is append-only — find_tools returns the schema in its result and the
   *  advertised list never moves. */
  deferred: true,
  readOnly: true,
  description:
    "Reach the internet. Pass `query` to SEARCH, or `url` to READ a specific page.\n" +
    "SEARCH: give a `query` the way you would type it into a search engine. Use it for " +
    "anything that changed after your training data — current library APIs, recent " +
    "releases, version-specific behaviour, whether a package still exists. You get an " +
    "answer grounded in the pages found, plus their URLs. Not every model can search; " +
    "if this one cannot, the tool says so and you should ask the user for a URL rather " +
    "than retrying.\n" +
    "READ: give a `url` and optionally a `prompt` describing what to extract. Use it for " +
    "docs, articles, changelogs, or any public URL — including following a URL search " +
    "just gave you. " +
    `A page longer than ${DISTILL_OVER_CHARS.toLocaleString("en-US")} characters is ` +
    "condensed against your `prompt` so you get the answer rather than the page; below " +
    "that you simply get the whole thing and the prompt is not needed. " +
    "A bare host is fine (\"example.com\" becomes https://example.com), http is upgraded " +
    "to https, and private or localhost addresses are refused. " +
    "For GitHub, prefer the gh CLI via run_command when you can.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "What to search for, phrased as a search query. Use this OR `url`, not both.",
      },
      url: {
        type: "string",
        description: "A page to read. A bare host works. Use this OR `query`, not both.",
      },
      prompt: {
        type: "string",
        description: "Reading only: what to extract from the page (used to focus a large page).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const query = typeof args.query === "string" ? args.query.trim() : "";
    // Both is refused rather than silently picking one: it means the model was unsure
    // what it wanted, and quietly answering half the request is the worse outcome.
    if (url && query) {
      return fail("pass either `query` to search or `url` to read a page, not both.");
    }
    if (url) return fetchWeb(args, ctx);
    if (query) return searchWeb(args, ctx);
    return fail("`query` (to search) or `url` (to read a page) is required.");
  },
};

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
