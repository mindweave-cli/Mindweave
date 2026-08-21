/**
 * contextOverflow.ts — telling "this conversation no longer fits" apart from
 * "we sent something broken".
 *
 * A provider can refuse an over-long request two ways, and only one of them was
 * handled. Some report it as a FINISH REASON on an otherwise successful response
 * (`model_context_window_exceeded`), which the drivers already map to the `overflow`
 * stop and the engine already recovers from by shedding its oldest rounds. Most
 * providers instead REJECT the request outright with a 400, and that path had no
 * recovery at all: `providerError.ts` classifies a 400 as a malformed request, our
 * bug, deliberately loud — so a conversation that had merely grown too long ended the
 * turn with a red error, after the user had already paid for the refused call.
 *
 * That classification stays exactly as it is for every other 400. This is the same
 * kind of narrow reprieve the balance-phrase carve-out is: it answers one prior
 * question, "is this refusal about LENGTH", and answers it from the provider's own
 * sentence rather than from a status code that cannot distinguish it.
 *
 * WHICH DIRECTION THIS SHOULD FAIL. A miss costs a dead turn. A false positive costs
 * the oldest rounds of a conversation and one retry, and if the request was never
 * really too long the retry fails again and the real error surfaces then. So the
 * phrase list leans towards matching, and the recovery it triggers is capped at once
 * per turn precisely so a wrong guess cannot loop.
 */
import { detailOf, providerMessage, statusOf } from "./providerError.js";

/**
 * Statuses that can carry a length refusal.
 *
 * 400 is where almost every provider puts it. 413 is the literal "payload too large",
 * which a gateway in front of a provider may return instead. 422 covers the handful
 * that treat an over-long prompt as a validation failure. A 5xx is the provider
 * falling over and a 401/402/403/429 is the account, and neither becomes recoverable
 * by dropping history, so both are excluded rather than left to the phrase match.
 */
const OVERFLOW_STATUSES = new Set([400, 413, 422]);

/**
 * How the providers in the lineup word it. Lower-cased substrings, checked against
 * the provider's own sentence.
 *
 * Every entry here is about SIZE and nothing else, which is what keeps this from
 * quietly widening into "any 400 we felt like retrying". `context_length_exceeded` is
 * OpenAI's machine-readable code rather than prose, and is matched because it travels
 * in the same body.
 */
const OVERFLOW_PHRASES = [
  "context length",
  "context window",
  "context_length_exceeded",
  "maximum context",
  "prompt is too long",
  "too many tokens",
  "input token count",
  "token count exceeds",
  "exceeds the maximum number of tokens",
  "reduce the length of the messages",
  "request too large",
];

/**
 * Did the provider refuse this request because the conversation no longer fits (pure)?
 *
 * An error with no status at all is still examined: SDK wrappers do not always expose
 * one, and a sentence that plainly says the prompt was too long means the same thing
 * whether or not the number survived the trip.
 */
export function isContextOverflowError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null && !OVERFLOW_STATUSES.has(status)) return false;

  const detail = detailOf(error);
  // The provider's own sentence when one can be extracted, and the raw body when it
  // cannot — a phrase this specific is not going to match the surrounding JSON by
  // accident, and insisting on a parsed message would miss every provider that sends
  // plain text.
  const text = `${providerMessage(detail)}\n${detail}`.toLowerCase();
  return OVERFLOW_PHRASES.some((phrase) => text.includes(phrase));
}
