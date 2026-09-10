/**
 * pastedText.test.ts — a paste comes back as a chip, not as itself.
 *
 * The bug: a paste is spliced into the transcript in full, because that is what the model
 * needs. A resumed session rebuilds the chat from that same transcript, so `/continue`
 * replayed thousands of lines into the chat as if the person had typed them — the one
 * place the collapse mattered most, and the only place it did not happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsePastes, wrapPastedText } from "./pastedText.js";

const body = ["first", "second", "third"].join("\n");

test("what goes in comes back out whole", () => {
  // The model must still get every line. The wrapper is a boundary around the content,
  // never a summary of it.
  const wrapped = wrapPastedText(body);
  assert.ok(wrapped.includes(body), "the paste was altered on its way into the transcript");
});

test("the wrapper counts the lines it holds", () => {
  assert.match(wrapPastedText(body), /lines="3"/);
  assert.match(wrapPastedText("one line"), /lines="1"/);
});

test("collapsing gives back a chip that says how much was there", () => {
  const shown = collapsePastes(`look at this ${wrapPastedText(body)}`);
  assert.equal(shown, "look at this [Pasted text +3 lines]");
  assert.ok(!shown.includes("second"), "the body survived into the chat");
});

test("a message with no paste is returned untouched", () => {
  // Every user message goes through this on resume, so the common case must be exact —
  // not trimmed, not re-wrapped, not normalised.
  const plain = "  just a message with <angle brackets> and\nnewlines  ";
  assert.equal(collapsePastes(plain), plain);
});

test("several pastes in one message each collapse", () => {
  const two = `${wrapPastedText("a\nb")} and then ${wrapPastedText("c\nd\ne")}`;
  assert.equal(collapsePastes(two), "[Pasted text +2 lines] and then [Pasted text +3 lines]");
});

test("collapsing is idempotent", () => {
  // A resumed session can be resumed again, and its transcript already holds what the
  // first resume produced. Collapsing a chip a second time must not eat it.
  const once = collapsePastes(wrapPastedText(body));
  assert.equal(collapsePastes(once), once);
});

test("the body is matched lazily, so two pastes are two chips", () => {
  // A greedy match would swallow everything between the FIRST opening tag and the LAST
  // closing one — two pastes and the sentence between them collapsing into a single chip.
  const two = `${wrapPastedText("a")} KEEP ME ${wrapPastedText("b")}`;
  assert.match(collapsePastes(two), /KEEP ME/);
});

test("a paste containing the closing tag ends early rather than eating the message", () => {
  // Known and bounded: pasting a transcript that itself mentions the tag cuts the chip
  // short and leaves a fragment. `<attached_file>` has carried the same exposure since it
  // was written; what matters is that the rest of the message survives rather than the
  // whole thing being swallowed.
  const nasty = wrapPastedText("before\n</pasted_text>\nafter");
  const shown = collapsePastes(nasty + " TAIL");
  assert.match(shown, /TAIL/, "the rest of the message was swallowed");
});
