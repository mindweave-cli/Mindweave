/**
 * virtualRender.probe.test.tsx — virtualizing must not change a single row on screen.
 *
 * `virtualWindow.test.ts` proves the arithmetic. This proves the thing the arithmetic
 * exists for: that rendering only a slice, with exact spacers standing in for the rest,
 * produces the SAME visible frame as rendering the whole transcript did — at every
 * scroll position, not just at the bottom.
 *
 * That is the guarantee the previous attempt at this could not make. It estimated
 * heights, so its spacers were wrong, so the content drifted and the view jumped. Here
 * the spacers carry measured heights and this probe is what holds them to it: if a
 * spacer is ever off by one row, the frames diverge and this fails.
 *
 * Rendered through a real Ink root into a fake stdout, because the question is about
 * what the terminal receives. See [[feedback-verify-ui-with-probes]].
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Box, Text, render } from "ink";
import { virtualWindow } from "./virtualWindow.js";

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 30;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;?]*[A-Za-z]/g;

/** Visible rows of the last frame written, trailing blanks trimmed. */
function rowsOf(node: React.ReactNode): string[] {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  const instance = render(<>{node}</>, { stdout: stdout as never, stdin, patchConsole: false, interactive: true, debug: true });
  // Read BEFORE unmount, not after — Ink 7 writes a final blank frame on unmount,
  // which would otherwise be mistaken for the real last frame.
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return last
    .replace(ANSI, "")
    .split("\n")
    .map((r) => r.replace(/\s+$/, ""));
}

/** One block: a heading row plus `n - 1` body rows, so its height is known exactly
 *  and its identity is visible in the output. */
function block(i: number, n: number) {
  return (
    <Box key={i} flexShrink={0} flexDirection="column">
      {Array.from({ length: n }, (_, r) => (
        <Text key={r}>{r === 0 ? `## block ${i}` : `   b${i} line ${r}`}</Text>
      ))}
    </Box>
  );
}

const HEIGHTS = [4, 7, 3, 9, 5, 4, 12, 6, 3, 8, 5, 4, 7, 6, 9];
const VIEWPORT = 14;

/** The chat viewport as App.tsx builds it: a clipped box, a negative margin sliding
 *  the content, and the transcript inside. `virtual` switches between rendering every
 *  block and rendering only the window plus exact spacers. */
function Viewport({ shift, virtual }: { shift: number; virtual: boolean }) {
  const win = virtualWindow(HEIGHTS, shift, VIEWPORT);
  const body = virtual ? (
    <>
      {win.padTop > 0 ? <Box flexShrink={0} height={win.padTop} /> : null}
      {HEIGHTS.slice(win.start, win.end).map((n, k) => block(win.start + k, n))}
      {win.padBottom > 0 ? <Box flexShrink={0} height={win.padBottom} /> : null}
    </>
  ) : (
    <>{HEIGHTS.map((n, i) => block(i, n))}</>
  );

  return (
    <Box flexDirection="column" height={VIEWPORT} overflow="hidden">
      <Box flexDirection="column" flexShrink={0} marginTop={-shift}>
        <Box flexDirection="column" flexShrink={0}>{body}</Box>
      </Box>
    </Box>
  );
}

test("the visible frame is identical virtualized and not, at every scroll position", () => {
  const total = HEIGHTS.reduce((a, b) => a + b, 0);
  const maxShift = total - VIEWPORT;
  for (let shift = 0; shift <= maxShift; shift++) {
    const full = rowsOf(<Viewport shift={shift} virtual={false} />);
    const virt = rowsOf(<Viewport shift={shift} virtual={true} />);
    assert.deepEqual(virt, full, `frames diverged at shift=${shift}`);
  }
});

test("virtualizing genuinely renders fewer blocks — the probe is not comparing two full renders", () => {
  // Without this the test above would pass just as happily if `virtual` did nothing.
  const win = virtualWindow(HEIGHTS, 40, VIEWPORT);
  assert.ok(win.end - win.start < HEIGHTS.length, "the window covered everything; nothing was skipped");
  assert.ok(win.padTop > 0, "expected blocks above the window to be replaced by a spacer");
});
