/**
 * cerebras — the Cerebras driver.
 *
 * Loaded ONLY when the user has selected a Cerebras model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * Like Groq, this is a SPEED provider rather than a capability one: it serves open
 * models that are available elsewhere, and what it sells is how fast they run.
 *
 * No `sanitizeText`: structured `tool_calls`, no markup in the text channel.
 * No `webSearch`: Cerebras serves inference, not search.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { cerebrasManifest } from "./manifest.js";

export const cerebrasDriver: Driver = { ...cerebrasManifest, toolTurn, streamTurn };

export default cerebrasDriver;
