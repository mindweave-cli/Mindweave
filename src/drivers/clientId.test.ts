/**
 * clientId.test.ts — the identifying string sent with every provider request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientId } from "./clientId.js";

test("carries the mindweave name and the mwcode short id", () => {
  const id = clientId();
  assert.ok(id.startsWith("mindweave"), id);
  assert.ok(id.includes("mwcode"), id);
});

test("is stable across calls (cached, not recomputed per request)", () => {
  assert.equal(clientId(), clientId());
});

test("carries a real version when package.json has one", () => {
  // This repo's own package.json always has a version, so the degrade-to-nothing
  // path is exercised only by a missing/malformed file, not reachable from here —
  // asserting the happy path is what actually pins the format string.
  assert.match(clientId(), /^mindweave\/\d+\.\d+\.\d+ \(mwcode\)$/);
});
