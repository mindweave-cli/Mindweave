/**
 * readingClose.probe.test.tsx — closing the reading view must not leave a hole.
 *
 * The reported symptom, in order, across three attempts at this feature:
 *
 *   1. a flash of empty screen when the view closed, then the screen filled in
 *   2. (reprint removed) a permanent band of empty screen below the prompt
 *
 * Both are the same fact. Closing shrinks the live region from a near-full-height frame
 * to a couple of rows, and a terminal cannot un-scroll. Measured against the real
 * renderer, that shrink emits `eraseLine` once per row of the OLD height and then writes
 * only the new, short output — every row in between is blanked with nothing put back.
 *
 * That is not an Ink bug, and it is invisible everywhere else in this app, because a
 * live region normally shrinks only when a block DRAINS into `<Static>` — which prints
 * those same rows permanently on the way past, so the total never drops. A viewport
 * closing drains nothing.
 *
 * So the close reprints, and the ONLY question this file exists to answer is whether the
 * reprint lands in the same frame as the shrink. One render late it is symptom 1; absent
 * it is symptom 2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useRef, useState } from "react";
import { render, Box, Text, Static } from "ink";

const ROWS = 24;
const FRAME_HEIGHT = ROWS - 1;

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = ROWS;
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

const settle = (ms = 120): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

const HISTORY = Array.from({ length: 30 }, (_, i) => `block-${i}`);

/** Rows erased by a write, and rows of real content it puts back. */
function accountFor(write: string): { erased: number; written: number } {
  const erased = (write.match(/\x1b\[2K/g) ?? []).length;
  const written = write
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
  return { erased, written };
}

/**
 * The inline shell's shape, with the three ways of handling the close selected by
 * `mode`. `reprintFrom` mirrors App's ref: how far back into history a remount reprints.
 */
function Shell({
  reading,
  mode,
}: {
  reading: boolean;
  mode: "none" | "effect" | "render";
}): React.ReactElement {
  const [epoch, setEpoch] = useState(0);
  const reprintFrom = useRef(HISTORY.length);
  const wasReading = useRef(reading);

  // The fix: refill decided during render, so it commits with the shrink.
  if (mode === "render" && wasReading.current && !reading) {
    reprintFrom.current = 0;
    epoch.toString(); // read, so the dependency is explicit to a reader
    wasReading.current = reading;
  }

  // The first attempt: refill decided in an effect, one render late.
  useEffect(() => {
    if (mode === "effect" && wasReading.current && !reading) {
      reprintFrom.current = 0;
      setEpoch((n) => n + 1);
    }
    wasReading.current = reading;
  }, [reading, mode]);

  const renderEpoch = mode === "render" && reprintFrom.current === 0 ? epoch + 1 : epoch;

  return (
    <Box flexDirection="column">
      <Static key={renderEpoch} items={HISTORY.slice(reprintFrom.current)}>
        {(it) => <Text key={it}>{it}</Text>}
      </Static>
      <Box flexDirection="column" height={reading ? FRAME_HEIGHT : undefined}>
        {reading
          ? Array.from({ length: FRAME_HEIGHT - 1 }, (_, i) => <Text key={i}>{`frameline${i}`}</Text>)
          : <Text>tail</Text>}
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

/** Close the reading view and return every write the close produced. */
async function writesOnClose(mode: "none" | "effect" | "render"): Promise<string[]> {
  const stdout = new FakeStdout();
  const instance = render(<Shell reading={true} mode={mode} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await settle();
  stdout.writes.length = 0;
  instance.rerender(<Shell reading={false} mode={mode} />);
  await settle();
  instance.unmount();
  return stdout.writes;
}

test("the shrink really does erase far more rows than it writes back", async () => {
  // The measurement the whole fix rests on. If this stops holding, Ink's shrink
  // behaviour changed and everything below needs revisiting.
  const totals = (await writesOnClose("none")).reduce(
    (acc, w) => {
      const { erased, written } = accountFor(w);
      return { erased: acc.erased + erased, written: acc.written + written };
    },
    { erased: 0, written: 0 },
  );
  assert.ok(totals.erased >= FRAME_HEIGHT, `expected ~${FRAME_HEIGHT} rows erased, saw ${totals.erased}`);
  assert.ok(
    totals.written < totals.erased - 5,
    `expected a hole: ${totals.erased} erased vs ${totals.written} written back`,
  );
});

test("refilling from an EFFECT leaves a frame with the hole still open", async () => {
  // Symptom 1: the empty flash. The close paints, THEN the refill paints. Two frames,
  // and the first one is the hole.
  const writes = await writesOnClose("effect");
  const frames = writes.filter((w) => w.includes("FOOTER"));
  assert.ok(frames.length >= 2, `expected the refill to be a second frame, saw ${frames.length}`);
});

test("refilling during RENDER puts the rows back in the same frame — no hole, no flash", async () => {
  const writes = await writesOnClose("render");
  const frames = writes.filter((w) => w.includes("FOOTER"));
  assert.equal(frames.length, 1, `the close should be a single frame, was ${frames.length}`);

  const totals = writes.reduce(
    (acc, w) => {
      const { erased, written } = accountFor(w);
      return { erased: acc.erased + erased, written: acc.written + written };
    },
    { erased: 0, written: 0 },
  );
  assert.ok(
    totals.written >= totals.erased,
    `rows were left blank: ${totals.erased} erased, only ${totals.written} written back`,
  );
});

test("the refilled frame carries real conversation, not blank padding", async () => {
  // Filling the hole with empty rows would satisfy a row count and still look like the
  // bug. What goes back has to be the transcript.
  const joined = (await writesOnClose("render")).join("");
  assert.match(joined, /block-/, "the refill printed no history at all");
  assert.match(joined, /FOOTER/, "the prompt is missing from the refilled frame");
});

// ── a scrollback printer and a viewport cannot both be writing ──────────────
//
// The third distinct failure in this feature, and the one with the clearest rule
// behind it. While the reading viewport is open, every finished block still wanted to
// go to `<Static>`, which prints permanently and scrolls the terminal to make room —
// under a near-full-height frame that Ink then re-lays from its new position. On screen
// that is a band of blank where a block is about to appear, and it shows up only while
// a turn is running, because that is the only time new blocks arrive.
//
// The conflict exists only because this shell has both a scrollback printer and a
// viewport. Either one alone is safe; running them together is what needs the rule.

function StaticUnderViewport({ items, frozenAt }: { items: string[]; frozenAt: number | null }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={items.slice(0, frozenAt ?? undefined)}>{(it) => <Text key={it}>{it}</Text>}</Static>
      <Box flexDirection="column" height={FRAME_HEIGHT}>
        {Array.from({ length: FRAME_HEIGHT - 1 }, (_, i) => (
          <Text key={i}>{`view${i}`}</Text>
        ))}
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

/** Three blocks land while the viewport is open. Returns what reached the terminal. */
async function blocksArrivingDuringReading(freeze: boolean): Promise<{ erased: number; emitted: number }> {
  const stdout = new FakeStdout();
  const items = ["b0", "b1", "b2"];
  const frozenAt = freeze ? items.length : null;
  const instance = render(<StaticUnderViewport items={[...items]} frozenAt={frozenAt} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await settle();
  stdout.writes.length = 0;
  for (const extra of ["b3", "b4", "b5"]) {
    items.push(extra);
    instance.rerender(<StaticUnderViewport items={[...items]} frozenAt={frozenAt} />);
    await settle(40);
  }
  instance.unmount();
  let erased = 0;
  let emitted = 0;
  for (const w of stdout.writes) {
    erased += (w.match(/\x1b\[2K/g) ?? []).length;
    if (/b[345]/.test(w)) emitted++;
  }
  return { erased, emitted };
}

test("blocks printing into scrollback under an open viewport really do tear up the screen", async () => {
  // The measurement the freeze rests on: three blocks, and far more rows erased than
  // the terminal even has.
  const live = await blocksArrivingDuringReading(false);
  assert.ok(live.emitted > 0, "the unfrozen case printed nothing, so it proves nothing");
  assert.ok(
    live.erased > ROWS,
    `expected the screen to be torn up repeatedly, only ${live.erased} rows erased in a ${ROWS}-row terminal`,
  );
});

test("freezing the printer while the viewport is open writes nothing at all", async () => {
  const frozen = await blocksArrivingDuringReading(true);
  assert.equal(frozen.emitted, 0, "a block reached scrollback while the viewport was open");
  assert.equal(frozen.erased, 0, `the screen was still erased ${frozen.erased} times with the printer held`);
});
