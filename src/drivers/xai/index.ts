/**
 * xai — the Grok driver.
 *
 * Loaded ONLY when the user has selected a Grok model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` and do
 * not leak markup into the text channel. No `webSearch`: xAI's live search is a
 * separate product surface rather than a capability of the chat models, so the
 * `web_search` tool says so plainly instead of pretending.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { xaiManifest } from "./manifest.js";

export const xaiDriver: Driver = { ...xaiManifest, toolTurn, streamTurn };

export default xaiDriver;
