/**
 * approvalQueue.test.ts — two questions cannot cancel each other.
 *
 * The approval overlay is a single slot. A second request used to overwrite the first
 * and drop its resolver, so the tool awaiting it waited for the rest of the session
 * with nothing on screen to explain why. It is reachable: MCP trust verification is
 * kicked off from a floating promise at session start and can land while a tool is
 * already asking.
 *
 * The queue lives in its own module so these drive the REAL implementation rather than
 * a copy of it that could quietly stop matching. What is defended is the settlement
 * contract — every request answered exactly once, in order, nothing left hanging — not
 * the pixels; the rendering half has its own probe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_DISMISSED } from "../tools/approval.js";

import { ApprovalChannel } from "./approvalChannel.js";

/** The real channel App.tsx uses, holding the question text as its item. */
function channel() {
  const c = new ApprovalChannel<{ question: string }>();
  return {
    get shown() {
      return c.current;
    },
    ask: (question: string) => c.ask({ question }),
    answer: (choice: string) => c.answer(choice),
    interrupt: () => c.dismissWaiting(APPROVAL_DISMISSED),
    raw: c,
  };
}

test("a second question waits its turn instead of replacing the first", async () => {
  const c = channel();
  const first = c.ask("delete this file?");
  const second = c.ask("trust this server?");

  assert.equal(c.shown?.question, "delete this file?", "the first question was pushed off screen");
  c.answer("Yes");
  assert.equal(await first, "Yes");

  assert.equal(c.shown?.question, "trust this server?", "the queued question was never shown");
  c.answer("No");
  assert.equal(await second, "No", "the second request was orphaned");
});

test("an answer lands on the question that was asked, not the one that came after", async () => {
  // The failure this prevents is worse than a hang: with a single slot the second
  // request's overlay was answered and the FIRST tool got the reply.
  const c = channel();
  const first = c.ask("A");
  const second = c.ask("B");
  c.answer("answer-to-A");
  c.answer("answer-to-B");
  assert.equal(await first, "answer-to-A");
  assert.equal(await second, "answer-to-B");
});

test("an interrupt answers everything still waiting, so nothing hangs", async () => {
  const c = channel();
  const shownOne = c.ask("on screen");
  const queuedOne = c.ask("not yet shown");

  c.interrupt();
  // The queued one is settled immediately; the displayed one still belongs to Esc.
  assert.equal(await queuedOne, APPROVAL_DISMISSED);
  c.answer(APPROVAL_DISMISSED);
  assert.equal(await shownOne, APPROVAL_DISMISSED);
});

test("a request settles exactly once, however many times it is answered", async () => {
  const c = channel();
  const only = c.ask("A");
  c.answer("first");
  // Answering again cannot reach a request already settled — with a single slot the
  // second answer used to be delivered to whatever asked next.
  c.answer("second");
  assert.equal(await only, "first", "a later answer overwrote one already given");
});

test("nothing is shown when nothing is being asked", () => {
  const c = channel();
  assert.equal(c.shown, null);
  assert.equal(c.raw.waiting, 0);
  c.answer("stray"); // answering an empty channel must not throw
  assert.equal(c.shown, null);
});
