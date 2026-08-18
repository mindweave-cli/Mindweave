import { test } from "node:test";
import assert from "node:assert/strict";
import { workingVerb, WORKING_VERBS } from "./workingVerb.js";

test("the verb is stable for the whole turn", () => {
  // The status line re-renders once a second for its timer. If the verb were picked
  // per render it would flicker through the pool while the seconds tick.
  const start = 1_755_000_123_456;
  const picks = new Set(Array.from({ length: 50 }, () => workingVerb(start)));
  assert.equal(picks.size, 1);
});

test("different turns get different words often enough to signal a NEW turn", () => {
  // That signal is the whole point: it says "this is not the last turn still running".
  const picks = new Set(Array.from({ length: 40 }, (_, i) => workingVerb(1_755_000_000_000 + i * 137)));
  assert.ok(picks.size >= 5, `expected variety across turns, saw ${picks.size}`);
});

test("no verb claims progress the harness cannot actually see", () => {
  // "Almost done" would be a guess wearing a status line's clothes.
  for (const v of WORKING_VERBS) {
    assert.match(v, /ing$/, `${v} must be a present participle`);
    assert.doesNotMatch(v, /almost|finish|complet|nearly/i, `${v} claims progress nothing measures`);
  }
});

test("a zero or negative start time still yields a real verb", () => {
  assert.ok(WORKING_VERBS.includes(workingVerb(0)));
  assert.ok(WORKING_VERBS.includes(workingVerb(-5)));
});
