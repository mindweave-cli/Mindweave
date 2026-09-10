/**
 * stoodDown.test.tsx — the framebuffer must be SILENT in the inline shell.
 *
 * `writer.ts` addresses the terminal absolutely: every run it paints is `ESC[row;colH`,
 * and so is the cursor it parks afterwards. That is exactly right while the app owns the
 * screen, and it is destructive the moment it does not.
 *
 * In the inline shell the app owns only the last few rows. Row 1 there is not the top of
 * our output, it is the top of a terminal full of the user's scrollback — so an absolute
 * write lands somewhere in the middle of the conversation. The failure it produced was
 * not obviously a rendering bug either: the cursor was parked near the top of the window,
 * and the damage only became visible when the process exited and the SHELL printed its
 * own prompt at the cursor, straight over the transcript, seventeen characters of a
 * paragraph replaced by `C:\...>`.
 *
 * Two paths reached the terminal without asking whether the framebuffer was still in
 * charge: the after-the-burst repaint, whose timer is armed by the last frame of the
 * previous shell and fires a moment AFTER the switch, and the overlay re-tint. Both are
 * covered here, along with the invariant that makes a third one impossible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useRef } from "react";
import { Box, Text, render, type DOMElement } from "ink";
import { framebufferStdout, setFramebufferEnabled, type OutputStream } from "./writer.js";
import { setFrameOverlay, repaintOverlay } from "./overlay.js";
import { declareCaret } from "../caretPark.js";

class FakeStdout extends EventEmitter implements OutputStream {
  columns = 50;
  rows = 12;
  writes: string[] = [];
  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
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

/** An absolute cursor move — the sequence that must never leave here while stood down. */
const ABSOLUTE = /\x1b\[\d+;\d+H/;

/** Longer than IDLE_REPAINT_MS (400ms), so the after-the-burst repaint has had its turn. */
const settle = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** A component that declares a caret, so the cursor-parking path is live. */
function Caretful(): React.ReactElement {
  const ref = useRef<DOMElement | null>(null);
  declareCaret({ ref, column: 3 });
  return (
    <Box ref={ref} flexDirection="column">
      <Text>hello world</Text>
    </Box>
  );
}

/**
 * Render a frame with the framebuffer up, then stand it down and collect everything it
 * writes afterwards — with both of the paths that bypass the normal write poked.
 */
async function afterStandingDown(): Promise<string[]> {
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  const instance = render(<Caretful />, {
    stdout: framebufferStdout(stdout) as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await settle(100);

  // The switch to the inline shell. Everything from here is the terminal's, not ours.
  setFramebufferEnabled(false);
  stdout.writes.length = 0;

  // The overlay re-tint, and then long enough for the repaint the last frame armed.
  setFrameOverlay((screen) => screen);
  repaintOverlay();
  await settle(700);

  instance.unmount();
  setFrameOverlay(null);
  return stdout.writes;
}

test("stood down, the framebuffer writes nothing at all", async () => {
  const writes = await afterStandingDown();
  assert.deepEqual(writes, [], `the framebuffer wrote while stood down: ${JSON.stringify(writes)}`);
});

test("in particular, no ABSOLUTE cursor move escapes — that is what lands in the scrollback", async () => {
  const writes = await afterStandingDown();
  const stray = writes.filter((w) => ABSOLUTE.test(w));
  assert.deepEqual(stray, [], `absolute positioning reached a terminal we do not own: ${JSON.stringify(stray)}`);
});

test("and it has NOT simply been switched off — with the screen ours, it still paints", async () => {
  // The other direction, or every test above passes for a framebuffer that does nothing.
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  const instance = render(<Caretful />, {
    stdout: framebufferStdout(stdout) as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await settle(700);
  instance.unmount();
  const joined = stdout.writes.join("");
  assert.match(joined, /hello world/, "no frame was painted at all");
  assert.match(joined, ABSOLUTE, "the painter stopped addressing cells absolutely");
});

// ── coming back up: the alternate screen must not be left blank ─────────────
//
// The order a shell switch happens in is what makes this necessary. React renders the
// shell being ENTERED first, and Ink writes that frame immediately — while the
// framebuffer is still stood down, so it goes out untouched and lands on the screen
// being left behind. Only then does the effect run: the alternate screen is entered,
// which is blank, and the framebuffer is switched back on.
//
// At that point Ink is holding output identical to what it just wrote, so it writes
// nothing more, and nothing else is scheduled to. Without a repaint from this side the
// alternate screen stays empty until something unrelated causes a render.

/** A frame with real cells in it, as Ink would emit. */
const A_FRAME = "hello world\nsecond line\nthird line\n";

test("re-enabling paints the last frame, so the screen is not left blank", () => {
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  const wrapped = framebufferStdout(stdout);

  setFramebufferEnabled(false); // going inline
  wrapped.write(A_FRAME); // the frame for the shell being entered, written while down
  stdout.writes.length = 0;

  setFramebufferEnabled(true); // the effect: alt screen entered, framebuffer back on
  const painted = stdout.writes.join("");
  assert.match(painted, /hello world/, "nothing was painted — the alternate screen stays blank");
  assert.match(painted, /third line/, "only part of the frame was repainted");
});

test("the repaint goes out as a normal frame, wrapped for an atomic swap", () => {
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  const wrapped = framebufferStdout(stdout);
  setFramebufferEnabled(false);
  wrapped.write(A_FRAME);
  stdout.writes.length = 0;
  setFramebufferEnabled(true);
  const drawing = stdout.writes.filter((w) => w.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() !== "");
  assert.ok(drawing.length > 0, "nothing was drawn");
  for (const w of drawing) {
    assert.ok(w.includes("\x1b[?2026h"), "the repaint went out unsynchronized");
  }
});

test("a bare control sequence is not mistaken for a frame", () => {
  // Entering the alternate screen, hiding the cursor and the synchronized-update
  // markers all pass through while stood down. Keeping one of those as "the last frame"
  // would mean repainting nothing at all on the way back up.
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  const wrapped = framebufferStdout(stdout);
  setFramebufferEnabled(false);
  wrapped.write(A_FRAME);
  wrapped.write("\x1b[?25l"); // hide cursor — must not replace the remembered frame
  wrapped.write("\x1b[?2026h");
  stdout.writes.length = 0;
  setFramebufferEnabled(true);
  assert.match(stdout.writes.join(""), /hello world/, "a control sequence displaced the remembered frame");
});

test("with nothing ever written, re-enabling paints nothing rather than guessing", () => {
  // A session that STARTS in the full-screen shell has no earlier frame, and inventing
  // one would put stale or empty content on a screen that is about to be drawn properly.
  setFramebufferEnabled(true);
  const stdout = new FakeStdout();
  framebufferStdout(stdout);
  setFramebufferEnabled(false);
  stdout.writes.length = 0;
  setFramebufferEnabled(true);
  assert.deepEqual(stdout.writes, [], "something was painted with no frame to paint");
});
