/**
 * glm — the Z.ai GLM driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. Loaded
 * ONLY when the user has selected a GLM model; the cheap metadata other code needs
 * regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit tool calls as structured `tool_calls` and do
 * not leak markup into the text channel, so the live UI has nothing to repair.
 *
 * No `webSearch`: Z.ai does serve a web-search tool, but as an entry in the same
 * `tools` array the agent's own tools occupy — which is a different thing from
 * "look this up and hand back the answer", the shape the shared `webSearch`
 * contract describes. Absent means the `web_search` tool says so plainly rather
 * than pretending, which is the bargain that contract is built on.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { glmManifest } from "./manifest.js";

export const glmDriver: Driver = {
  ...glmManifest,
  toolTurn,
  streamTurn,
};

export default glmDriver;
