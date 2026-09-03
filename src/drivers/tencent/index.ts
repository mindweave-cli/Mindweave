/**
 * tencent — the Tencent Hy (TokenHub) driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. Loaded
 * ONLY when the user has selected a Hy model; the cheap metadata other code needs
 * regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` and do
 * not leak markup into the text channel, so the live UI has nothing to repair.
 *
 * No `webSearch`: nothing on this endpoint answers the "look this up and hand back
 * the answer" shape the shared `webSearch` contract describes. Absent means the
 * `web_search` tool says so plainly rather than pretending, which is the bargain that
 * contract is built on.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { tencentManifest } from "./manifest.js";

export const tencentDriver: Driver = {
  ...tencentManifest,
  toolTurn,
  streamTurn,
};

export default tencentDriver;
