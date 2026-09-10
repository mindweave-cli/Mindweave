/**
 * liveSize.test.ts — reading the terminal's size by live syscall, not a cached getter.
 *
 * `stdout.columns` / `stdout.rows` are getters that on Windows can return a value cached
 * at the last `resize` event — an event that often never fires there. A window dragged
 * taller then leaves them reporting the old height forever, and the full-screen frame
 * sized from them stops short of the real bottom with dead rows below it. `getWindowSize`
 * asks the OS on the spot; these pin that it is preferred and the getters are the
 * fallback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveTerminalSize } from "./App.js";

test("getWindowSize wins over the possibly-stale getters", () => {
  const stream = {
    columns: 80, // the cached, stale getter
    rows: 24,
    getWindowSize: () => [120, 50] as [number, number], // the live OS truth
  };
  assert.deepEqual(liveTerminalSize(stream), { columns: 120, rows: 50 });
});

test("without getWindowSize, the getters are used", () => {
  assert.deepEqual(liveTerminalSize({ columns: 100, rows: 40 }), { columns: 100, rows: 40 });
});

test("with nothing at all, it falls back to sane defaults rather than NaN", () => {
  assert.deepEqual(liveTerminalSize(undefined), { columns: 80, rows: 24 });
  assert.deepEqual(liveTerminalSize({}), { columns: 80, rows: 24 });
});

test("the exact reported shape: a grown window the cached getter missed", () => {
  // The app started in a short window, the getters cached that height, then the window
  // was dragged much taller and Windows fired no resize event.
  const grown = {
    columns: 200,
    rows: 30, // frozen at the old height — this is the dead space
    getWindowSize: () => [200, 55] as [number, number],
  };
  assert.equal(liveTerminalSize(grown).rows, 55, "the live height was ignored, so the frame stays short");
});
