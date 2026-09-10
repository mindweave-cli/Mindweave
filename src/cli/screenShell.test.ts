/**
 * screenShell.test.ts — the ORDER the three pieces move in.
 *
 * Each piece on its own is one line. The order is the part that breaks, and it breaks
 * silently: a terminal left half in one shell and half in the other still renders, it
 * just renders wrongly, and the user reads it as the app being broken rather than the
 * switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyScreenMode, resetScreenShell } from "./screenShell.js";

/** Records every move, in order, as a readable trace. */
function recorder() {
  const trace: string[] = [];
  let mouseOn = 0;
  let mouseOffCalls = 0;
  return {
    trace,
    mouseOn: () => mouseOn,
    mouseOffCalls: () => mouseOffCalls,
    deps: {
      setAltScreen: (on: boolean) => void trace.push(`alt:${on ? "on" : "off"}`),
      setFramebufferEnabled: (on: boolean) => void trace.push(`fb:${on ? "on" : "off"}`),
      enableMouse: () => {
        mouseOn++;
        trace.push("mouse:on");
        return () => {
          mouseOffCalls++;
          trace.push("mouse:off");
        };
      },
    },
  };
}

test("going inline stands the framebuffer down BEFORE leaving the alt screen", () => {
  // It sits between Ink and the terminal. Still diffing, it would reinterpret the leave
  // sequence itself as part of a frame.
  resetScreenShell();
  const r = recorder();
  applyScreenMode("fullscreen", r.deps);
  r.trace.length = 0;
  applyScreenMode("inline", r.deps);
  assert.deepEqual(r.trace, ["fb:off", "mouse:off", "alt:off"]);
});

test("coming back brings the framebuffer up LAST", () => {
  // The mirror: the screen has to BE the alternate buffer before anything diffs against
  // a model of it.
  resetScreenShell();
  const r = recorder();
  applyScreenMode("fullscreen", r.deps);
  assert.deepEqual(r.trace, ["alt:on", "mouse:on", "fb:on"]);
});

test("mouse reporting is off for the whole time the inline shell is up", () => {
  // Nothing reads mouse reports there, so they reach the input as text — the stray
  // characters a click used to leave in the prompt.
  resetScreenShell();
  const r = recorder();
  applyScreenMode("fullscreen", r.deps);
  applyScreenMode("inline", r.deps);
  assert.equal(r.mouseOffCalls(), 1, "the pointer is still reporting into the inline shell");
});

test("switching back and forth does not stack mouse subscriptions", () => {
  // Each `enableMouse` writes the enable sequence and hands back one disposer. Calling it
  // again without disposing leaves a subscription nothing will ever turn off.
  resetScreenShell();
  const r = recorder();
  for (let i = 0; i < 3; i++) {
    applyScreenMode("fullscreen", r.deps);
    applyScreenMode("inline", r.deps);
  }
  assert.equal(r.mouseOn(), 3);
  assert.equal(r.mouseOffCalls(), 3, "a switch left the pointer reporting");
});

test("asking for the mode it is already in re-asserts rather than toggling", () => {
  // The startup path calls this with the mode the app is already starting in, and a
  // command can be typed twice. Neither may end up in the other shell.
  resetScreenShell();
  const r = recorder();
  applyScreenMode("inline", r.deps);
  r.trace.length = 0;
  applyScreenMode("inline", r.deps);
  assert.deepEqual(r.trace, ["fb:off", "alt:off"], "a repeat call moved something it should not have");
});
