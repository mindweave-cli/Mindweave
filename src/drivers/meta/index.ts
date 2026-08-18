/**
 * meta — the Muse Spark driver.
 *
 * Loaded ONLY when the user has selected a Meta model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: tool calls arrive as structured `tool_calls` over the
 * OpenAI-compatible surface, the same as every other driver on the shared wire
 * layer, and do not leak markup into the text channel.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { metaManifest } from "./manifest.js";

export const metaDriver: Driver = { ...metaManifest, toolTurn, streamTurn };

export default metaDriver;
