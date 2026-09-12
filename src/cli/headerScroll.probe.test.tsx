/**
 * headerScroll.probe.test.tsx — the pinned banner must survive a scroll, even a bad frame.
 *
 * The reported glitch, in a picture: while scrolling the full-screen transcript, a tool
 * row lands on the banner row for a frame ("●MRun(…) [Timeout: 600s]ek V4.1 Flash …"),
 * then fixes itself. The frame is a fixed-height `overflow:hidden` column — a flexShrink:0
 * banner, the flexGrow:1 `overflow:hidden` chat viewport with the transcript slid up by a
 * NEGATIVE marginTop, and the footer. The suspicion: on a frame where the measurements lag
 * (new content while scrolled near the bottom), the slide over-shoots and a transcript row
 * escapes the viewport's top clip into the banner's rows.
 *
 * This drives the real frame shape at a range of scroll offsets, INCLUDING an over-slide
 * larger than the content actually supports, and asserts the top rows are always the
 * banner and never a transcript row. If the clip holds, the top row is BANNER at every
 * offset; if it leaks, an offset paints XROW where BANNER belongs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text } from "ink";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const settle = (ms = 120): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

class FakeStdout extends EventEmitter {
  columns = 40;
  rows = 12;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
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

const BANNER = "BANNERBANNER";
const FOOTER = "FOOTERFOOTER";
const FRAME_HEIGHT = 12;
const CONTENT_ROWS = 40; // far taller than the viewport, so it always overflows

/** The real full-screen frame shape, with the transcript slid up by `chatOffset`. */
function Frame({ chatOffset }: { chatOffset: number }) {
  return (
    <Box flexDirection="column" height={FRAME_HEIGHT} overflow="hidden">
      <Box flexShrink={0}>
        <Text>{BANNER}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        <Box flexDirection="column" flexShrink={0} marginTop={chatOffset}>
          {Array.from({ length: CONTENT_ROWS }, (_, i) => (
            <Text key={i}>{`XROW${i}X`}</Text>
          ))}
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Text>{FOOTER}</Text>
      </Box>
    </Box>
  );
}

/** The visible rows of the last painted frame, ANSI stripped. */
async function rowsAt(chatOffset: number): Promise<string[]> {
  const stdout = new FakeStdout();
  const instance = render(<Frame chatOffset={chatOffset} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await settle();
  const rows = (stdout.frames.at(-1) ?? "").replace(ANSI, "").split("\n");
  instance.unmount();
  return rows;
}

// The viewport is FRAME_HEIGHT − banner(1) − footer(1) = 10 rows. A transcript of 40 rows
// pins at the bottom with a −30 slide; anything MORE negative is the over-slide a lagged
// measurement produces.
const OFFSETS = [0, -5, -15, -30, -33, -40];

for (const off of OFFSETS) {
  test(`the banner owns the top row at scroll offset ${off}`, async () => {
    const rows = await rowsAt(off);
    const top = rows[0] ?? "";
    assert.ok(top.includes(BANNER), `a transcript row reached the banner at offset ${off}:\n${rows.slice(0, 4).join("\n")}`);
    assert.ok(!/XROW/.test(top), `the top row shows transcript content at offset ${off}: "${top}"`);
  });
}

test("the footer is never overwritten by the transcript either", async () => {
  const rows = await rowsAt(-33); // the over-slide case
  const painted = rows.filter((r) => r.trim() !== "");
  const footer = painted.at(-1) ?? "";
  assert.ok(footer.includes(FOOTER), `the footer was overwritten:\n${rows.join("\n")}`);
});
