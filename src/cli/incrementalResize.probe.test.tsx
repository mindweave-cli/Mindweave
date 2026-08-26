/**
 * incrementalResize.probe.test.tsx — the one real caveat on `incrementalRendering`.
 *
 * Ink's own tracker has a known, closed-as-not-planned bug: incremental mode counts
 * LINES (splitting on `\n`), not the rows a line actually occupies once the terminal
 * WRAPS it. Shrink the terminal mid-render and a line that used to be one row can
 * become two, but the diff still erases only the old line count — stale content can
 * be left on screen (github.com/vadimdemedes/ink/issues/907).
 *
 * Mindweave's own scroll math (`chatAnchor.ts`) already gets its row counts from
 * `measureElement`, which is the ACTUAL rendered height and already accounts for
 * wrapping — that mechanism is untouched by this flag. What this probe checks is
 * narrower and is the thing that actually could go wrong: whether Ink's OWN
 * incremental writer corrupts the frame across a resize, independent of whether our
 * layout math is right. If this ever fails, that is the signal to stop trusting
 * `incrementalRendering` and fall back to the default full-rewrite mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, Text, render } from "ink";

class FakeStdout extends EventEmitter {
  columns: number;
  rows = 30;
  frames: string[] = [];
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;?]*[A-Za-z]/g;

/** A line long enough that shrinking the terminal forces it to wrap onto a second
 *  row — the exact condition the known bug needs to trigger. */
const LONG_LINE = "This line is intentionally long enough that a narrower terminal wraps it onto a second row.";

test("shrinking the terminal mid-render leaves no stale content, with incremental rendering on", () => {
  const stdout = new FakeStdout(100);
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};

  let done: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));

  function Harness() {
    const [tick, setTick] = useState(0);
    useEffect(() => {
      if (tick === 0) {
        // Simulate a resize: the terminal narrows, which is when the reported bug
        // needs the width to change for a line's WRAPPED row count to change too.
        stdout.columns = 40;
        setTick(1);
      } else {
        done();
      }
    }, [tick]);

    return (
      <Box flexDirection="column" width={stdout.columns}>
        <Text>marker-a-{tick}</Text>
        <Text wrap="wrap">{LONG_LINE}</Text>
        <Text>marker-b-{tick}</Text>
      </Box>
    );
  }

  const instance = render(<Harness />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    incrementalRendering: true,
  });

  return finished.then(() => {
    instance.unmount();
    const last = (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, "");

    // The markers prove the frame settled on tick=1's content, not a mix of both.
    assert.ok(last.includes("marker-a-1"), `stale tick=0 content survived:\n${last}`);
    assert.ok(last.includes("marker-b-1"), `stale tick=0 content survived:\n${last}`);
    assert.ok(!last.includes("marker-a-0") && !last.includes("marker-b-0"), `old frame leaked through:\n${last}`);
  });
});
