/**
 * frameBottom.probe.test.tsx — the full-screen frame reaches the terminal's bottom edge.
 *
 * The reported bug, in a picture: the banner at the top, then the conversation and the
 * input clustered part-way down, and a band of dead black all the way to the bottom edge.
 * The layout was proven correct at a known height, so the fault was the height itself:
 * `stdout.rows` cached small (Windows, no resize event), the frame sized from it, and it
 * stopped short of the real bottom.
 *
 * This drives the real frame-height rule with a stdout whose CACHED getter is stale and
 * whose live `getWindowSize` is correct, and checks the frame follows the live value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text } from "ink";
import { liveTerminalSize } from "./App.js";

/** A stdout whose `.rows` is FROZEN small while `getWindowSize` reports the real height. */
class StaleGetterStdout extends EventEmitter {
  columns = 80;
  rows = 24; // cached at an old, short height and never refreshed
  isTTY = true as const;
  frames: string[] = [];
  #liveRows: number;
  constructor(liveRows: number) {
    super();
    this.#liveRows = liveRows;
  }
  getWindowSize(): [number, number] {
    return [this.columns, this.#liveRows];
  }
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  return stdin;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const settle = (ms = 150): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

test("the frame height follows the LIVE size, not the stale cached getter", () => {
  // The rule the frame uses, isolated. `liveTerminalSize` must return the live 50, not
  // the cached 24, or `frameHeight` is computed against a height the terminal outgrew.
  const stdout = new StaleGetterStdout(50);
  assert.equal(liveTerminalSize(stdout).rows, 50);
  const frameHeight = Math.max(3, liveTerminalSize(stdout).rows);
  assert.equal(frameHeight, 50, "the frame did not grow to the live height");
});

test("the footer lands on the VERY LAST row of the live terminal, nothing below it", async () => {
  const LIVE = 30;
  const stdout = new StaleGetterStdout(LIVE); // .rows says 24, the window is really 30
  const frameHeight = Math.max(3, liveTerminalSize(stdout).rows);

  const instance = render(
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      <Box flexShrink={0}>
        <Text>BANNER</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} />
        <Box flexDirection="column" flexShrink={0}>
          <Text>chat0</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <Box flexShrink={0}><Text> </Text></Box>
        <Box flexShrink={0}><Text>INPUTBOX</Text></Box>
        <Box flexShrink={0}><Text>TIPLINE</Text></Box>
      </Box>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  await settle();
  const rows = (stdout.frames.at(-1) ?? "").replace(ANSI, "").split("\n");
  instance.unmount();

  const tip = rows.findIndex((r) => r.includes("TIPLINE"));
  assert.ok(tip >= 0, `the footer never painted:\n${rows.join("\n")}`);
  const deadBelow = LIVE - 1 - tip;
  assert.equal(deadBelow, 0, `the footer sits ${deadBelow} rows above the bottom of a ${LIVE}-row terminal — it must be ON the last row`);

  // And the content rests just above the footer — the chat + input clustered at the
  // bottom, which is the whole look being matched.
  const chat = rows.findIndex((r) => r.includes("chat0"));
  const input = rows.findIndex((r) => r.includes("INPUTBOX"));
  assert.ok(chat < input && input < tip, "content, input and tip are not stacked at the bottom");
});

test("the fix changes both things at once: live height AND the full last row", () => {
  // Two bugs stacked to make the reported void — the frame sized from a stale small
  // height, and then held one row short of even that. The old numbers, for contrast.
  const LIVE = 30;
  const oldFrame = Math.max(3, 24 - 1); // stale-cached 24, minus the one-row inset
  const newFrame = Math.max(3, liveTerminalSize(new StaleGetterStdout(LIVE)).rows);
  assert.equal(oldFrame, 23, "the old frame occupied only 23 of the terminal's 30 rows");
  assert.equal(newFrame, 30, "the new frame fills the terminal");
  // The old footer sat at row 22 (oldFrame-1); the new footer sits at row 29 (the last).
  assert.equal(LIVE - 1 - (oldFrame - 1), 7, "the old footer floated 7 rows above the bottom");
  assert.equal(LIVE - 1 - (newFrame - 1), 0, "the new footer is on the last row");
});
