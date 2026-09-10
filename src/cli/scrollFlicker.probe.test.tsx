/**
 * scrollFlicker.probe.test.tsx — a hypothesis this project tried and disproved.
 *
 * The reported symptom: a flicker starting to scroll up in the inline shell, and
 * another arriving back at the bottom. The first theory was that `openReading` set
 * two pieces of state, `reading` then `scrollUp`, and that Ink's react-reconciler runs
 * React in LEGACY mode where updates issued outside a React-recognized event are not
 * batched — so two `setState` calls would flush two separate commits, painting two
 * frames for one gesture.
 *
 * That is checked here, and it does NOT hold: two synchronous `setState` calls issued
 * back to back, with nothing awaited in between, coalesce into ONE commit regardless of
 * legacy vs concurrent mode — batching here is decided by whether the reconciler's work
 * loop gets a turn to run BETWEEN the calls, not by which API dispatched them. Since
 * `openReading` never yielded between its two calls, they were always one paint. This
 * file exists so nobody re-reaches for that fix a second time.
 *
 * The real cause was structural, not temporal, and lives in
 * `footerRemount.probe.test.tsx`: the inline shell put the footer at a different CHILD
 * INDEX in the reading branch than in the tail branch, and a different position is, to
 * React's reconciler, indistinguishable from a different element — so the footer's
 * whole subtree was destroyed and rebuilt on every transition. That fix (one wrapper,
 * footer always the same child) is what actually removed the flicker.
 *
 * `reading` was still worth deriving from `scrollUp` rather than tracked as its own
 * state — it removed a whole state variable and the effect that used to close it a
 * render late, which is real hygiene even though it turned out not to be the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useState } from "react";
import { render, Box, Text } from "ink";

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 20;
  isTTY = true as const;
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
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

const settle = (ms = 60): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** A frame is a real paint: Ink also writes bare control sequences between them. */
function isFrame(w: string): boolean {
  return /READING|TAIL/.test(w);
}

/** Two synchronous `setState` calls, one right after the other — the shape the first
 *  theory blamed. */
function TwoSyncUpdates({ trigger }: { trigger: (fn: () => void) => void }): React.ReactElement {
  const [reading, setReading] = useState(false);
  const [scrollUp, setScrollUp] = useState(0);
  trigger(() => {
    setReading(true);
    setScrollUp((s) => s + 3);
  });
  return <Text>{reading ? `READING ${scrollUp}` : "TAIL"}</Text>;
}

/** The shape actually used now: one `setState` call, `reading` derived from it. */
function OneUpdateDerived({ trigger }: { trigger: (fn: () => void) => void }): React.ReactElement {
  const [scrollUp, setScrollUp] = useState(0);
  const reading = scrollUp > 0;
  trigger(() => setScrollUp((s) => Math.max(1, s + 3)));
  return <Text>{reading ? `READING ${scrollUp}` : "TAIL"}</Text>;
}

async function paintsForOneGesture(Shape: typeof TwoSyncUpdates): Promise<number> {
  const stdout = new FakeStdout();
  let fire: (() => void) | undefined;
  const instance = render(
    <Box>
      <Shape trigger={(fn) => (fire = fn)} />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true },
  );
  await settle();
  stdout.writes.length = 0;
  fire!(); // the single gesture — one wheel notch, one keystroke
  await settle();
  const painted = stdout.writes.filter(isFrame).length;
  instance.unmount();
  return painted;
}

test("two synchronous setState calls for one gesture still paint ONCE — the disproven theory", async () => {
  // If this ever starts failing, something about how Ink schedules commits changed, and
  // the reasoning above needs revisiting — but it would mean the ORIGINAL two-state
  // shape was fine after all, not that anything here regressed.
  const painted = await paintsForOneGesture(TwoSyncUpdates);
  assert.equal(painted, 1, `expected one commit for two synchronous calls, got ${painted}`);
});

test("the shape actually used — one update, reading derived — also paints once", async () => {
  const painted = await paintsForOneGesture(OneUpdateDerived);
  assert.equal(painted, 1, `opening should be one paint, was ${painted}`);
});
