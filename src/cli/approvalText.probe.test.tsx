/**
 * approvalText.probe.test.tsx — the typed answer, rendered.
 *
 * Typecheck and unit tests say nothing about what reaches the screen, and this row is
 * the only part of the plan work a user interacts with directly. Rendered to a fake
 * stream and read back, the way every other UI claim in this codebase is checked.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { ApprovalBox } from "./components/ApprovalBox.js";

/** A writable that records frames, standing in for a terminal. */
function fakeStream() {
  const frames: string[] = [];
  return {
    frames,
    stream: {
      write: (s: string) => void frames.push(s),
      columns: 80,
      rows: 24,
      on: () => {},
      off: () => {},
      removeListener: () => {},
    } as unknown as NodeJS.WriteStream,
  };
}

function frame(node: React.ReactElement): string {
  const { frames, stream } = fakeStream();
  const app = render(node, { stdout: stream, patchConsole: false, interactive: true });
  app.unmount();
  return frames.join("");
}

test("the typed row is offered alongside the choices, not hidden behind a keystroke", () => {
  const out = frame(
    <ApprovalBox
      question="Start on this?"
      options={["Approve", "Reject"]}
      onSelect={() => {}}
      onCancel={() => {}}
      onSubmitText={() => {}}
      freeText={{ label: "Change something", placeholder: "say what to change" }}
      width={70}
      active={false}
    />,
  );
  assert.match(out, /Approve/);
  assert.match(out, /Reject/);
  assert.match(out, /Change something/, "the typed answer was never shown to the user");
  // Numbered with the rest, so it reads as one list rather than a special case.
  assert.match(out, /\[3\]/, "the typed row is not numbered in sequence");
});

test("a box with no typed answer is completely unchanged", () => {
  // Eight of the nine callers want a straight choice, and none of them should have
  // gained a row, a hint change, or an extra blank line.
  const plain = frame(
    <ApprovalBox
      question="Allow this?"
      options={["Yes", "No"]}
      onSelect={() => {}}
      onCancel={() => {}}
      width={70}
      active={false}
    />,
  );
  assert.doesNotMatch(plain, /\[3\]/);
  assert.match(plain, /1-2 · Enter to choose/, "the hint line changed for callers that opted out");
});
