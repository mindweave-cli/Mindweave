/**
 * kimi — the Moonshot Kimi driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. Loaded
 * ONLY when the user has selected a Kimi model; the cheap metadata other code needs
 * regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` and do
 * not leak markup into the text channel, so the live UI has nothing to repair.
 *
 * No `webSearch`: Kimi's search is a feature of its assistant product rather than a
 * capability of these chat models, so declaring one would invent an ability this
 * driver does not have. Absent means the `web_search` tool says so plainly.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { kimiManifest } from "./manifest.js";

export const kimiDriver: Driver = {
  ...kimiManifest,
  toolTurn,
  streamTurn,
};

export default kimiDriver;
