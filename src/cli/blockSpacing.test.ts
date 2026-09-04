/**
 * blockSpacing.test.ts — the blank row between transcript blocks.
 *
 * One blank line is not the kind of thing a screenshot settles, and the failure was
 * exactly that: a run of shell commands with no separation anywhere, so the end of one
 * command's output ran straight into the next command's header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTight, hasBody } from "./blockSpacing.js";
import type { Block } from "./transcript.js";

let nextId = 0;

/** A tool block, with a result body only when one is asked for. */
function tool(detail?: string): Block {
  return {
    kind: "tool",
    id: nextId++,
    done: true,
    toolId: `t${nextId}`,
    name: "Run",
    status: "ok",
    ...(detail === undefined ? {} : { detail }),
  };
}

function prose(): Block {
  return { kind: "assistant", id: nextId++, done: true, text: "some reply" };
}

test("a run of one-line tool rows hugs", () => {
  // The case the rule exists for: five reads in a row are a list, and blank lines between
  // list items only make the list longer.
  const blocks = [tool(), tool(), tool()];
  assert.equal(isTight(blocks, 1), true);
  assert.equal(isTight(blocks, 2), true);
});

test("a tool row after prose keeps its blank line", () => {
  const blocks = [prose(), tool()];
  assert.equal(isTight(blocks, 1), false);
});

test("the first block never hugs", () => {
  assert.equal(isTight([tool()], 0), false);
});

test("a block with output is separated from the one above it", () => {
  // The reported failure. Both are tool rows, so the old rule hugged them, and the tail
  // of the first command's output landed against the second command's header.
  const blocks = [tool("build ok\nexit 0"), tool("build failed\nexit 1")];
  assert.equal(isTight(blocks, 1), false);
});

test("a one-line row after one with output is still separated", () => {
  // Either side carrying a body is enough. A bare row hugging the last line of somebody
  // else's output reads as part of that output.
  const blocks = [tool("lots\nof\noutput"), tool()];
  assert.equal(isTight(blocks, 1), false);
});

test("a row with output is separated from a one-line row above it", () => {
  const blocks = [tool(), tool("lots\nof\noutput")];
  assert.equal(isTight(blocks, 1), false);
});

test("a one-line note is not a body", () => {
  // `summary` renders beside the row rather than as a block under it, so rows carrying
  // one are still a list and still hug.
  const withNote: Block = { ...(tool() as Extract<Block, { kind: "tool" }>), summary: "195 lines" };
  assert.equal(hasBody(withNote), false);
  assert.equal(isTight([tool(), withNote], 1), true);
});
