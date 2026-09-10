/**
 * resizePolicy.probe.test.tsx — when a resize reaches the layout.
 *
 * Dragging a terminal's edge used to fill the window with half-drawn shapes that tidied
 * themselves up the moment the drag stopped. That reads as the frame settling late. It
 * is not: the frame was being drawn WRONG and then drawn again.
 *
 * The cause was a debounce on the resize event. A debounce opens a window in which the
 * terminal has already changed size and the app still believes the old one, and anything
 * that renders during it — the spinner, the clock, a streaming delta — lays a frame out
 * at dimensions the terminal no longer has. The app's idea of the size and the terminal's
 * have to agree at every instant, because that is the only state in which a frame can be
 * correct.
 *
 * The inline shell still defers, for a reason that does not apply to the other one: its
 * transcript is the terminal's own scrollback, printed once, so a re-render mid-drag
 * leaves a stale copy of the live region behind it. A slow drag left a ladder of
 * half-drawn input boxes down the screen. Nothing is printed permanently in the
 * full-screen shell, so nothing can be left behind, and it takes every event as it lands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Text } from "ink";
import { useTerminalSize } from "./App.js";

/** A stdout whose size can be changed, and which emits `resize` like a real one. */
class ResizableStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  write(): boolean {
    return true;
  }
  /** Change size and fire the event, the way a terminal does mid-drag. */
  resizeTo(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
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

const wait = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/**
 * Mount the hook, drive a resize, and report the width it saw immediately afterwards
 * and the width it settled on.
 */
async function drive(defer: boolean): Promise<{ immediately: number; settled: number }> {
  const stdout = new ResizableStdout();
  let seen = stdout.columns;
  function Probe(): React.ReactElement {
    const { columns } = useTerminalSize(defer);
    seen = columns;
    return <Text>{String(columns)}</Text>;
  }
  const instance = render(<Probe />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await wait(120);

  stdout.resizeTo(40, 24);
  // Long enough for a synchronous handler and its render, far short of the 150ms the
  // inline shell waits for a drag to settle.
  await wait(30);
  const immediately = seen;
  // Past the settle delay, both policies must have caught up.
  await wait(300);
  const settled = seen;

  instance.unmount();
  return { immediately, settled };
}

test("the FULL-SCREEN shell takes a resize as it lands", async () => {
  const { immediately } = await drive(false);
  assert.equal(immediately, 40, `the layout was still at ${immediately} columns after the terminal became 40`);
});

test("the INLINE shell waits for the drag to settle", async () => {
  // Proves the two policies genuinely differ — without this, the test above would pass
  // for a hook that ignored its argument entirely.
  const { immediately } = await drive(true);
  assert.equal(immediately, 80, `the inline shell reacted mid-drag at ${immediately} columns`);
});

test("both end up at the real size — deferring delays, it never drops", async () => {
  for (const defer of [false, true]) {
    const { settled } = await drive(defer);
    assert.equal(settled, 40, `defer=${defer} settled at ${settled} instead of the terminal's 40`);
  }
});

test("a resize to the SAME size changes nothing", async () => {
  // Terminals emit two or more events for one user action as the window settles. Each
  // one that reached state would re-lay the whole frame for no change at all.
  const stdout = new ResizableStdout();
  let renders = 0;
  function Probe(): React.ReactElement {
    const { columns } = useTerminalSize(false);
    renders++;
    return <Text>{String(columns)}</Text>;
  }
  const instance = render(<Probe />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await wait(120);
  const before = renders;
  for (let i = 0; i < 5; i++) stdout.resizeTo(80, 24);
  await wait(60);
  instance.unmount();
  assert.equal(renders, before, `${renders - before} re-renders for five no-op resizes`);
});
