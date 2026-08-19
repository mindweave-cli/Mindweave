/**
 * frameRate.ts — how often the UI is allowed to draw.
 *
 * One constant, in its own file, because it is the setting that decided the typing
 * lag and it needs to be assertable from a test. Left inline at the `render()` call
 * it could be lowered back to Ink's default in a refactor with nothing failing.
 */

/**
 * Frames per second Ink may render at.
 *
 * Ink throttles rendering and defaults to 30fps, i.e. it defers a render to the
 * trailing edge of a ~34ms window. Typing continuously means every keystroke lands
 * inside the previous one's window, so every character waits out that timer before it
 * appears. Measured key-in to frame-out with the real component tree and an EMPTY
 * transcript (`typingPerf.probe.test.tsx`):
 *
 *   maxFps=30 -> ~38ms/key    maxFps=60 -> ~23ms/key    maxFps=120 -> ~12ms/key
 *
 * The floor is there with nothing on screen, which is why two earlier fixes aimed at
 * per-frame COST — virtualizing the transcript, and cutting bytes 13x with the
 * framebuffer — both measured well and changed nothing about how typing felt. Neither
 * can move a clock.
 *
 * 120 is affordable only because of the framebuffer: raising the frame rate on stock
 * Ink would mean ~4x the full-screen repaints, whereas against a per-cell diff a
 * keystroke writes just the cells that changed. If the framebuffer ever goes, this
 * must come down with it.
 */
export const MAX_FPS = 120;
