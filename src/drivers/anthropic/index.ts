/**
 * anthropic — the Claude driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. This
 * module (and the SDK it pulls in) is loaded ONLY when the user has selected a
 * Claude model; the cheap metadata other code needs regardless lives in
 * `manifest.ts`.
 *
 * There is no `sanitizeText` here: these models emit tool calls as structured
 * blocks and don't leak markup into the text channel, so the live UI has nothing
 * to repair.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn, webSearch } from "./client.js";
import { anthropicManifest } from "./manifest.js";

export const anthropicDriver: Driver = {
  ...anthropicManifest,
  toolTurn,
  streamTurn,
  webSearch,
};

export default anthropicDriver;
