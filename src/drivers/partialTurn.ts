/**
 * partialTurn.ts — what to do with a reply the connection cut in half.
 *
 * A stream can die after the model has begun answering. The deltas have already gone
 * out through `onEvent`, so the user watched the reply appear; throwing at that point
 * unwinds the turn before anything is recorded, leaving text on screen that the
 * transcript never heard of and that the next turn cannot see. The model then has no
 * idea it said anything.
 *
 * It cannot be retried. The retry layer deliberately sits on the status line, before a
 * byte of body is read, because re-sending once output has been emitted would double
 * it. Past that point the only honest options are to lose the reply or to keep it and
 * say it is incomplete, and keeping it is plainly better.
 *
 * Shared by every driver on purpose. Two copies of this decision would drift, and the
 * failure would be invisible: one provider quietly losing partial replies while another
 * kept them is exactly the kind of difference nobody notices until a user reports that
 * "it forgets what it just said, but only sometimes".
 */
import type { StreamResult } from "./types.js";

/**
 * Return what arrived as an INCOMPLETE turn, or rethrow when there is nothing to keep.
 *
 * `overloaded` rather than `truncated`: its wording is "the provider's infrastructure
 * cut the request off before it finished", which is what happened. `truncated` would
 * claim the model hit its own output ceiling, which it did not, and would send the user
 * looking for a limit to raise.
 *
 * Tool calls are DROPPED, and that is the load-bearing half. A call whose arguments
 * stopped mid-JSON is not a call the model made; handing one on would execute something
 * nobody asked for. Text survives being cut short, a tool call does not. The engine's
 * early-stop branch ignores tool calls anyway, so this keeps the two in agreement
 * rather than relying on that.
 *
 * With nothing to salvage the original error is rethrown. An empty successful turn would
 * read as a model that chose to say nothing, which is a worse lie than an error.
 */
export function salvagePartialTurn(content: string, error: unknown): StreamResult {
  if (!content.trim()) throw error;
  return { content, toolCalls: [], stop: "overloaded" };
}
