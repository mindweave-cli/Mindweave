/**
 * terminalRestore.test.ts — the sequences, and the two callers agreeing on them.
 *
 * The defect these guard is not "the escape codes are wrong" — those were always right
 * on the path that ran. It is that the path frequently does not run, and that the repair
 * available afterwards has to send exactly what the exit path would have sent. Two
 * copies of a string that must match is how that stops being true, so the drift check
 * below matters more than any single assertion about a byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUSE_OFF, ALT_SCREEN_OFF, SHOW_CURSOR, TERMINAL_RESTORE } from "./terminalRestore.js";
import { enterAltScreen, exitAltScreen } from "./altScreen.js";

test("the restore turns off reporting first, then the buffer, then the cursor", () => {
  // Order is the point: the mode actively writing bytes into the terminal is silenced
  // before anything else, so nothing it emits lands in the middle of the rest.
  assert.equal(TERMINAL_RESTORE, MOUSE_OFF + ALT_SCREEN_OFF + SHOW_CURSOR);
  assert.equal(MOUSE_OFF, "\x1b[?1006l\x1b[?1000l");
  assert.equal(ALT_SCREEN_OFF, "\x1b[?1049l");
  assert.equal(SHOW_CURSOR, "\x1b[?25h");
});

test("every sequence is a mode RESET, so sending it to a healthy terminal is a no-op", () => {
  // A private-mode reset ends in `l`; `h` would switch something ON. Getting one of
  // these backwards would mean --reset-terminal broke the terminal it was repairing.
  for (const seq of TERMINAL_RESTORE.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
    if (seq[1] === "25") continue; // showing the cursor is the one thing turned ON
    assert.equal(seq[2], "l", `mode ${seq[1]} must be reset, not set`);
  }
});

/** Run `fn` with a stubbed TTY stdout, collecting everything written to it. */
function onFakeTty(fn: () => void): string {
  const out = process.stdout;
  const wasTty = out.isTTY;
  const realWrite = out.write.bind(out);
  let captured = "";
  (out as { isTTY: boolean }).isTTY = true;
  out.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof out.write;
  try {
    fn();
  } finally {
    out.write = realWrite;
    (out as { isTTY: boolean }).isTTY = wasTty;
  }
  return captured;
}

const EXIT_EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP", "uncaughtException"] as const;

/**
 * Run `fn`, then take back only the exit listeners it added.
 *
 * Deliberately not `removeAllListeners`: the test runner has its own `uncaughtException`
 * handler in this process, and stripping that would turn a later crash into a silent
 * pass. Only what this call installed comes off.
 */
function keepingListeners<T>(fn: () => T): { value: T; added: Map<string, number> } {
  // `exit` and the signals have separate overloads that share no common event type, so
  // the emitter is addressed through its plain string-keyed shape here.
  const emitter = process as unknown as {
    listeners(event: string): ((...args: unknown[]) => void)[];
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };
  const before = new Map(EXIT_EVENTS.map((e) => [e as string, emitter.listeners(e).slice()]));
  const value = fn();
  const added = new Map<string, number>();
  for (const event of EXIT_EVENTS) {
    const previous = before.get(event)!;
    const fresh = emitter.listeners(event).filter((l) => !previous.includes(l));
    added.set(event, fresh.length);
    for (const l of fresh) emitter.removeListener(event, l);
  }
  return { value, added };
}

test("the app's exit path writes exactly the canonical restore", () => {
  // The drift check. `mindweave --reset-terminal` writes TERMINAL_RESTORE; if the exit
  // path ever writes something else, the repair stops matching the damage.
  const { added } = keepingListeners(() => {
    onFakeTty(() => enterAltScreen());
    return onFakeTty(() => exitAltScreen());
  });

  // A signal or a crash skips React, so the restore has to be reachable from each of
  // these directly. SIGHUP is the terminal window closing, and it was not covered.
  for (const event of EXIT_EVENTS) {
    assert.equal(added.get(event), 1, `${event} must restore the terminal`);
  }
});

test("the exit path and --reset-terminal send the same bytes", () => {
  const { value: written } = keepingListeners(() => {
    onFakeTty(() => enterAltScreen());
    return onFakeTty(() => exitAltScreen());
  });
  assert.equal(written, TERMINAL_RESTORE);
});

test("restoring twice writes nothing the second time", () => {
  // Several exit paths can fire at once — a SIGINT handler and the `exit` hook both run
  // on Ctrl+C — and a doubled sequence would be visible as stray bytes in the shell.
  keepingListeners(() => {
    onFakeTty(() => enterAltScreen());
    onFakeTty(() => exitAltScreen());
    assert.equal(onFakeTty(() => exitAltScreen()), "");
  });
});
