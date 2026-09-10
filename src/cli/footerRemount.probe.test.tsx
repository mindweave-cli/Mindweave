/**
 * footerRemount.probe.test.tsx — entering and leaving the inline reading view must not
 * remount the footer.
 *
 * The reported symptom was a flicker starting to scroll up, and another arriving back
 * at the bottom — both directions of the SAME transition. `scrollFlicker.probe.test.tsx`
 * ruled out the state-update shape (two synchronous `setState` calls coalesce into one
 * commit here regardless): that was real hygiene, not the cause.
 *
 * The actual cause is structural. The inline shell chose between two ENTIRELY separate
 * `<Box>` subtrees with a ternary:
 *
 *     readingInline ? <Box height={frameHeight} overflow="hidden">{chatView}{footerView}</Box>
 *                   : <Box>{tail.map(...)}{footerView}</Box>
 *
 * `footerView` sits at a different CHILD INDEX in each branch — last, after however many
 * tail blocks there are, in one; second, right after `chatView`, in the other. React
 * reconciles children by type AND POSITION, not by searching the tree for a matching
 * element, so moving to a different index is indistinguishable from a different element
 * being there: the footer's whole subtree — the input box, its cursor, its menu state —
 * unmounts and a fresh one mounts in its place. That destroy-then-create is the flicker,
 * on both sides of the transition, and it explains why the same box that stays rock
 * solid in the full-screen shell was never actually pinned here.
 *
 * The fix keeps ONE wrapper `<Box>` and only swaps the content ABOVE the footer, so
 * `footerView` is always the second child of the same element. This file proves the
 * distinction is real by mounting a component in that footer position and watching
 * whether it unmounts across the switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect } from "react";
import { render, Box, Text } from "ink";

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 20;
  isTTY = true as const;
  write(): boolean {
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

/** Stands in for `footerView`'s root: a live component whose mount count is the thing
 *  under test, exactly as PromptInput's own local state would be lost by a remount. */
function makeFooterMarker(log: { mounts: number; unmounts: number }) {
  return function FooterMarker(): React.ReactElement {
    useEffect(() => {
      log.mounts++;
      return () => {
        log.unmounts++;
      };
    }, []);
    return <Text>FOOTER</Text>;
  };
}

/** The OLD shape: a ternary between two fully separate wrapper subtrees. */
function OldShape({ reading, Footer }: { reading: boolean; Footer: () => React.ReactElement }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>history</Text>
      {reading ? (
        <Box flexDirection="column" height={10} overflow="hidden">
          <Text>chat-view-content</Text>
          <Footer />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>tail-line-1</Text>
          <Text>tail-line-2</Text>
          <Footer />
        </Box>
      )}
    </Box>
  );
}

/** The fix: one wrapper, the footer always the second child of it. */
function FixedShape({ reading, Footer }: { reading: boolean; Footer: () => React.ReactElement }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>history</Text>
      <Box flexDirection="column" height={reading ? 10 : undefined} overflow={reading ? "hidden" : "visible"}>
        {reading ? <Text>chat-view-content</Text> : (
          <>
            <Text>tail-line-1</Text>
            <Text>tail-line-2</Text>
          </>
        )}
        <Footer />
      </Box>
    </Box>
  );
}

/**
 * Mounts, drives `transitions` through `rerender`, and returns the counts from BEFORE
 * final teardown alongside the counts after it.
 *
 * The split matters: `instance.unmount()` at the end of every test run is itself an
 * unmount, and folding it into the same number as a mid-transition remount would make
 * "did entering reading mode remount the footer" indistinguishable from "did the test
 * clean up after itself". `duringTransitions` is the answer to the actual question.
 */
async function remountsAcross(
  Shape: typeof OldShape,
  transitions: boolean[],
): Promise<{ duringTransitions: { mounts: number; unmounts: number }; final: { mounts: number; unmounts: number } }> {
  const log = { mounts: 0, unmounts: 0 };
  const Footer = makeFooterMarker(log);
  const stdout = new FakeStdout();
  const instance = render(<Shape reading={transitions[0]!} Footer={Footer} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await settle();
  for (const reading of transitions.slice(1)) {
    instance.rerender(<Shape reading={reading} Footer={Footer} />);
    await settle();
  }
  const duringTransitions = { ...log };
  instance.unmount();
  await settle();
  return { duringTransitions, final: { ...log } };
}

test("the OLD shape really did remount the footer entering reading mode", async () => {
  const { duringTransitions } = await remountsAcross(OldShape, [false, true]);
  assert.equal(duringTransitions.mounts, 2, `expected the transition to remount (2 mounts), got ${duringTransitions.mounts}`);
  assert.equal(duringTransitions.unmounts, 1, `expected the OLD instance to unmount mid-transition, got ${duringTransitions.unmounts}`);
});

test("the OLD shape also remounts the footer on the way BACK to the bottom", async () => {
  const { duringTransitions } = await remountsAcross(OldShape, [true, false]);
  assert.equal(duringTransitions.mounts, 2);
  assert.equal(duringTransitions.unmounts, 1);
});

test("the FIXED shape keeps the footer mounted entering reading mode", async () => {
  const { duringTransitions } = await remountsAcross(FixedShape, [false, true]);
  assert.equal(duringTransitions.mounts, 1, `the footer remounted (${duringTransitions.mounts} mounts) — the input box would flicker`);
  assert.equal(duringTransitions.unmounts, 0, "the footer unmounted mid-transition");
});

test("the FIXED shape keeps the footer mounted leaving reading mode", async () => {
  const { duringTransitions } = await remountsAcross(FixedShape, [true, false]);
  assert.equal(duringTransitions.mounts, 1);
  assert.equal(duringTransitions.unmounts, 0);
});

test("the FIXED shape survives several trips back and forth with one mount", async () => {
  // The realistic case: scroll up, read, scroll back, scroll up again.
  const { duringTransitions } = await remountsAcross(FixedShape, [false, true, false, true, false]);
  assert.equal(duringTransitions.mounts, 1, `the footer remounted across a scroll session: ${duringTransitions.mounts} mounts`);
  assert.equal(duringTransitions.unmounts, 0);
});

test("both shapes tear down cleanly on real unmount — the split above is not hiding a leak", async () => {
  const old = await remountsAcross(OldShape, [false, true]);
  assert.equal(old.final.unmounts, old.final.mounts, "every OLD mount should eventually unmount");
  const fixed = await remountsAcross(FixedShape, [false, true]);
  assert.equal(fixed.final.unmounts, fixed.final.mounts, "every FIXED mount should eventually unmount");
});
