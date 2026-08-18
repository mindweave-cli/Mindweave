/**
 * gemini — the Gemini driver.
 *
 * Loaded ONLY when the user has selected a Gemini model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` over
 * the OpenAI-compatible surface, the same as every other driver on the shared
 * wire layer, and do not leak markup into the text channel.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { geminiManifest } from "./manifest.js";

export const geminiDriver: Driver = { ...geminiManifest, toolTurn, streamTurn };

export default geminiDriver;
