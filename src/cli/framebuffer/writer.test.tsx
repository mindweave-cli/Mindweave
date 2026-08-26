/**
 * writer.test.tsx — real Ink output through the framebuffer, end to end.
 *
 * `paint.test.ts` proves the diff is correct for grids built by hand. This proves it
 * against what INK ACTUALLY EMITS, which is the part no amount of unit testing can
 * stand in for: real chalk colour codes, real wrapping, real erase prefixes, real
 * frame-to-frame churn.
 *
 * The shape of every test is the same comparison, and it is the only one that
 * matters:
 *
 *     render the component to a plain stdout           -> the screen Ink INTENDED
 *     render the same component through the framebuffer -> the screen a terminal ENDS UP WITH
 *     assert they are cell-for-cell identical
 *
 * If those ever diverge, the framebuffer is lying about the screen — which is the one
 * failure mode that would make it worse than the full rewrite it replaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";
import { framebufferStdout, type OutputStream } from "./writer.js";

const W = 50;
const H = 12;

/** Collects everything written, and reports a fixed size. */
class FakeStdout extends EventEmitter implements OutputStream {
  columns = W;
  rows = H;
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

/** Every cell, as a comparable snapshot. */
function snapshot(s: Screen): string {
  const parts: string[] = [];
  for (let i = 0; i < s.chars.length; i++) {
    parts.push(`${s.chars[i]}/${s.fg[i]}/${s.bg[i]}/${s.attrs[i]}`);
  }
  return parts.join(" ");
}

const ERASE_PREFIX = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

/**
 * Drive `node` through `steps` renders and return both screens: the one Ink meant to
 * draw, and the one a terminal fed by the framebuffer would be showing.
 */
async function bothScreens(makeNode: (tick: number) => React.ReactElement, steps: number) {
  // --- What Ink intended ---------------------------------------------------
  // Each of Ink's writes is a complete frame (after its erase prefix), so the LAST
  // one is what it wanted on screen.
  const plain = new FakeStdout();
  for (let t = 0; t < steps; t++) {
    const app = render(makeNode(t), {
      stdout: plain as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    app.unmount();
  }
  const intended = new Screen(W, H);
  const frames = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "");
  parseFrame(intended, (frames[frames.length - 1] ?? "").replace(ERASE_PREFIX, ""));

  // --- What the terminal ends up with --------------------------------------
  // One long-lived framebuffer across every step, exactly as the real app runs, with
  // a screen that accumulates each emitted escape the way a terminal would.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const terminal = new Screen(W, H);
  for (let t = 0; t < steps; t++) {
    const before = real.writes.length;
    const app = render(makeNode(t), {
      stdout: fb as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    app.unmount();
    for (const w of real.writes.slice(before)) parseFrame(terminal, w);
  }

  return { intended, terminal, emitted: real.writes };
}

test("a single frame through the framebuffer matches what Ink drew", async () => {
  const { intended, terminal } = await bothScreens(
    () => (
      <Box flexDirection="column">
        <Text>hello world</Text>
        <Text color="green">a green line</Text>
      </Box>
    ),
    1,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("styled and nested output matches — colours, bold, dim, borders", async () => {
  const { intended, terminal } = await bothScreens(
    () => (
      <Box flexDirection="column" borderStyle="round" width={40}>
        <Text bold color="cyan">
          a bold cyan heading
        </Text>
        <Text dimColor>a dim subtitle</Text>
        <Box>
          <Text color="red">red</Text>
          <Text> / </Text>
          <Text backgroundColor="blue">on blue</Text>
        </Box>
      </Box>
    ),
    1,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("many successive frames leave the terminal exactly where Ink expects", async () => {
  // The accumulating case, and the one that catches a diff which is right once and
  // drifts afterwards: each frame is diffed against the previous, so an error in any
  // of them persists into every later screen.
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>counter: {t}</Text>
        <Text color={t % 2 === 0 ? "green" : "red"}>alternating colour</Text>
        <Text>{"x".repeat(t + 1)}</Text>
        <Text>a line that never changes at all</Text>
      </Box>
    ),
    8,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("content that SHRINKS leaves no ghosts behind", async () => {
  // The classic diff bug: text disappears and the old characters are still on screen
  // because nothing wrote over them.
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>{t === 0 ? "a much longer line of text than the next one" : "short"}</Text>
        <Text>{t === 0 ? "second line present" : ""}</Text>
      </Box>
    ),
    2,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("wide characters through the real pipeline stay aligned", async () => {
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>{t === 0 ? "plain ascii row" : "世界 and 🔥 row"}</Text>
        <Text>following row must not shift</Text>
      </Box>
    ),
    2,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("an unchanged re-render puts ZERO bytes on the terminal", async () => {
  // The property the whole exercise exists for. Ink re-renders on every state change
  // whether or not anything is different; if that still costs a full screen write,
  // nothing has been fixed.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const node = (
    <Box flexDirection="column">
      <Text>steady</Text>
      <Text color="magenta">unchanging</Text>
    </Box>
  );

  const first = render(node, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  first.unmount();
  const afterFirst = real.writes.length;

  const second = render(node, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  second.unmount();

  // Ink writes a bare newline on `unmount()`, which is not a frame and is correctly
  // passed straight through. The real app mounts once and never unmounts between
  // renders, so it is an artifact of driving this test with two mounts — excluded
  // rather than papered over, because the claim being made is about FRAME output.
  const added = real.writes.slice(afterFirst).join("").replace(/\n/g, "");
  assert.equal(added, "", `an identical frame wrote ${added.length} bytes: ${JSON.stringify(added)}`);
});

test("one changed character costs a fraction of what Ink would have written", async () => {
  // The measurement that says whether this is worth having, expressed as a test so it
  // cannot silently regress.
  const rows = Array.from({ length: 10 }, (_, i) => `row ${i}: some reasonably long content here`);
  const real = new FakeStdout();
  const fb = framebufferStdout(real);

  let inBytes = 0;
  let outBytes = 0;
  const counting = framebufferStdout(real, (s) => {
    inBytes = s.inBytes;
    outBytes = s.outBytes;
  });
  void fb;

  for (const tick of [0, 1]) {
    const app = render(
      <Box flexDirection="column">
        {rows.map((r, i) => (
          <Text key={i}>{i === 4 && tick === 1 ? "row 4: CHANGED content here          " : r}</Text>
        ))}
      </Box>,
      { stdout: counting as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
    );
    app.unmount();
  }

  assert.ok(inBytes > 300, `expected a substantial frame, got ${inBytes} bytes`);
  assert.ok(
    outBytes < inBytes / 4,
    `one changed row should cost far less than the frame: ${outBytes} out of ${inBytes} bytes`,
  );
});

test("a resize repaints in full rather than diffing against a re-wrapped screen", async () => {
  const real = new FakeStdout();
  const fb = framebufferStdout(real);

  function Harness({ width }: { width: number }) {
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="wrap">a line long enough that a narrower terminal will wrap it onto another row</Text>
      </Box>
    );
  }

  const first = render(<Harness width={W} />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  first.unmount();

  // The terminal narrows. Every recorded cell is now wrong.
  real.columns = 30;
  const beforeResize = real.writes.length;
  const second = render(<Harness width={30} />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  second.unmount();

  const after = real.writes.slice(beforeResize).join("");
  assert.ok(after.length > 0, "a resize must repaint, not assume the old grid still applies");

  // And the result must still be what Ink intended at the new width.
  const plain = new FakeStdout();
  plain.columns = 30;
  const ref = render(<Harness width={30} />, {
    stdout: plain as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  ref.unmount();
  const intended = new Screen(30, H);
  const lastFrame = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "").pop() ?? "";
  parseFrame(intended, lastFrame.replace(ERASE_PREFIX, ""));

  const terminal = new Screen(30, H);
  for (const w of real.writes.slice(beforeResize)) parseFrame(terminal, w);
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("EVERY property of the real stream survives the wrapper, not just the ones we thought of", () => {
  // THE REGRESSION THIS EXISTS FOR. The first version of `framebufferStdout` returned
  // a hand-written object listing the members Ink appeared to need. It did not have
  // `isTTY`, which Ink reads in five places to decide whether it is driving a terminal
  // at all — so Ink took its non-interactive path and the app started to a BLANK
  // SCREEN, with no error anywhere.
  //
  // Every test above passed, because they all pass a fake stdout that has no `isTTY`
  // either: both sides agreed on the wrong thing. So this asserts the general
  // property rather than that one field — anything on the real stream must still be
  // reachable through the wrapper, including things nobody has thought of yet.
  const real = new FakeStdout() as FakeStdout & Record<string, unknown>;
  real.isTTY = true;
  real.someFutureField = 42;
  real.someFutureMethod = function () {
    return this === real;
  };

  const fb = framebufferStdout(real) as typeof real;
  assert.equal(fb.isTTY, true, "isTTY must survive — its absence is what blanked the screen");
  assert.equal(fb.columns, W);
  assert.equal(fb.rows, H);
  assert.equal(fb.someFutureField, 42);
  // Methods must be bound to the REAL stream: a stream's methods reach into its own
  // internal state, and `this` pointing at the wrapper would send them looking on the
  // wrong object.
  assert.equal((fb.someFutureMethod as () => boolean)(), true, "methods must be bound to the real stream");
  // And a live change on the real stream — a terminal resize — must be visible.
  real.columns = 81;
  assert.equal(fb.columns, 81, "the wrapper must not snapshot values");
});

test("non-frame control sequences pass through untouched", async () => {
  // Entering the alternate screen, hiding the cursor, synchronized-update markers —
  // swallowing any of these would break the app in ways the diff cannot express.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const controls = ["\x1b[?1049h", "\x1b[?25l", "\x1b[?2026h", "\x1b[?2026l"];
  for (const c of controls) fb.write(c);
  assert.deepEqual(real.writes, controls);
});

test("a dynamic component driven by state matches Ink throughout", async () => {
  // Closest thing here to the real app: state changing over time inside one mounted
  // tree, rather than a fresh render per step.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const terminal = new Screen(W, H);
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const STEPS = 6;

  function Harness() {
    const [n, setN] = useState(0);
    useEffect(() => {
      if (n < STEPS) setN(n + 1);
      else resolveDone();
    }, [n]);
    return (
      <Box flexDirection="column">
        <Text color="yellow">tick {n}</Text>
        <Text>{"=".repeat(n + 1)}</Text>
        <Text dimColor>stable footer</Text>
      </Box>
    );
  }

  const app = render(<Harness />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await done;
  app.unmount();
  for (const w of real.writes) parseFrame(terminal, w);

  const plain = new FakeStdout();
  const ref = render(
    <Box flexDirection="column">
      <Text color="yellow">tick {STEPS}</Text>
      <Text>{"=".repeat(STEPS + 1)}</Text>
      <Text dimColor>stable footer</Text>
    </Box>,
    { stdout: plain as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  ref.unmount();
  const intended = new Screen(W, H);
  const lastFrame = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "").pop() ?? "";
  parseFrame(intended, lastFrame.replace(ERASE_PREFIX, ""));

  assert.equal(snapshot(terminal), snapshot(intended));
});
