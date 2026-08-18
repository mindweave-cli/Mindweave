/**
 * openai — the GPT driver.
 *
 * Assembles the pieces in this folder into the `Driver` the core talks to. This
 * module (and the SDK it pulls in) is loaded ONLY when the user has selected a GPT
 * model; the cheap metadata other code needs regardless lives in `manifest.ts`.
 *
 * There is no `sanitizeText` here: these models emit tool calls as structured items
 * and don't leak markup into the text channel, so the live UI has nothing to repair.
 *
 * There is deliberately no `webSearch` either, and that is a capability statement
 * rather than a gap. OpenAI does serve a hosted web-search tool, but only as one
 * entry in the same `tools` array the agent's own tools occupy — declaring it would
 * mean the model choosing between searching and calling a real tool mid-task, which
 * is a different feature from "look this up and hand back the answer" that the
 * shared `webSearch` contract describes. Absent means the `web_search` tool says so
 * plainly instead of pretending, which is the bargain that contract is built on.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { openaiManifest } from "./manifest.js";

export const openaiDriver: Driver = {
  ...openaiManifest,
  toolTurn,
  streamTurn,
};

export default openaiDriver;
