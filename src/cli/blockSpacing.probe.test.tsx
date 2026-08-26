/**
 * blockSpacing.probe.test.tsx — the blank lines between blocks actually reach the screen.
 *
 * `markdown.test.ts` proves renderMarkdown separates blocks, and `wrap.test.ts` proves
 * the wrapper keeps the separation. Neither could see the defect that made structured
 * answers render as one undifferentiated wall, because it lived one layer further down:
 *
 *   Ink's measureText returns { width: 0, height: 0 } for an empty string, so
 *   <Text>{""}</Text> occupies NO ROW. Every blank line the renderer produced was
 *   dropped by the layout engine, silently.
 *
 * Reproduced with a bare Ink render, no Mindweave code involved — rows ["A","","B"]
 * came back as ["A","B"] with "" and as ["A","","B"] with " ". So this renders the real
 * block through Ink into a fake stdout and reads the rows back, which is the only place
 * the question can be asked. See [[feedback-verify-ui-with-probes]].
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BlockView } from "./components/BlockView.js";
import type { Block } from "./transcript.js";

class FakeStdout extends EventEmitter {
  columns = 76;
  rows = 40;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;?]*[A-Za-z]/g;

/** Render one block and return its visible rows, trailing spaces trimmed. */
function rowsOf(block: Block): string[] {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

  const instance = render(<BlockView block={block} columns={76} tightTop={false} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  // Read BEFORE unmount, not after — Ink 7 writes a final blank frame on unmount
  // (part of its "flush pending renders and await stdout drain" fix), which would
  // otherwise be mistaken for the real last frame.
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return last
    .replace(ANSI, "")
    .split("\n")
    .map((r) => r.replace(/\s+$/, ""));
}

const assistant = (text: string): Block => ({ kind: "assistant", id: 1, done: true, text });

/** The shape a model actually writes a summary in: labels, lists, no blank lines. */
const WALL = [
  "Looking at the backlog, here are the most impactful next features:",
  "**Quick wins:**",
  "- **Sepia theme** adds a third colour mode, already a CSS variable swap away.",
  "- **Font picker** lets users choose serif or sans-serif and a size.",
  "**Medium features:**",
  "- **Version history** snapshots documents on save and browses old versions.",
  "What appeals to you?",
].join("\n");

test("a structured answer reaches the screen with its blocks separated", () => {
  const rows = rowsOf(assistant(WALL));
  const body = rows.filter((r) => r.trim() !== "");
  const firstBody = rows.findIndex((r) => r.trim() !== "");
  const lastBody = rows.length - 1 - [...rows].reverse().findIndex((r) => r.trim() !== "");
  const blanks = rows.slice(firstBody, lastBody + 1).filter((r) => r.trim() === "").length;

  assert.ok(body.length >= 7, `the answer did not render:\n${rows.join("\n")}`);
  assert.ok(
    blanks >= 4,
    `blocks are hugging — ${blanks} blank rows inside the answer, expected one per boundary:\n${rows.join("\n")}`,
  );
});

test("a heading is not glued to the list under it", () => {
  const rows = rowsOf(assistant(WALL));
  const label = rows.findIndex((r) => /Quick wins/.test(r));
  assert.ok(label >= 0, "the label did not render");
  assert.equal(rows[label + 1]?.trim(), "", `the list starts immediately under the label:\n${rows.join("\n")}`);
});

test("a list item's wrapped text hangs under the item, not under its bullet", () => {
  const rows = rowsOf(
    assistant("- Font picker lets users choose between serif and sans-serif faces and set a size for each"),
  );
  const bullet = rows.findIndex((r) => r.includes("•"));
  assert.ok(bullet >= 0, `no bullet rendered:\n${rows.join("\n")}`);
  const next = rows[bullet + 1] ?? "";
  assert.ok(next.trim() !== "", "the item must actually wrap for this test to mean anything");
  assert.match(next, /^\s{4}\S/, `continuation sits at the bullet's column:\n${rows.join("\n")}`);
});

test("a one-line reply gains no spurious blank rows", () => {
  // The fix renders a blank line as a space; it must not invent lines that were not there.
  const rows = rowsOf(assistant("Yes, dist is current. Go ahead."));
  const inner = rows.join("\n").trim().split("\n");
  assert.equal(inner.length, 1, `a plain sentence rendered as ${inner.length} rows:\n${rows.join("\n")}`);
});
