/**
 * chatAnchor.probe.test.tsx — where the conversation actually LANDS on screen.
 *
 * `chatAnchor.test.ts` proves the arithmetic. This proves the arithmetic reaches the
 * terminal, by rendering the real frame shape — banner, flex-grow chat viewport,
 * pinned footer — through Ink into a fake stdout and counting which row each thing
 * comes out on.
 *
 * That distinction has bitten this UI before: the reported defect here was a short
 * conversation stranded at the top of the screen with a void above the input box,
 * and every unit test in the project passed while it was happening. Typecheck and
 * pure functions say nothing about what a user sees.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text } from "ink";
import { chatLayout } from "./chatAnchor.js";
import { BlockView } from "./components/BlockView.js";

/** A stdout Ink will happily write frames into. */
class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/**
 * Render the frame's real skeleton with `lines` of transcript, and return its rows.
 *
 * The structure mirrors App's: a fixed-height column, a flexShrink:0 banner, a
 * flexGrow:1 clipped chat viewport holding an offset transcript box, and a
 * flexShrink:0 footer. Those are the parts that decide placement; the contents of
 * each are irrelevant to it, so they are stand-ins.
 */
function rowsOf(lines: number, frameHeight: number, chatRows: number): string[] {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

  const { marginTop, restsOnFooter } = chatLayout(lines, chatRows, 0);
  const instance = render(
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      <Box flexShrink={0}>
        <Text>BANNER</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {restsOnFooter ? <Box flexGrow={1} flexShrink={1} /> : null}
        <Box flexDirection="column" flexShrink={0} marginTop={marginTop}>
          {Array.from({ length: lines }, (_, i) => (
            <Box key={i} flexShrink={0}>
              <Text>{`msg${i}`}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Box flexShrink={0}>
          <Text>STATUS</Text>
        </Box>
        <Box flexShrink={0}>
          <Text>INPUTBOX</Text>
        </Box>
        <Box flexShrink={0}>
          <Text>TIPLINE</Text>
        </Box>
      </Box>
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false, debug: true },
  );
  // Read BEFORE unmount, not after — Ink 7 writes a final blank frame on unmount,
  // which would otherwise be mistaken for the real last frame.
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return last.replace(ANSI, "").split("\n");
}

/** Index of the row containing `needle`, or -1. */
function rowOf(rows: string[], needle: string): number {
  return rows.findIndex((r) => r.includes(needle));
}

test("a SHORT conversation sits directly above the input, not at the top", () => {
  // The reported defect, as a frame. Three lines of chat in a 20-row frame.
  const rows = rowsOf(3, 20, 16);
  const lastMsg = rowOf(rows, "msg2");
  const status = rowOf(rows, "STATUS");

  assert.ok(lastMsg > 0, "the conversation must be on screen at all");
  assert.ok(status > lastMsg, "the footer is below the chat");
  assert.equal(status - lastMsg, 1, `expected the reply to rest on the footer, found ${status - lastMsg} rows between`);
});

test("the tip line is the last thing on screen", () => {
  // "Almost touching the bottom": nothing of ours may sit below it. The frame is
  // deliberately one row short of the terminal — see the frameHeight note in App —
  // so the tip being the final rendered row is the whole of the requirement.
  const rows = rowsOf(3, 20, 16).filter((r) => r.trim().length > 0);
  assert.equal(rows[rows.length - 1]!.trim(), "TIPLINE");
});

test("the footer keeps its order and none of it is clipped", () => {
  const rows = rowsOf(3, 20, 16);
  const status = rowOf(rows, "STATUS");
  const input = rowOf(rows, "INPUTBOX");
  const tip = rowOf(rows, "TIPLINE");
  assert.ok(status >= 0 && input === status + 1 && tip === input + 1, `footer rows landed at ${status}/${input}/${tip}`);
});

test("an EMPTY conversation still leaves the footer pinned and whole", () => {
  const rows = rowsOf(0, 20, 16);
  assert.ok(rowOf(rows, "INPUTBOX") >= 0, "the input box must survive an empty transcript");
  assert.ok(rowOf(rows, "TIPLINE") > rowOf(rows, "INPUTBOX"));
});

test("a LONG conversation still fills the viewport and shows its newest lines", () => {
  // The scrolled regime, which the change must not have touched: with 40 lines in a
  // 12-row viewport, the newest must be visible and the oldest clipped away.
  const rows = rowsOf(40, 20, 16);
  assert.ok(rowOf(rows, "msg39") >= 0, "the newest line must be on screen when pinned to the bottom");
  assert.equal(rowOf(rows, "msg0"), -1, "the oldest line must have scrolled off");
  assert.ok(rowOf(rows, "TIPLINE") > rowOf(rows, "msg39"), "the footer stays below the chat");
});

test("the banner is never pushed off the top by the spacer", () => {
  for (const lines of [0, 1, 5, 15, 16, 17, 40]) {
    const rows = rowsOf(lines, 20, 16);
    assert.equal(rowOf(rows, "BANNER"), 0, `banner moved with ${lines} lines of chat`);
  }
});

test("a STALE viewport measurement cannot hide the conversation", () => {
  // The failure the first attempt at this shipped, caught by this probe. `chatRows`
  // is measured and lags a frame — it is 0 on the very first render. A version that
  // padded the transcript down by `chatRows - contentHeight` pushed it past the clip
  // edge whenever that number ran large, and the whole conversation vanished.
  //
  // Here the spacer is sized by Yoga from the real leftover space, so every one of
  // these disagreeing measurements still puts the text on screen.
  for (const claimed of [0, 1, 8, 16, 40, 999]) {
    const rows = rowsOf(3, 20, claimed);
    assert.ok(rowOf(rows, "msg2") >= 0, `the newest line vanished when chatRows claimed ${claimed}`);
    assert.ok(rowOf(rows, "TIPLINE") >= 0, `the tip vanished when chatRows claimed ${claimed}`);
  }
});

test("PROBE: prose fills the window instead of sitting in a narrow column", () => {
  // Reported by comparing two windows side by side: the answer wrapped at the same
  // width whether the terminal was 90 columns or 190, leaving a third of a wide
  // window empty beside it. Prose was capped at 88 columns on a typographic argument
  // that is right for a printed page and wrong for a pane the reader sized on purpose.
  const wide = renderProse(160);
  const narrow = renderProse(70);
  assert.ok(
    wide > narrow + 40,
    `widening the terminal did not widen the text: ${narrow} columns at 70, ${wide} at 160`,
  );
  assert.ok(wide > 120, `a 160 column terminal wrapped prose at ${wide}`);
});

/** Longest rendered line of an assistant block at a given terminal width. */
function renderProse(columns: number): number {
  const stdout = new FakeStdout();
  stdout.columns = columns;
  stdout.rows = 24;
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

  const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const instance = render(
    <BlockView block={{ kind: "assistant", id: 1, done: true, text }} columns={columns} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false },
  );
  instance.unmount();
  const frame = stdout.frames.at(-1) ?? "";
  return Math.max(
    0,
    ...frame
      .split(/\r?\n/)
      .map((l) => l.replace(ANSI, "").replace(/\s+$/, "").length),
  );
}
