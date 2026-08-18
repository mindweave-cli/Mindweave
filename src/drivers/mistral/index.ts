/**
 * mistral — the Mistral driver.
 *
 * Loaded ONLY when the user has selected a Mistral model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * No `sanitizeText`: these models emit structured `tool_calls` and do not leak
 * markup into the text channel. No `webSearch`: Mistral's search is a Le Chat
 * feature rather than a capability of these chat models, so the `web_search` tool
 * says so plainly instead of pretending.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { mistralManifest } from "./manifest.js";

export const mistralDriver: Driver = { ...mistralManifest, toolTurn, streamTurn };

export default mistralDriver;
