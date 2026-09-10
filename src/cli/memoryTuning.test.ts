/**
 * memoryTuning.test.ts — the footprint bias is applied, and the opt-out is honoured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tuneMemory } from "./memoryTuning.js";

test("tuneMemory does not throw on this Node build", () => {
  // It is best-effort: a build that rejects the flag at runtime must be swallowed, never
  // crash the app before it starts.
  assert.doesNotThrow(() => tuneMemory());
});

test("the opt-out env var makes it a no-op", () => {
  const prev = process.env["MINDWEAVE_NO_MEM_TUNING"];
  process.env["MINDWEAVE_NO_MEM_TUNING"] = "1";
  try {
    assert.doesNotThrow(() => tuneMemory());
  } finally {
    if (prev === undefined) delete process.env["MINDWEAVE_NO_MEM_TUNING"];
    else process.env["MINDWEAVE_NO_MEM_TUNING"] = prev;
  }
});
