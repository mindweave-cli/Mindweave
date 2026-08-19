/**
 * blockPerf.probe.test.tsx — typing and scrolling must not get slower as the
 * conversation grows.
 *
 * Ink re-renders the entire component tree on every React state change and then erases
 * and rewrites the drawn lines. A keystroke IS a state change (the prompt's reducer),
 * and so is a wheel tick (`scrollUp`). So "how expensive is one keystroke" is really
 * "how expensive is it to re-render the whole transcript", and it can only be asked by
 * driving real frames through a real Ink root. See [[feedback-verify-ui-with-probes]].
 *
 * The defect this pins, measured before `BlockView` was memoized: 150 blocks cost
 * ~89ms of markdown-and-wrap work on EVERY keystroke, against Ink's 32ms frame
 * throttle, because nothing told React the untouched blocks had not changed.
 *
 * TWO MEASUREMENT TRAPS, both hit while writing this, both worth stating so the next
 * person does not re-learn them:
 *
 *  1. Calling `setState` in a loop measures NOTHING. React batches the updates into a
 *     single render, so the loop times how long it takes to schedule, not to render.
 *     The first draft of this file did exactly that and passed with the memo REMOVED.
 *  2. Wall-clock around a render is dominated by Ink's own ~32ms write throttle, which
 *     would mask the very difference being measured.
 *
 * So the instrument is React's `<Profiler>`, whose `actualDuration` is the time spent
 * rendering the subtree and nothing else, and the ticks are sequential — each render's
 * effect schedules the next.
 *
 * The bound is a REGRESSION guard, not a benchmark: CI machines are slow and shared, so
 * it asserts on SCALING (cost must not track block count) rather than on a stopwatch
 * figure. What it catches is the class of change that makes this O(blocks) again — a
 * fresh object or closure passed to `BlockView`, a block type that rebuilds its own
 * props, `memo` dropped in a refactor. Any of those and the ratio explodes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Profiler, useEffect, useState } from "react";
import { Box, render } from "ink";
import { BlockView } from "./components/BlockView.js";
import type { Block } from "./transcript.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  write(): boolean {
    return true;
  }
}

/** A realistic assistant reply: prose, emphasis, a list, a table and code — the
 *  shapes that make `renderMarkdown` do actual work. */
const SAMPLE = `Here's what I found in the codebase.

**The cause** — the reducer dispatches once per key, which is correct, but the
transcript below it re-renders in full each time.

- \`src/cli/App.tsx\` holds the block list
- \`src/cli/components/BlockView.tsx\` renders each one

| File | Lines | Role |
| --- | --- | --- |
| App.tsx | 2350 | frame + scroll |

\`\`\`ts
function example(a: number) {
  return a * 2;
}
\`\`\`

That's the whole path.`;

/** `n` stable blocks, built ONCE outside the component — stable identity is exactly
 *  the property the memo depends on, so rebuilding them per render would make this
 *  probe measure a bug it exists to prove absent. */
function blocksOf(n: number): Block[] {
  return Array.from({ length: n }, (_, i) => ({ kind: "assistant", id: i, text: SAMPLE }) as Block);
}

/**
 * Re-render `blocks` `frames` times and return the median milliseconds React spent
 * rendering the transcript per frame.
 *
 * Median, not mean: the first few frames carry JIT warm-up that has nothing to do with
 * the steady state a user types in.
 */
async function msPerReRender(blocks: Block[], frames: number): Promise<number> {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;

  const samples: number[] = [];
  let done: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));

  function Harness() {
    const [tick, setTick] = useState(0);
    useEffect(() => {
      // Sequential, NOT a loop: each render's effect schedules exactly one more, so
      // every tick is its own render pass rather than being batched away.
      if (tick < frames) setTick(tick + 1);
      else done();
    }, [tick]);

    return (
      <Profiler id="transcript" onRender={(_id, _phase, actualDuration) => samples.push(actualDuration)}>
        {/* `marginTop` changes every frame, exactly as scrolling does: the container
            genuinely re-renders, and only the memo stops that reaching the children. */}
        <Box flexDirection="column" marginTop={tick % 2}>
          {blocks.map((b) => (
            <Box key={b.id} flexShrink={0} flexDirection="column">
              <BlockView block={b} columns={100} tightTop={false} />
            </Box>
          ))}
        </Box>
      </Profiler>
    );
  }

  const instance = render(<Harness />, { stdout: stdout as never, stdin, patchConsole: false, debug: true });
  await finished;
  instance.unmount();

  // Drop the mount render and the warm-up that follows it.
  const steady = samples.slice(Math.min(3, samples.length - 1)).sort((a, b) => a - b);
  return steady[Math.floor(steady.length / 2)] ?? 0;
}

test("a re-render does not re-do the transcript's text work", async () => {
  // 150 is the real `SCROLLBACK_BLOCKS` cap from App.tsx — the worst case a user can
  // actually reach, and the one the old bug made unusable.
  const large = await msPerReRender(blocksOf(150), 14);

  // An ABSOLUTE ceiling, deliberately, rather than a ratio against a smaller run.
  // A ratio was tried first and is the wrong instrument here: once the fix lands both
  // figures are around a millisecond, where scheduler noise moves the quotient between
  // roughly 3x and 6x run to run, so the test would flake while measuring nothing.
  //
  // The absolute number separates cleanly and needs no interpretation:
  //
  //     memo removed:  87.9 ms/render     ← measured, by removing it
  //     memo in place:  1.2 ms/render     ← measured, this code
  //
  // The ceiling was 15ms and flaked at 15.29ms — but ONLY inside the full 1,600-test
  // run, never alone or at concurrency 4. That is scheduler contention on a loaded
  // machine, not a regression: the same code measures ~1.2ms with the suite quiet.
  //
  // Raised to 40ms rather than deleted, because the signal survives the move intact.
  // 40 is still ~2x the fixed figure's worst observed case and less than half the
  // broken one, so losing the memoization (88ms) fails just as unambiguously while a
  // busy CI box no longer reports a defect that isn't there. A test that cries wolf
  // under load gets ignored under load, which is exactly when it matters.
  assert.ok(
    large < 40,
    `re-rendering 150 blocks cost ${large.toFixed(2)} ms — memoization is not holding ` +
      `(expected ~1ms; the unmemoized path measured ~88ms).`,
  );
});
