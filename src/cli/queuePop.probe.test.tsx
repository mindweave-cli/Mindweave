/**
 * queuePop.probe.test.tsx — pressing ↑ on a queued message, for real.
 *
 * messageQueue.test.ts proves the RULES. It cannot prove that ↑ reaches them, and the
 * bug being fixed here was exactly that gap: the queue logic was fine, ↑ simply went
 * somewhere else (history) and the user could not tell, because history held the same
 * text. So this drives the real PromptInput through a real terminal and reads the
 * screen.
 *
 * Three traps live in this harness, and all three report a confident wrong answer:
 *
 *  1. Ink 7 pulls stdin with read() on `readable`; emitting `data` goes nowhere, so the
 *     keys are swallowed and every assertion about "nothing happened" passes.
 *  2. stdout must claim isTTY, or Ink takes its non-interactive path and renders once.
 *  3. **Never sleep a fixed amount waiting for a frame.** The first version of this file
 *     did (60ms) and passed on this machine for days before failing on CI, where the
 *     same render took 345ms. A fixed sleep encodes the speed of the machine that wrote
 *     it. Everything below waits for the SCREEN to say what it is waiting for, with a
 *     deadline generous enough that only a real hang trips it.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { PromptInput } from "./components/PromptInput.js";
import { popAll } from "./messageQueue.js";

/** The bytes a terminal actually sends. Built from a code point so the source has no invisible characters in it. */
const ESCAPE = String.fromCharCode(27);
const UP = ESCAPE + "[A";
const ESC = ESCAPE;

/** How long to wait for a frame before calling it a hang rather than a slow machine. */
const FRAME_DEADLINE_MS = 10_000;

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  /** Everything painted, with the escape sequences stripped back out. */
  screen(): string {
    return this.frames.join("").replace(new RegExp(ESCAPE + "\\[[0-9;?]*[A-Za-z]", "g"), "");
  }
}

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
  type(key: string): void {
    this.queue.push(key);
    this.emit("readable");
  }
  /** Re-announce anything still unread. */
  pump(): void {
    if (this.queue.length > 0) this.emit("readable");
  }
  pending(): number {
    return this.queue.length;
  }
}

interface Harness {
  stdin: FakeStdin;
  stdout: FakeStdout;
  /** What the queue holds now — the component pops it through the real callback. */
  queue: string[];
  pops: Array<"up" | "escape">;
  /** Every call, including the ones that declined. Delivery, not outcome. */
  calls: Array<"up" | "escape">;
  done: () => void;
}

function mount(opts: { queue: string[]; history?: string[]; declineEscape?: boolean }): Harness {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const h: Harness = { stdin, stdout, queue: [...opts.queue], pops: [], calls: [], done: () => {} };
  const onQueuePop = (input: string, cursor: number, via: "up" | "escape") => {
    h.calls.push(via);
    // Mirrors App's rule: mid-turn Esc belongs to the interrupt, not to the queue.
    if (via === "escape" && opts.declineEscape) return undefined;
    const popped = popAll(h.queue, input, cursor);
    if (!popped) return undefined;
    h.queue = [];
    h.pops.push(via);
    return popped;
  };
  const app = render(
    <PromptInput onSubmit={() => {}} width={80} history={opts.history ?? []} onQueuePop={onQueuePop} />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    },
  );
  h.done = () => app.unmount();
  return h;
}

/**
 * Wait until the screen contains `text`, then hand back the whole screen.
 *
 * Polling rather than sleeping is the entire point: a slow machine takes longer and
 * still passes, and a genuine failure reports what WAS on screen instead of an
 * assertion about an empty string.
 */
async function screenWith(h: Harness, text: string | RegExp, what: string): Promise<string> {
  const matches = (s: string) => (typeof text === "string" ? s.includes(text) : text.test(s));
  const deadline = Date.now() + FRAME_DEADLINE_MS;
  for (;;) {
    const screen = h.stdout.screen();
    if (matches(screen)) return screen;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. The screen was:\n${screen}`);
    }
    // Re-announce anything Ink has not read. A key typed before it subscribed would
    // otherwise sit in the buffer forever, which is what made this harness depend on
    // mount timing.
    h.stdin.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wait until the component has actually SEEN a key that changes nothing on screen.
 *
 * A marker keypress cannot be used here: ESC followed by a character is how a terminal
 * encodes Alt+character, so the marker is swallowed by the escape parser and never
 * renders. Waiting on the component's own callback is exact — it fires whether or not
 * the key went on to do anything.
 */
async function delivered(h: Harness, via: "up" | "escape"): Promise<void> {
  const deadline = Date.now() + FRAME_DEADLINE_MS;
  while (!h.calls.includes(via)) {
    if (Date.now() > deadline) throw new Error(`the ${via} key never reached the input`);
    h.stdin.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("↑ puts the queued messages in the box, and empties the queue", async () => {
  const h = mount({ queue: ["fix the parser", "then run the tests"] });
  h.stdin.type(UP);
  const screen = await screenWith(h, "fix the parser", "the queued message to reach the input box");
  h.done();

  assert.match(screen, /then run the tests/, "only some of the queue came back");
  assert.deepEqual(h.queue, [], "the queue still holds messages that are now also in the box");
  assert.deepEqual(h.pops, ["up"]);
});

test("with a queue, ↑ does NOT walk history instead", async () => {
  // The original bug in one assertion. History held the same text (sending writes
  // there even when queued), so the old behaviour looked identical on screen while
  // leaving the queued copy live — the user's edit went out as a SECOND message.
  const h = mount({ queue: ["the queued one"], history: ["something much older"] });
  h.stdin.type(UP);
  const screen = await screenWith(h, "the queued one", "the queued message to reach the box");
  h.done();

  assert.doesNotMatch(screen, /something much older/, "↑ walked history and left the queue live");
  assert.deepEqual(h.queue, []);
});

test("with nothing queued, ↑ still walks history", async () => {
  const h = mount({ queue: [], history: ["an older message"] });
  h.stdin.type(UP);
  await screenWith(h, "an older message", "history navigation to happen");
  h.done();
  assert.deepEqual(h.pops, [], "a pop was reported with an empty queue");
});

test("Esc takes the queue back when nothing is running", async () => {
  const h = mount({ queue: ["never mind this"] });
  h.stdin.type(ESC);
  await screenWith(h, "never mind this", "Esc to pull the queue back");
  h.done();
  assert.deepEqual(h.pops, ["escape"]);
});

test("mid-turn Esc leaves the queue alone, so it can mean STOP", async () => {
  // One key must not both stop the turn and silently empty the queue. Nothing appears
  // on screen when this works, so a marker keypress proves the Esc was handled.
  const h = mount({ queue: ["still want this"], declineEscape: true });
  h.stdin.type(ESC);
  await delivered(h, "escape");
  h.done();

  assert.deepEqual(h.queue, ["still want this"], "Esc emptied the queue while a turn was running");
  assert.deepEqual(h.pops, []);
});

test("a half-typed line is kept when the queue comes back", async () => {
  const h = mount({ queue: ["queued first"] });
  for (const c of "draft") h.stdin.type(c);
  await screenWith(h, "draft", "the typed draft to render");
  h.stdin.type(UP);
  const screen = await screenWith(h, "queued first", "the queue to come back around the draft");
  h.done();
  assert.match(screen, /draft/, "what the user was typing was thrown away by the pop");
});
