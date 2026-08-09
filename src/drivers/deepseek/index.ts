/**
 * deepseek — the reference driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. This
 * module is loaded ONLY when the user has selected a DeepSeek model; the cheap
 * metadata other code needs regardless lives in `manifest.ts`.
 *
 * Copy this folder as the starting point for a new provider. The shape to keep is
 * the split: cheap metadata in `manifest.ts`, wire format in `client.ts`,
 * model-specific repairs in their own module, and this file as the thin assembly.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn, webSearch } from "./client.js";
import { stripInlineToolCalls } from "./inlineTools.js";
import { deepseekManifest } from "./manifest.js";

export const deepseekDriver: Driver = {
  ...deepseekManifest,
  toolTurn,
  streamTurn,
  // Served over DeepSeek's own Anthropic-protocol endpoint, with the same key. Chat
  // stays on the OpenAI path; only this call changes protocol.
  webSearch,
  // The live UI renders raw text deltas, which is the one place DeepSeek's leaked
  // DSML markup can still reach the screen — the assembled turn is already clean.
  sanitizeText: stripInlineToolCalls,
};

export default deepseekDriver;
