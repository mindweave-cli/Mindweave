/**
 * partialTurn.test.ts — the shared decision about a reply cut in half.
 *
 * Lives in one place because two copies would drift, and the drift would be invisible:
 * one provider quietly losing partial replies while another kept them is the kind of
 * difference that surfaces months later as "it forgets what it just said, sometimes".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { salvagePartialTurn } from "./partialTurn.js";

test("what the user already saw is kept, and marked incomplete", () => {
  const result = salvagePartialTurn("half an ans", new Error("socket hang up"));
  assert.equal(result.content, "half an ans");
  // Not "end". The engine has to know the reply is unfinished, or it carries on with
  // half an answer as though the model had chosen to stop there.
  assert.equal(result.stop, "overloaded");
});

test("a half-built tool call is never handed on", () => {
  // Arguments that stopped mid-JSON are not a call the model made. Executing one would
  // run something nobody asked for, which is far worse than losing the turn.
  assert.deepEqual(salvagePartialTurn("text", new Error("boom")).toolCalls, []);
});

test("with nothing to salvage the original error still surfaces", () => {
  // An empty successful turn would read as a model that chose to say nothing, which is
  // a worse lie than an error.
  const error = new Error("connection reset");
  assert.throws(() => salvagePartialTurn("", error), /connection reset/);
  assert.throws(() => salvagePartialTurn("   \n ", error), /connection reset/, "whitespace is not a reply");
});
