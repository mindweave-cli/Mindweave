/**
 * minimax — the MiniMax driver.
 *
 * Loaded ONLY when the user has selected a MiniMax model; the cheap metadata
 * other code needs regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: tool calls arrive as structured `tool_calls` over the
 * OpenAI-compatible surface, the same as every other driver on the shared wire
 * layer, and do not leak markup into the text channel.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { minimaxManifest } from "./manifest.js";

export const minimaxDriver: Driver = { ...minimaxManifest, toolTurn, streamTurn };

export default minimaxDriver;
