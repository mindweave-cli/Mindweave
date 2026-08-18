/**
 * groq — the Groq driver.
 *
 * Loaded ONLY when the user has selected a Groq model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`.
 *
 * Groq is a SPEED provider, not a capability one: the models it serves are open
 * models available elsewhere, and what it sells is how fast they run. Worth stating
 * in the driver, because "which provider is best" has a different answer here than
 * for a vendor serving its own frontier model.
 *
 * No `sanitizeText`: structured `tool_calls`, no markup in the text channel.
 * No `webSearch`: Groq serves inference, not search.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { groqManifest } from "./manifest.js";

export const groqDriver: Driver = { ...groqManifest, toolTurn, streamTurn };

export default groqDriver;
