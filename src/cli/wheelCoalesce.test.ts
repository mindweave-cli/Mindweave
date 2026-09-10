/**
 * wheelCoalesce.test.ts — one flick of the wheel is one scroll, not one per notch.
 *
 * A single turn of the wheel arrives as several reports in one chunk (see mouse.ts's
 * readWheel, which deliberately returns them all rather than collapsing them — each is a
 * notch the user turned). Ink runs React in LegacyRoot mode, so a state update from an
 * input handler is NOT batched: each one flushes its own synchronous render and its own
 * full terminal redraw.
 *
 * Scrolling per notch therefore paid three renders for one flick, and the view lagged the
 * hand. The distance must stay the same — the fix is about how many times the screen is
 * rebuilt to travel it, not about travelling less far.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readMouse, readWheel } from "./mouse.js";

/** The App's handler, reduced to the arithmetic under test. */
function scrollCalls(chunk: string, wheelLines: number): number[] {
  const notches = readWheel(chunk);
  if (notches.length === 0) return [];
  const lines = notches.reduce((n, dir) => n + (dir === "up" ? wheelLines : -wheelLines), 0);
  return lines === 0 ? [] : [lines];
}

/** What it used to do: one call per notch. */
function scrollCallsPerNotch(chunk: string, wheelLines: number): number[] {
  return readWheel(chunk).map((dir) => (dir === "up" ? wheelLines : -wheelLines));
}

// Three notches of wheel-up in one chunk, as a terminal delivers a flick.
const FLICK_UP = "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M";
const FLICK_DOWN = "\x1b[<65;10;5M\x1b[<65;10;5M\x1b[<65;10;5M";

test("a three-notch flick scrolls ONCE", () => {
  const calls = scrollCalls(FLICK_UP, 3);
  assert.equal(calls.length, 1, "the screen would be rebuilt once per notch");
  assert.equal(scrollCallsPerNotch(FLICK_UP, 3).length, 3, "sanity: the old shape really was three");
});

test("it travels exactly as far as before", () => {
  // The point is fewer renders, not less movement.
  for (const chunk of [FLICK_UP, FLICK_DOWN]) {
    const before = scrollCallsPerNotch(chunk, 3).reduce((a, b) => a + b, 0);
    const after = scrollCalls(chunk, 3).reduce((a, b) => a + b, 0);
    assert.equal(after, before, "the flick moved a different distance");
  }
});

test("direction survives, and a mixed chunk nets out", () => {
  assert.ok(scrollCalls(FLICK_UP, 3)[0]! > 0, "up must scroll up");
  assert.ok(scrollCalls(FLICK_DOWN, 3)[0]! < 0, "down must scroll down");
  // Two up, one down in one chunk: net one notch up, still a single render.
  const mixed = "\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M";
  assert.deepEqual(scrollCalls(mixed, 3), [3]);
});

test("a chunk that nets to zero does not touch the screen at all", () => {
  // Equal notches both ways: the view has not moved, so nothing should be rebuilt.
  const nowhere = "\x1b[<64;1;1M\x1b[<65;1;1M";
  assert.deepEqual(scrollCalls(nowhere, 3), []);
  assert.equal(scrollCallsPerNotch(nowhere, 3).length, 2, "the old shape rendered twice to go nowhere");
});

test("a chunk with no wheel in it scrolls nothing", () => {
  assert.deepEqual(scrollCalls("\x1b[<0;5;5M", 3), [], "a click is not a scroll");
  assert.deepEqual(scrollCalls("hello", 3), []);
});

// ── the same rule for a DRAG, which is the other thing that arrives in bursts ──
//
// A terminal reports pointer motion continuously while a button is held, so one sweep of
// the hand is a chunk of several reports. Each one used to re-tint the whole screen and
// write it out. Only the last focus in a chunk is ever on screen, so every re-tint before
// it was painted for nobody — which is what made selecting text to copy lag.

/** App's pointer handler, reduced to what it paints. Returns one entry per repaint. */
function repaints(chunk: string): Array<{ kind: string; focus?: { x: number; y: number } }> {
  const events = readMouse(chunk);
  const out: Array<{ kind: string; focus?: { x: number; y: number } }> = [];
  let selection: { anchor: { x: number; y: number }; focus: { x: number; y: number } } | null = null;
  let pendingDrag = false;
  for (const e of events) {
    if (e.kind === "press") {
      pendingDrag = false;
      selection = { anchor: { x: e.x, y: e.y }, focus: { x: e.x, y: e.y } };
      out.push({ kind: "press", focus: selection.focus });
    } else if (e.kind === "drag") {
      if (!selection) continue;
      selection = { anchor: selection.anchor, focus: { x: e.x, y: e.y } };
      pendingDrag = true;
    } else {
      pendingDrag = false;
      if (!selection) continue;
      out.push({ kind: "release", focus: selection.focus });
    }
  }
  if (pendingDrag && selection) out.push({ kind: "drag", focus: selection.focus });
  return out;
}

/** An SGR mouse report: button, column, row, and press/release. */
const report = (button: number, x: number, y: number, down: boolean) =>
  `${String.fromCharCode(27)}[<${button};${x + 1};${y + 1}${down ? "M" : "m"}`;
const press = (x: number, y: number) => report(0, x, y, true);
const motion = (x: number, y: number) => report(32, x, y, true);
const release = (x: number, y: number) => report(0, x, y, false);

test("a sweep of the hand re-tints ONCE, at the position it ended on", () => {
  const chunk = press(2, 2) + motion(5, 2) + motion(9, 2) + motion(14, 2) + motion(20, 2);
  const painted = repaints(chunk);
  const drags = painted.filter((p) => p.kind === "drag");
  assert.equal(drags.length, 1, `one sweep repainted ${drags.length} times`);
  assert.deepEqual(drags[0]!.focus, { x: 20, y: 2 }, "the repaint used a position the hand had already left");
});

test("the selection still ends exactly where the pointer did", () => {
  // Coalescing must change how many times the screen is rebuilt, never where the
  // selection lands. Dropping the intermediate PAINTS is free; dropping the intermediate
  // POSITIONS would be a different selection.
  const painted = repaints(press(0, 0) + motion(3, 1) + motion(7, 4) + release(7, 4));
  const last = painted[painted.length - 1]!;
  assert.equal(last.kind, "release");
  assert.deepEqual(last.focus, { x: 7, y: 4 });
});

test("a release in the same chunk paints instead of the drag, not as well as it", () => {
  // Otherwise the whole screen is re-tinted twice for one gesture, and the second one
  // lands after the selection has already been copied.
  const painted = repaints(press(0, 0) + motion(4, 0) + release(4, 0));
  assert.deepEqual(painted.map((p) => p.kind), ["press", "release"]);
});

test("a press still paints immediately — that is what installs the highlight", () => {
  const painted = repaints(press(3, 3));
  assert.deepEqual(painted.map((p) => p.kind), ["press"]);
});

test("motion with no button held paints nothing", () => {
  // Without a selection there is nothing to tint, and a terminal reporting hover would
  // otherwise repaint the screen for every pixel the pointer crossed.
  assert.deepEqual(repaints(motion(5, 5) + motion(6, 5)), []);
});
