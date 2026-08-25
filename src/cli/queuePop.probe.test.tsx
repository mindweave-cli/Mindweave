/**
 * queuePop.probe.test.tsx — pressing ↑ on a queued message, for real.
 *
 * messageQueue.test.ts proves the RULES. It cannot prove that ↑ reaches them, and the
 * bug being fixed here was exactly that gap: the queue logic was fine, ↑ simply went
 * somewhere else (history) and the user could not tell, because history held the same
 * text. So this drives the real PromptInput through a real terminal and reads the
 * screen.
 *
 * Two traps live in this harness, both of which report a confident PASS while
 * measuring nothing — see typingPerf.probe.test.tsx for the full account:
 *   - Ink 7 pulls stdin with read() on `readable`; emitting `data` goes nowhere.
 *   - stdout must claim isTTY, or Ink renders once and never again.
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
    return this.frames.join("").replace(new RegExp(ESCAPE + "\[[0-9;?]*[A-Za-z]", "g"), "");
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
}

interface Harness {
  stdin: FakeStdin;
  stdout: FakeStdout;
  /** What the queue holds now — the component pops it through the real callback. */
  queue: string[];
  pops: Array<"up" | "escape">;
  done: () => void;
}

function mount(opts: { queue: string[]; history?: string[]; declineEscape?: boolean }): Harness {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const h: Harness = {
    stdin,
    stdout,
    queue: [...opts.queue],
    pops: [],
    done: () => {},
  };
  const onQueuePop = (input: string, cursor: number, via: "up" | "escape") => {
    // Mirrors App's rule: mid-turn Esc belongs to the interrupt, not to the queue.
    if (via === "escape" && opts.declineEscape) return undefined;
    const popped = popAll(h.queue, input, cursor);
    if (!popped) return undefined;
    h.queue = [];
    h.pops.push(via);
    return popped;
  };
  const app = render(
    <PromptInput
      onSubmit={() => {}}
      width={80}
      history={opts.history ?? []}
      onQueuePop={onQueuePop}
    />,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
  );
  h.done = () => app.unmount();
  return h;
}

/** Let Ink's scheduled render flush before reading the screen. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
}

test("↑ puts the queued messages in the box, and empties the queue", async () => {
  const h = mount({ queue: ["fix the parser", "then run the tests"] });
  await settle();
  h.stdin.type(UP);
  await settle();
  const screen = h.stdout.screen();
  h.done();

  assert.match(screen, /fix the parser/, "the queued message never reached the input box");
  assert.match(screen, /then run the tests/, "only some of the queue came back");
  assert.deepEqual(h.queue, [], "the queue still holds messages that are now also in the box");
  assert.deepEqual(h.pops, ["up"]);
});

test("with a queue, ↑ does NOT walk history instead", async () => {
  // The original bug in one assertion. History held the same text (sending writes
  // there even when queued), so the old behaviour looked identical on screen while
  // leaving the queued copy live — the user's edit went out as a SECOND message.
  const h = mount({ queue: ["the queued one"], history: ["something much older"] });
  await settle();
  h.stdin.type(UP);
  await settle();
  const screen = h.stdout.screen();
  h.done();

  assert.match(screen, /the queued one/);
  assert.doesNotMatch(screen, /something much older/, "↑ walked history and left the queue live");
  assert.deepEqual(h.queue, []);
});

test("with nothing queued, ↑ still walks history", async () => {
  const h = mount({ queue: [], history: ["an older message"] });
  await settle();
  h.stdin.type(UP);
  await settle();
  const screen = h.stdout.screen();
  h.done();

  assert.match(screen, /an older message/, "history navigation was swallowed by the queue check");
  assert.deepEqual(h.pops, [], "a pop was reported with an empty queue");
});

test("Esc takes the queue back when nothing is running", async () => {
  const h = mount({ queue: ["never mind this"] });
  await settle();
  h.stdin.type(ESC);
  await settle();
  const screen = h.stdout.screen();
  h.done();

  assert.match(screen, /never mind this/);
  assert.deepEqual(h.pops, ["escape"]);
});

test("mid-turn Esc leaves the queue alone, so it can mean STOP", async () => {
  // One key must not both stop the turn and silently empty the queue.
  const h = mount({ queue: ["still want this"], declineEscape: true });
  await settle();
  h.stdin.type(ESC);
  await settle();
  h.done();

  assert.deepEqual(h.queue, ["still want this"], "Esc emptied the queue while a turn was running");
  assert.deepEqual(h.pops, []);
});

test("a half-typed line is kept when the queue comes back", async () => {
  const h = mount({ queue: ["queued first"] });
  await settle();
  for (const c of "draft") h.stdin.type(c);
  await settle();
  h.stdin.type(UP);
  await settle();
  const screen = h.stdout.screen();
  h.done();

  assert.match(screen, /queued first/);
  assert.match(screen, /draft/, "what the user was typing was thrown away by the pop");
});
