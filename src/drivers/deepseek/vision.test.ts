/**
 * vision.test.ts — the DeepSeek vision model, and the wire that carries an image.
 *
 * Added when `deepseek-v4-flash-vision-exp` shipped (2026-08-21). The interesting
 * part is not the model entry, it is that the transport underneath could not send a
 * picture at all: `images` is our own field and was being spread onto the request
 * untouched, so a provider saw an unknown key and the bytes never left the machine.
 * Declaring the capability without fixing that would have made `acceptsImages` a
 * lie, which is the failure this project keeps finding in other forms.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsImages, contextWindow, normalize, price, thinkLevels, MODELS, VISION, FLASH, PRO } from "./manifest.js";
import { toWireMessages } from "../openaiCompat/wire.js";

test("the vision model is offered and keeps its identity", () => {
  assert.ok(MODELS.some((m) => m.id === VISION), "it has to appear in /model");
  // The old shape was "PRO or else FLASH", which would have rewritten a vision
  // selection back to Flash and changed the user's model under them without a word.
  assert.equal(normalize({ model: VISION, thinking: false, effort: "high" }).model, VISION);
  assert.equal(normalize({ model: PRO, thinking: false, effort: "high" }).model, PRO);
  assert.equal(normalize({ model: "something-else", thinking: false, effort: "high" } as never).model, FLASH);
});

test("only the vision model claims to read images", () => {
  assert.equal(acceptsImages(VISION), true);
  // Core degrades before sending when this is false, so a wrong answer here is the
  // difference between a clear message and a silently text-only attachment.
  assert.equal(acceptsImages(FLASH), false);
  assert.equal(acceptsImages(PRO), false);
});

test("vision advertises no reasoning ladder, and cannot be given one", () => {
  // DeepSeek documents the request shape and the image budget for this id and says
  // nothing about reasoning_effort. This driver already shipped a rung DeepSeek does
  // not accept once; advertising an unverified one is the same mistake twice.
  assert.deepEqual(thinkLevels(VISION).map((l) => l.label), ["Standard"]);
  assert.deepEqual(thinkLevels(FLASH).map((l) => l.label), ["Standard", "High", "Maximum"]);
  // A config saved on another model must not carry thinking in through the back door.
  assert.equal(normalize({ model: VISION, thinking: true, effort: "max" }).thinking, false);
});

test("vision is priced and sized from what DeepSeek publishes", () => {
  assert.deepEqual(price(VISION), price(FLASH), "the price list gives it Flash's rates exactly");
  assert.equal(contextWindow(VISION), contextWindow(FLASH));
});

test("an image actually reaches the wire, in the shape DeepSeek documents", () => {
  const [wire] = toWireMessages([
    {
      role: "user",
      content: "what is in this screenshot?",
      images: [{ path: "D:/shot.png", mediaType: "image/png", data: "AAAB" }],
    },
  ]) as { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[];

  assert.ok(Array.isArray(wire.content), "a message with images sends parts, not a bare string");
  assert.deepEqual(wire.content[0], { type: "text", text: "what is in this screenshot?" });
  // The text part comes first and is always present: a message that is only an image
  // reads as an attachment with no question attached to it.
  assert.deepEqual(wire.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } });
  // `images` is ours, not theirs. Leaving it on the request is how the picture used
  // to go nowhere while the request still looked well formed.
  assert.ok(!("images" in wire), "our own field must not be sent");
});

test("a message with no images is unchanged", () => {
  const [wire] = toWireMessages([{ role: "user", content: "plain text" }]) as { content: unknown }[];
  assert.equal(wire.content, "plain text", "no needless array for the ordinary case");
});

test("tool calls still survive the same path", () => {
  const [wire] = toWireMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  ]) as { tool_calls: { id: string }[] }[];
  assert.equal(wire.tool_calls[0]!.id, "c1");
});
