/**
 * qwen — the Qwen driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. Loaded
 * ONLY when the user has selected a Qwen model; the cheap metadata other code needs
 * regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` and do
 * not leak markup into the text channel, so the live UI has nothing to repair. (The
 * DeepSeek driver does carry a repair for exactly that, which is why this absence
 * is worth stating rather than assuming.)
 *
 * No `webSearch`: Qwen's search is a separate application-level service rather than
 * a capability of these chat models, so declaring one would be inventing an ability
 * this driver does not have. Absent means the `web_search` tool says so plainly.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { qwenManifest } from "./manifest.js";

export const qwenDriver: Driver = {
  ...qwenManifest,
  toolTurn,
  streamTurn,
};

export default qwenDriver;
