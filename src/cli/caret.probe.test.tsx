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
  /** Keystrokes waiting to be pulled. Ink 7 takes input by calling `read()` on a
   *  `readable` event, not by listening for `data` — an emitter that only emits `data`
   *  has no listeners at all and every key is silently dropped. */
  private readonly queue: string[] = [];
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  type(s: string): void {
    this.queue.push(s);
    this.emit("readable");
  }
}

const BAR = "│";

/**
 * Watch the prompt row for long enough to see the caret cycle, and return every
 * DISTINCT value it took, in order.
 *
 * The earlier version sampled at fixed instants (120ms, 700ms, 1250ms) and asserted on
 * whatever frame existed at each one. That encodes the speed of the machine running it:
 * a stall longer than the gap to the next beat reads the wrong phase and the test fails
 * on a difference it does not own. Watching a whole cycle asserts the same properties
 * without depending on when anything happens.
 */
const BLINK_MS = 530;

async function caretCycle(): Promise<string[]> {
  const stdout = new FakeStdout();
  const instance = render(<PromptInput onSubmit={() => {}} width={50} placeholder="type here" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  const rowOf = (frame: string): string =>
    frame
      .replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"), "")
      .split(/\r?\n/)
      .find((r) => r.includes("type here")) ?? "";

  // Two and a half blink periods: long enough that a full off-and-back-on cycle has
  // happened even if the first frame lands late.
  const deadline = Date.now() + BLINK_MS * 2.5;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    for (const frame of stdout.frames.splice(0)) {
      const row = rowOf(frame);
      if (row && row !== seen[seen.length - 1]) seen.push(row);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();
  return seen;
}

test("the caret is a bar sitting at the input position, not a filled block", async () => {
  // The box border is drawn with the same character, so "a bar appears somewhere" is
  // true of every frame and proves nothing. What identifies the caret is a bar between
  // the prompt marker and the text, present in some frames and absent in others.
  const rows = await caretCycle();
  const withCaret = new RegExp("> " + BAR + "type here");
  // Blanked to a space rather than removed, which is why this is TWO spaces.
  const without = new RegExp("> {2}type here");
  assert.ok(
    rows.some((r) => withCaret.test(r)),
    `no caret between the marker and the text: ${JSON.stringify(rows.slice(0, 3))}`,
  );
  // A filled block was drawn by inverting a cell, which leaves no character of its own,
  // so the off-beat and the on-beat would be identical once escapes are stripped.
  assert.ok(
    rows.some((r) => without.test(r)),
    `the caret never left the row, so it is not a character of its own: ${JSON.stringify(rows.slice(0, 3))}`,
  );
});

test("it goes off and comes back", async () => {
  // A transition on its own could be a first-render artefact. Returning to a value it
  // already had is what proves a cycle rather than a one-way change.
  const rows = await caretCycle();
  const distinct = [...new Set(rows)];
  assert.ok(distinct.length >= 2, `the caret never changed — it is not blinking: ${JSON.stringify(distinct)}`);
  assert.ok(
    rows.length > distinct.length,
    `the caret changed but never returned to an earlier state: ${JSON.stringify(rows)}`,
  );
});

test("a full row still shows the character just typed", async () => {
  // The caret has no character to sit on at the end of a row, so it ADDS a column there.
  // Wrapped to the full width of the box, a row that filled the box rendered one column
  // too wide, `truncate-end` cut it, and the `…` landed on the letter being typed — the
  // box hid your own input, and only once a line was full, which is why it read as the
  // box randomly eating text.
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = render(<PromptInput onSubmit={() => {}} width={50} placeholder="type here" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
  });

  // EXACTLY one full row, so the cursor ends up past the last column of it. That is the
  // only shape where this goes wrong: one character fewer and the caret has room, one
  // more and it has moved to a short second row where there is room again. Typing "some
  // long text" and eyeballing it would miss this every time.
  //
  // 44 = the box width (50) less its chrome: two border columns, two of padding, and the
  // two-column `> ` marker. Each keystroke goes in on its own, because a chunk arrives as
  // a paste and collapses to a chip instead of being typed.
  const typed = "abcdefghij".repeat(4) + "abcd";
  for (const ch of typed) {
    stdin.type(ch);
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 60));

  const strip = (s: string) =>
    s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"), "");
  // Frames accumulate, and plenty of them are bare control sequences. The one that says
  // what the box looks like now is the LAST frame that actually drew the box.
  const drawn = stdout.frames.map(strip).filter((f) => f.includes("│") && f.includes(typed.slice(0, 10)));
  // Everything BETWEEN the box's own borders. Picking rows by what they contain would
  // silently drop the one that matters here: the row holding the overflowed character is
  // a single letter wide, so any "looks like text" filter excludes exactly the evidence.
  const all = (drawn[drawn.length - 1] ?? "").split(/\r?\n/);
  const top = all.findIndex((r) => r.includes("┌"));
  const bottom = all.findIndex((r, i) => i > top && r.includes("└"));
  const rows = top >= 0 && bottom > top ? all.slice(top + 1, bottom) : [];
  instance.unmount();

  assert.ok(rows.length > 0, "the typed text never appeared at all");
  assert.ok(
    !rows.some((r) => r.includes("…")),
    `the input box truncated what was typed: ${JSON.stringify(rows)}`,
  );
  // Every letter typed is still on screen, across however many rows it wrapped onto.
  const shown = rows.map((r) => (r.match(/[a-j]+/g) ?? []).join("")).join("");
  assert.equal(shown, typed, "the box is not showing everything that was typed");
});

test("turning off does not move the text", async () => {
  // The caret occupies a cell, so an off-beat that removed the cell instead of blanking
  // it would shift the whole line left twice a second. That is worse than no blink.
  const rows = await caretCycle();
  const widths = new Set(rows.map((r) => r.length));
  const positions = new Set(rows.map((r) => r.indexOf("type here")));
  assert.equal(widths.size, 1, `the row changed width between beats: ${[...widths].join(", ")}`);
  assert.equal(positions.size, 1, `the text moved when the caret blinked: ${[...positions].join(", ")}`);
});