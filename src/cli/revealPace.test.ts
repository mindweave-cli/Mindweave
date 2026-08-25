/**
 * revealPace.test.ts — the tempo, pinned.
 *
 * The value of this module is a property rather than a calculation: the beat is the
 * SAME every time. That is easy to state and easy to lose, because every instinct
 * about latency pushes toward speeding up later reveals, and any such change reads
 * on screen as the tool getting impatient with itself. So the constancy is asserted
 * directly, over a long turn, rather than left implied by a one-line function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVEAL_GAP_MS, narrationPending, revealWait } from "./revealPace.js";

// ── the beat never changes ────────────────────────────────────────────────────

test("every reveal in a long turn waits exactly the same beat", () => {
  // THE property. A decaying gap would pass a test that only checked the first two
  // reveals, so this walks a forty-block turn — deep enough that any decay curve or
  // budget cap would have tripped — and asserts the gap is identical throughout.
  let now = 10_000;
  const waits: number[] = [];
  for (let i = 0; i < 40; i++) {
    const wait = revealWait({ now, lastRevealAt: now, flush: false });
    waits.push(wait);
    now += wait; // the reveal happens, and the next beat starts from there
  }
  assert.deepEqual(
    [...new Set(waits)],
    [REVEAL_GAP_MS],
    `the beat changed across the turn: ${[...new Set(waits)].join(", ")}`,
  );
});

test("the gap is a MINIMUM since the last reveal, not an added sleep", () => {
  // A model that thought for two seconds between calls has already paid most of the
  // beat. Adding the full gap on top would punish exactly the turns that were
  // already reading at the right pace.
  // Kept as arithmetic rather than a fixed number so it stays honest whatever the beat
  // is: time already spent counts toward it, and it never becomes an added sleep.
  assert.equal(revealWait({ now: 5_000, lastRevealAt: 3_000, flush: false }), Math.max(0, REVEAL_GAP_MS - 2_000));
  assert.equal(revealWait({ now: 5_000, lastRevealAt: 4_900, flush: false }), Math.max(0, REVEAL_GAP_MS - 100));
});

test("time already spent past the beat costs nothing, and never goes negative", () => {
  assert.equal(revealWait({ now: 100_000, lastRevealAt: 3_000, flush: false }), 0);
  assert.equal(revealWait({ now: 100_000, lastRevealAt: 0, flush: false }), 0);
});

test("the FIRST block of a turn is immediate", () => {
  // Falls out of the same subtraction, and it is the difference between pacing and
  // stalling: the gap before anything is on screen is DEAD time, which every latency
  // study finds harmful, while the gap between blocks is occupied time, which is the
  // condition the effect depends on. App resets lastRevealAt to 0 per turn.
  assert.equal(revealWait({ now: Date.now(), lastRevealAt: 0, flush: false }), 0);
});

test("Esc drops the beat to nothing", () => {
  // The user asking to see the rest outranks the rhythm, and it is the signposted
  // escape a long operation is required to have.
  assert.equal(revealWait({ now: 1_000, lastRevealAt: 1_000, flush: true }), 0);
});

test("nothing is held back: content appears when it arrives", () => {
  // The beat was three seconds, on a theory about perceived effort. Used in anger it
  // read as an animation — words arriving with motion, the chat still moving after the
  // work was done. Pinned at zero so bringing it back is a deliberate edit here.
  assert.equal(REVEAL_GAP_MS, 0);
  assert.equal(revealWait({ now: 1_000, lastRevealAt: 1_000, flush: false }), 0, "a burst is still held");
});

// ── narration gets its own beat ───────────────────────────────────────────────

test("text waiting to be sealed is worth a beat of its own", () => {
  assert.equal(narrationPending({ openAsstId: 7, raw: "Checking the driver seam.", narrated: false }), true);
});

test("nothing is pending when no assistant block is open", () => {
  assert.equal(narrationPending({ openAsstId: null, raw: "", narrated: false }), false);
  // raw can outlive its block; the open id is what says a block exists to seal.
  assert.equal(narrationPending({ openAsstId: null, raw: "leftover", narrated: false }), false);
});

test("whitespace is not narration", () => {
  assert.equal(narrationPending({ openAsstId: 7, raw: "   \n  ", narrated: false }), false);
});

test("once the turn has narrated, further text buys an EMPTY beat and is not paced", () => {
  // The budget is one narration line per turn, so a second block seals to nothing
  // (sealAssistant's `suppressed`). Pausing for it would be three seconds of held
  // screen with no block arriving at the end — a stall, which is the exact failure
  // mode the occupied-time condition exists to avoid.
  assert.equal(narrationPending({ openAsstId: 9, raw: "And now the other file.", narrated: true }), false);
});
