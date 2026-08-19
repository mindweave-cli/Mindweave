/**
 * typingPerf.probe.test.tsx — what ONE KEYSTROKE actually costs, end to end.
 *
 * Every previous attempt at the typing lag measured a layer and declared victory:
 * React's `<Profiler>` (which cannot see Yoga), then bytes written (which cannot see
 * CPU). Both improved by large factors and the user felt no difference. So this probe
 * measures the only thing that matters — the wall time from a key arriving on stdin to
 * the frame reaching stdout.
 *
 * That latency is NOT the cost of the work. Under Ink 7 the render is asynchronous
 * (the update is scheduled, not flushed inside the event handler) and Ink throttles it
 * to `maxFps`, defaulting to 30 — a ~34ms window whose trailing edge every keystroke
 * waits out while you are typing continuously. So the floor is a timer, and it is
 * present with an EMPTY transcript. That is the finding this file exists to hold onto:
 * it is why memoizing blocks, virtualizing the transcript and cutting bytes 13x each
 * measured well and left typing feeling identical.
 *
 * Two traps hit while writing this, both of which reported a confident wrong answer:
 *
 *  1. Emitting `data` on the fake stdin measured 0.00ms/key. Ink 7 listens for
 *     `readable` and pulls with `read()`, so the keys went nowhere. A probe that
 *     measures nothing reports zero and looks like a triumph — hence the frame-count
 *     guard in `keystrokeMs`, which turns "measured nothing" into a failure.
 *  2. A fake stdout without `isTTY` makes Ink take its non-interactive path, where it
 *     renders once and never again, so no keystroke ever produces a frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Box, Text, render } from "ink";
import { BlockView } from "./components/BlockView.js";
import { PromptInput } from "./components/PromptInput.js";
import type { Block } from "./transcript.js";
import { MAX_FPS } from "./frameRate.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  // Load-bearing. Without it Ink decides it is not driving a terminal and takes its
  // non-interactive path, where it renders once and never again — so every keystroke
  // produces no frame and the probe waits forever. Same trap that once shipped a
  // blank screen; see [[project-mindweave-framebuffer]].
  isTTY = true;
  bytes = 0;
  writes = 0;
  write(data: string): boolean {
    this.bytes += data.length;
    this.writes++;
    return true;
  }
}

/**
 * Ink 7 does not listen for `data`. It attaches a `readable` listener and pulls with
 * `read()`, which is why the first version of this probe measured a perfect 0.00ms —
 * the keys were emitted into a void. See [[project-mindweave-ink7-upgrade]].
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  /** Deliver one key the way the terminal would, synchronously. */
  type(key: string): void {
    this.queue.push(key);
    this.emit("readable");
  }
}

const SAMPLE = `Here's what I found in the codebase.

**The cause** — the reducer dispatches once per key, which is correct, but the
transcript below it re-renders in full each time.

- \`src/cli/App.tsx\` holds the block list
- \`src/cli/components/BlockView.tsx\` renders each one

| File | Lines | Role |
|------|-------|------|
| App.tsx | 2400 | frame + state |
| BlockView.tsx | 220 | one block |

\`\`\`ts
export function reduce(s: State, a: Action): State {
  return { ...s, value: a.text };
}
\`\`\`
`;

function blocks(n: number): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: i, kind: "assistant", done: true, text: SAMPLE });
  }
  return out;
}

/**
 * Mount the real frame shape — transcript above, real PromptInput pinned below — and
 * return the median cost of a keystroke.
 *
 * MEDIAN, not mean: the first few frames pay for Yoga's warm-up and the JIT, and a
 * mean over a short run is dominated by them. The user does not feel the first
 * keystroke of the session; they feel the hundredth.
 */
async function keystrokeMs(blockCount: number, keys = 40, maxFps?: number): Promise<number> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();

  const list = blocks(blockCount);
  const instance = render(
    <Box flexDirection="column" height={40} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexShrink={0}>
          {list.map((b) => (
            <Box key={b.id} flexShrink={0} flexDirection="column">
              <BlockView block={b} columns={100} />
            </Box>
          ))}
        </Box>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        <PromptInput onSubmit={() => {}} width={100} />
      </Box>
    </Box>,
    { stdout: stdout as never, stdin: stdin as never, patchConsole: false, ...(maxFps ? { maxFps } : {}) },
  );

  const before = stdout.writes;
  const samples: number[] = [];
  for (let i = 0; i < keys; i++) {
    const t0 = performance.now();
    const seen = stdout.writes;
    stdin.type("a");
    // Wait for the frame that key produced. Ink 7 on React 19 renders
    // ASYNCHRONOUSLY — the update is scheduled, not flushed inside the event
    // handler — so the cost of a keystroke cannot be read off the `emit` call.
    // This is the latency the user actually feels: key in, frame out.
    while (stdout.writes === seen) await new Promise((r) => setTimeout(r, 0));
    samples.push(performance.now() - t0);
  }
  const frames = stdout.writes - before;
  instance.unmount();
  // A probe that measures nothing reports 0.00 and looks like a triumph. If the
  // keystrokes never reached the component there were no frames, and the number
  // below is a lie — say so loudly rather than returning it.
  if (frames === 0) throw new Error("no frames rendered: keystrokes never reached the app");
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

test("probe: the frame-rate cap is what sets typing latency", async () => {
  // An EMPTY transcript, so nothing but the timer is being measured. If these two
  // were equal, the throttle would not be the floor and this whole diagnosis would
  // be wrong — which is the point of measuring both rather than only the fast one.
  const slow = await keystrokeMs(0, 40, 30);
  const fast = await keystrokeMs(0, 40, 120);
  console.log(`\nempty transcript: maxFps=30 ${slow.toFixed(2)}ms/key, maxFps=120 ${fast.toFixed(2)}ms/key\n`);

  // Generous bounds: CI machines are slow and shared, and the claim being defended is
  // "the cap dominates", not a stopwatch figure. At 30fps the trailing edge of a 34ms
  // window cannot be beaten; at 120fps an 8ms window cannot be worse than that.
  assert.ok(slow > 25, `expected the 30fps cap to floor latency near 34ms, got ${slow.toFixed(2)}ms`);
  assert.ok(fast < slow, `raising maxFps must lower latency: ${fast.toFixed(2)}ms vs ${slow.toFixed(2)}ms`);
});

test("the shipped frame cap is high enough to keep typing responsive", async () => {
  // Guards the value the app actually runs with, not one this test chose. Ink's
  // default of 30 puts a ~34ms floor under every keystroke; anything at or below it
  // means the fix has been undone.
  assert.ok(MAX_FPS >= 60, `MAX_FPS is ${MAX_FPS}: at or near Ink's default of 30, typing latency returns`);
});

test("typing does not get slower as the conversation grows", async () => {
  // The guard that virtualization exists for, asked the way the user experiences it.
  // Run at the app's real frame cap so a regression here means a regression there.
  const short = await keystrokeMs(10, 30, MAX_FPS);
  const long = await keystrokeMs(100, 30, MAX_FPS);
  console.log(`\nmaxFps=120: 10 blocks ${short.toFixed(2)}ms/key, 100 blocks ${long.toFixed(2)}ms/key\n`);
  // NOTE: this probe renders every block in full — it does not use App's virtual
  // window — so this is the WORST case, the shape the real app avoids. It is bounded
  // rather than asserted equal for exactly that reason.
  assert.ok(long < short * 8, `keystroke cost is scaling with transcript size: ${short.toFixed(2)}ms -> ${long.toFixed(2)}ms`);
});
