/**
 * caret.probe.test.tsx — the input has a pulse.
 *
 * The caret used to be an inverted cell: a solid block parked in the box, identical
 * whether the tool was waiting for you, thinking, or idle. It is the cheapest caret to
 * draw and it reads as a frozen artefact. A thin bar that blinks is the one piece of
 * motion that says an input is live, and it is most of what makes a terminal prompt feel
 * like talking to something rather than typing into a field.
 *
 * Asserted by watching real frames across real time, because "it blinks" is a claim
 * about two frames being different — no amount of inspecting one render can show it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed.
process.env.FORCE_COLOR = "3";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

class FakeStdout extends EventEmitter {
  columns = 50;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** A stdin Ink accepts for raw mode. Without this it replaces the UI with an error
 *  frame, and a probe reading "the last frame" would measure that instead. */
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  setEncoding() {
    return this;
  }
  read() {
    return null;
  }
}

const BAR = "│";

/** Sample the prompt row at each of `atMs`, with escapes stripped. */
async function beats(atMs: number[]): Promise<string[]> {
  const stdout = new FakeStdout();
  const instance = render(<PromptInput onSubmit={() => {}} width={50} placeholder="type here" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    debug: true,
  });
  const seen: string[] = [];
  let last = 0;
  for (const at of atMs) {
    await new Promise((r) => setTimeout(r, at - last));
    last = at;
    const frame = stdout.frames.at(-1) ?? "";
    const row =
      frame
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .split(/\r?\n/)
        .find((r) => r.includes("type here")) ?? "";
    seen.push(row);
  }
  instance.unmount();
  return seen;
}

test("the caret is a bar, not a filled block", async () => {
  const [first] = await beats([120]);
  assert.ok(first?.includes(BAR), `no bar caret in ${JSON.stringify(first)}`);
  // The block was drawn by inverting a cell, which leaves no character of its own —
  // this is the shape check, and the blink test below is the behaviour one.
  assert.match(first!, new RegExp(`>\\s*${BAR}type here`), "the caret is not sitting at the input position");
});

test("it goes off and comes back", async () => {
  // 120ms is inside the first on-beat, 700ms inside the first off-beat, 1250ms back on.
  // Three samples rather than two: one transition could be a first-render artefact,
  // where returning proves it is a cycle.
  const [on, off, again] = await beats([120, 700, 1250]);
  const at = (row: string | undefined) => row?.indexOf("type here") ?? -1;
  assert.ok(at(on) > 0, "nothing rendered on the first beat");
  assert.notEqual(on, off, "the caret never turned off — it is not blinking");
  assert.equal(on, again, "the caret turned off and did not come back");
});

test("turning off does not move the text", async () => {
  // The caret occupies a cell, so an off-beat that removed the cell instead of blanking
  // it would shift the whole line left twice a second. That is worse than no blink.
  const [on, off] = await beats([120, 700]);
  assert.equal(on!.length, off!.length, "the row changed width between beats");
  assert.equal(on!.indexOf("type here"), off!.indexOf("type here"), "the text moved when the caret blinked");
});
