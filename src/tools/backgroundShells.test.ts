/**
 * backgroundShells.test.ts — the background-shell lifecycle: adopt → buffer →
 * complete → one-shot notify (no repeat), incremental reads, and kill. Plus
 * run_command auto-backgrounding on a short timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  BackgroundShells,
  isInteractiveServerCommand,
  findRunningDuplicate,
  shouldWakeOnEnd,
  guessNotifyPolicy,
} from "./backgroundShells.js";
import type { ShellInfo } from "./backgroundShells.js";
import { runCommand } from "./runCommand.js";
import { shellOutput, listShells, killShell } from "./shellTools.js";
import type { ToolContext } from "./types.js";
import { isProcessStopped } from "./killTree.js";

const NODE = process.execPath;
const IS_WIN = process.platform === "win32";
const DETACH = !IS_WIN;

/**
 * A shell command that runs a node `-e` script, valid in the active shell
 * runCommand uses. PowerShell needs the call operator (`&`) to invoke a quoted
 * executable path; POSIX sh runs the quoted path directly. The script is kept
 * free of quote characters so neither shell mangles it.
 */
function nodeCmd(script: string): string {
  return `${IS_WIN ? "& " : ""}"${NODE}" -e "${script}"`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitUntil(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
}

test("adopt → complete → one-shot notifications (model + UI), no repeat", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('hello'); console.error('world')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node -e print", cwd: process.cwd() });
  assert.equal(info.status, "running");

  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.status, "exited");
  assert.equal(mgr.list()[0]!.exitCode, 0);

  // Model drain: once, with a tail, then never again.
  const drained = await mgr.drainEvents();
  assert.equal(drained.length, 1);
  assert.match(drained[0]!.tail, /hello/);
  assert.equal((await mgr.drainEvents()).length, 0);
  assert.equal(mgr.pendingCount(), 0);

  // UI drain: once, then never again.
  assert.equal(mgr.takeUiEvents().length, 1);
  assert.equal(mgr.takeUiEvents().length, 0);
  mgr.dispose();
});

test("read returns only NEW output each time", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('first')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const a = await mgr.read(info.id);
  assert.match(a!.chunk, /first/);
  const b = await mgr.read(info.id); // nothing new since last read
  assert.equal(b!.chunk, "");
  mgr.dispose();
});

test("kill stops a running shell", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node sleep", cwd: process.cwd() });
  assert.equal(mgr.runningCount(), 1);
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.kill(info.id), false); // already stopped
  mgr.dispose();
});

test("isInteractiveServerCommand: dev servers vs finite tasks", () => {
  for (const c of ["npm run dev", "pnpm start", "yarn serve", "tauri dev", "npm run tauri dev", "vite", "next dev", "nodemon server.js"]) {
    assert.equal(isInteractiveServerCommand(c), true, `${c} should be interactive`);
  }
  for (const c of ["npm run build", "npm test", "tsc", "vite build", "tauri build", "cargo build", "npm run lint", "git status"]) {
    assert.equal(isInteractiveServerCommand(c), false, `${c} should NOT be interactive`);
  }
});

test("a dev server that exits instantly never came up, so it DOES interrupt", async () => {
  // Exit code 0, but in a few milliseconds: a dev script that quits immediately did
  // not start a server, and the user never saw one. The old rule read the zero and
  // stayed silent, which hid a broken script.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('vite ready')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 0);
  assert.equal(mgr.list()[0]!.ready, false, "it never came up");
  assert.equal(mgr.pendingCount(), 1);

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.wake, true);
  // And the stop is visible in the chat either way.
  assert.equal(mgr.takeUiEvents().length, 1);
  mgr.dispose();
});

test("a killed dev server does NOT wake the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "tauri dev", cwd: process.cwd() });
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.pendingCount(), 0);
  mgr.dispose();
});

test("a dev server that CRASHES (non-zero) still wakes the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 1);
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainEvents()).length, 1);
  mgr.dispose();
});

// ── How a shell ENDED decides whether the model hears about it ───────────────
//
// These pin the measured behaviour of a real close. On Windows `taskkill /T` (what
// /shells, killTree and closing a console app all amount to) reports code 1, and
// SIGTERM/SIGINT report code null. The old `code === 0` rule missed all three, so
// closing your app told the model it had crashed and the model reopened it.

const SERVER = { notify: "on_failure", killed: false } as const;

test("closing an app you had running does NOT interrupt, however it ends", () => {
  // It came up, so the user watched it run and then stopped it. Nothing to break in
  // for, whichever way the process actually died.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: null, cameUp: true }), false);
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGTERM", cameUp: true }), false);
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGINT", cameUp: true }), false);
});

test("a signal ends a server quietly even if it never came up", () => {
  // Ctrl+C two seconds after launching is still someone stopping it.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGTERM", cameUp: false }), false);
});

test("a server that never came up DOES interrupt", () => {
  // The user never saw it running, so they cannot know it failed. This is the one
  // case where breaking in is the point.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: null, cameUp: false }), true);
});

test("we killed it ourselves, so there is nothing to interrupt about", () => {
  assert.equal(shouldWakeOnEnd({ notify: "on_failure", killed: true, signal: null, cameUp: false }), false);
  assert.equal(shouldWakeOnEnd({ notify: "on_finish", killed: true, signal: null, cameUp: true }), false);
});

test("a finite task always interrupts, however it ended", () => {
  const task = { notify: "on_finish", killed: false } as const;
  assert.equal(shouldWakeOnEnd({ ...task, signal: null, cameUp: true }), true);
  assert.equal(shouldWakeOnEnd({ ...task, signal: "SIGTERM", cameUp: false }), true);
});

test("the exit code is deliberately not part of the decision", () => {
  // Measured: a closed app and a port conflict BOTH report code 1 on Windows, and a
  // signalled process reports none. Whether it came up is what separates them, so the
  // rule takes no exit code at all. If one reappears in this signature, that lesson
  // is being relearned.
  const keys = Object.keys({ notify: 0, killed: 0, signal: 0, cameUp: 0 });
  assert.ok(!keys.includes("code"), "shouldWakeOnEnd must not consult an exit code");
  assert.ok(!keys.includes("ranForMs"), "duration lives in the readiness timer, not here");
});

test("a dev server stopped from OUTSIDE does not wake the model", async () => {
  // The real scenario end to end: the process is ended by something that is not our
  // kill(), so `killed` is false and only the signal/exit tells us what happened.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run tauri dev", cwd: process.cwd() });
  child.kill(); // the user closes the window
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.pendingCount(), 0, "closing the app must not queue a wake-up");
  // Delivered, but as background fact rather than news. Deleting it was the defect.
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "the model must still learn it stopped");
  assert.equal(events[0]!.wake, false);
  assert.equal(mgr.takeUiEvents().length, 1, "the user should still SEE that it stopped");
  mgr.dispose();
});

test("a finite task (build) exiting cleanly still wakes the model to report", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('built ok')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run build", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainEvents()).length, 1);
  mgr.dispose();
});

test("run_command moves a slow command to the background instead of killing it", async () => {
  const mgr = new BackgroundShells();
  const ctx: ToolContext = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr };
  // Sleeps ~3s, but we only wait 1s inline → it should background, not die.
  const res = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 3000)"), timeout: 1000 },
    ctx,
  );
  assert.ok(!res.isError);
  assert.match(res.output, /moved to the background as shell #\d+/);
  assert.equal(mgr.runningCount(), 1); // still alive

  // And it finishes on its own, then notifies once. The wait is generous on purpose:
  // the command sleeps 3s, but a shared CI runner also has to start a shell and a
  // node process first, and this failed once at 8s while the identical job on a less
  // busy runner passed. What is being tested is that it backgrounds rather than dies,
  // not how fast a loaded machine can spawn a process.
  await waitUntil(() => mgr.running().length === 0, 30_000);
  const drained = await mgr.drainEvents();
  assert.equal(drained.length, 1);
  mgr.dispose();
});

// ── Fix C: don't launch a server that's already running ──

function shell(id: number, command: string): ShellInfo {
  return {
    id,
    command,
    cwd: "/p",
    status: "running",
    exitCode: null,
    startedAt: 0,
    finishedAt: null,
    notify: "on_finish",
    ready: false,
  };
}

test("a shell finalizes even when a surviving grandchild holds the pipe open", { timeout: 30_000 }, async (t) => {
  if (!IS_WIN) {
    t.skip("the orphaned-grandchild pipe hold is the Windows shell-spawn shape");
    return;
  }
  // `close` fires only once every stdio stream closes. Kill the shell wrapper and the
  // grandchild keeps the pipe open, so `close` never arrives and the entry used to sit
  // at "running" for the rest of the session. The `exit` backstop has to finalize it.
  const mgr = new BackgroundShells();
  const wrapper = spawn(`node -e "setInterval(()=>{},1000)"`, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
  mgr.adopt(wrapper, { command: "npm run dev", cwd: process.cwd() });
  await sleep(800);

  const { execSync } = await import("node:child_process");
  const kids = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${wrapper.pid} } | Select-Object -ExpandProperty ProcessId"`,
    { encoding: "utf8" },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

  wrapper.kill(); // only the wrapper — the grandchild survives, still holding stdout
  await waitUntil(() => mgr.list()[0]!.status !== "running", 15_000);
  assert.notEqual(mgr.list()[0]!.status, "running", "the entry must not be stranded as running");

  mgr.dispose();
  for (const pid of kids) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
});

test("an interrupted turn does not leave a background process running", async () => {
  // run_command's background branch returns BEFORE the abort listener is wired, so it
  // has to check the signal itself. Without that, Esc still launches a dev server that
  // outlives the turn — exactly what backgrounding is designed to do.
  const mgr = new BackgroundShells();
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    backgroundShells: mgr,
    abortSignal: controller.signal,
  } as unknown as Parameters<typeof runCommand.execute>[1];

  const result = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.match(result.output, /interrupt/i);
  assert.equal(mgr.list().length, 0, "nothing should have been adopted after an abort");
  mgr.dispose();
});

test("findRunningDuplicate: matches the same server command (ignoring whitespace/case)", () => {
  const running = [shell(2, "npm run tauri dev")];
  assert.equal(findRunningDuplicate(running, "npm  run   tauri dev")?.id, 2);
  assert.equal(findRunningDuplicate(running, "NPM RUN TAURI DEV")?.id, 2);
});

test("findRunningDuplicate: distinct servers do not collide", () => {
  const running = [shell(2, "npm run dev"), shell(3, "cargo run")];
  assert.equal(findRunningDuplicate(running, "npm run build"), undefined);
  assert.equal(findRunningDuplicate(running, "vite preview"), undefined);
  // But an exact repeat of one of them is caught.
  assert.equal(findRunningDuplicate(running, "cargo run")?.id, 3);
});

test("findRunningDuplicate: nothing running means nothing to collide with", () => {
  assert.equal(findRunningDuplicate([], "npm run tauri dev"), undefined);
});

// ── The policy is DECLARED, not guessed ─────────────────────────────────────

test("the decision is keyed on the declared policy", () => {
  const ended = { killed: false, signal: null, cameUp: true };
  // The same ending, three different answers, decided by what the caller asked for.
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "on_finish" }), true);
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "on_failure" }), false);
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "never" }), false);
});

test("never means never, even for a task that failed on startup", () => {
  assert.equal(
    shouldWakeOnEnd({ notify: "never", killed: false, signal: null, cameUp: false }),
    false,
  );
});

test("a declared policy beats the name guess", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('done')"], { detached: DETACH });
  // `npm run dev` would be guessed as a server; the caller says it is a task.
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_finish" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.notify, "on_finish");
  assert.equal(mgr.pendingCount(), 1, "a declared task must report even though it looks like a server");
  mgr.dispose();
});

test("guessNotifyPolicy is only a fallback, and is honest about what it knows", () => {
  assert.equal(guessNotifyPolicy("npm run dev"), "on_failure");
  assert.equal(guessNotifyPolicy("npm run build"), "on_finish");
  // The cases the name list cannot see. These are why the caller should declare.
  assert.equal(guessNotifyPolicy("cargo run"), "on_finish");
  assert.equal(guessNotifyPolicy("docker compose up"), "on_finish");
});

// ── Readiness: the event a server actually has ──────────────────────────────

test("a server that stays up reports READY, once, and not as a failure", { timeout: 30_000 }, async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });

  assert.equal(mgr.pendingCount(), 0, "nothing to say the instant it spawns");
  await waitUntil(() => mgr.list()[0]!.ready, 25_000);

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "ready");
  // One-shot: the property that stops background jobs eating the context window.
  assert.equal((await mgr.drainEvents()).length, 0);
  assert.equal(mgr.pendingCount(), 0);

  mgr.kill(events[0]!.info.id, "user");
  mgr.dispose();
});

test("a server that dies before the grace never reports ready", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "ended", "a failed start is an ending, not a readiness");
  assert.equal(mgr.list()[0]!.ready, false);
  mgr.dispose();
});

// ── Who stopped it ──────────────────────────────────────────────────────────

test("a shell records who stopped it, and tells neither of them", async () => {
  const mgr = new BackgroundShells();
  const a = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const b = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const first = mgr.adopt(a, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  const second = mgr.adopt(b, { command: "npm test", cwd: process.cwd(), notify: "on_finish" });

  mgr.kill(first.id, "user");
  mgr.kill(second.id, "agent");

  const byId = new Map(mgr.list().map((s) => [s.id, s]));
  assert.equal(byId.get(first.id)!.stoppedBy, "user");
  assert.equal(byId.get(second.id)!.stoppedBy, "agent");
  // Whoever pressed the button already knows, so neither wakes the model.
  assert.equal(mgr.pendingCount(), 0);
  mgr.dispose();
});

// ── Told, but not interrupted ────────────────────────────────────────────────
//
// The defect this fixes: a stop that wasn't worth interrupting for was DELETED, so
// the model could never say the app had stopped, and had no answer when asked why it
// was down. It must now always arrive, just without breaking into the session.

test("a stop the user caused is still DELIVERED, it just doesn't interrupt", { timeout: 30_000 }, async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });

  // Let it come up, so this is a real "the user watched it run" stop.
  await waitUntil(() => mgr.list()[0]!.ready, 25_000);
  await mgr.drainEvents(); // clear the readiness event

  child.kill(); // the user closes the window, from outside
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 0, "a stop the user caused must NOT interrupt");

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "but it must still be delivered");
  assert.equal(events[0]!.kind, "ended");
  assert.equal(events[0]!.wake, false, "delivered as background fact, not as news");
  assert.equal(events[0]!.info.id, info.id);

  // Still one-shot: delivered exactly once, never again.
  assert.equal((await mgr.drainEvents()).length, 0);
  mgr.dispose();
});

test("a server that never came up both interrupts AND is delivered", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.error('EADDRINUSE'); process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 1, "the user never saw it, so this must interrupt");
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.wake, true);
  assert.match(events[0]!.tail, /EADDRINUSE/, "the error output rides along");
  mgr.dispose();
});

test("a shell told to say nothing is delivered without interrupting", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "some-daemon", cwd: process.cwd(), notify: "never" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 0, "never means never interrupt");
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "the model still learns it is gone");
  assert.equal(events[0]!.wake, false);
  mgr.dispose();
});

// ── End to end, through the real tools ──────────────────────────────────────
//
// The reported scenario, driven the way the model drives it: run_command starts a
// server, shell_output is consulted while it starts, the user closes it, and
// list_shells is asked what happened. Every assertion here is something that was
// wrong in at least one build.

test("the whole reported scenario, through run_command / shell_output / list_shells", { timeout: 60_000 }, async () => {
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
  } as unknown as ToolContext;

  // 1. The model starts a dev server. It must be told it will hear about READINESS,
  //    and must NOT be promised a report when it finishes.
  const started = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.match(started.output, /WILL be told once it has come up/);
  assert.doesNotMatch(started.output, /notified AUTOMATICALLY the moment it finishes/);
  const id = mgr.running()[0]!.id;

  // 2. It peeks while the thing is still starting. Same rule: no false promise.
  const early = await shellOutput.execute({ id }, ctx);
  assert.match(early.output, /Still starting/);
  assert.match(early.output, /will NOT be told when it later stops/);
  assert.doesNotMatch(early.output, /when it finishes/);

  // 3. It comes up. That is the one positive event, and it interrupts exactly once.
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.ready, 25_000);
  assert.equal(mgr.pendingCount(), 1, "coming up should interrupt so the model can report it");
  const ready = await mgr.drainEvents();
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.kind, "ready");

  const upList = await listShells.execute({}, ctx);
  assert.match(upList.output, /#\d+ up \(/, `list_shells should say it is up, got: ${upList.output}`);

  // 4. The user closes it themselves, from outside.
  mgr.list().find((s) => s.id === id); // sanity
  const proc = (mgr as unknown as { shells: Map<number, { child: { kill(): void } | null }> }).shells.get(id)!;
  proc.child!.kill();
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.status !== "running");

  // 5. THE BUG: this must not interrupt, and must not be swallowed either.
  assert.equal(mgr.pendingCount(), 0, "closing your own app must not interrupt");
  const ended = await mgr.drainEvents();
  assert.equal(ended.length, 1, "but the model must still be told it stopped");
  assert.equal(ended[0]!.kind, "ended");
  assert.equal(ended[0]!.wake, false);

  // 6. And afterwards the model can answer "why is my app down?" from list_shells.
  const afterList = await listShells.execute({}, ctx);
  assert.match(afterList.output, /after it had come up|stopped by/, `list_shells must explain the stop, got: ${afterList.output}`);

  mgr.dispose();
});

test("a server that never comes up is described as such, not as a bare exit code", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "console.error('EADDRINUSE: port taken'); process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const listed = await listShells.execute({}, ctx);
  assert.match(listed.output, /never came up/, `got: ${listed.output}`);
  assert.equal(mgr.pendingCount(), 1, "the user never saw it, so this interrupts");
  mgr.dispose();
});

test("a signalled shell never describes itself as 'exited null'", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  child.kill(); // ends by signal, so there IS no exit code
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.list()[0]!.exitCode, null, "a signalled process has no exit code");
  const listed = await listShells.execute({}, ctx);
  assert.doesNotMatch(listed.output, /exited null/, `got: ${listed.output}`);
  assert.match(listed.output, /stopped \(SIG/, `got: ${listed.output}`);
  mgr.dispose();
});

// ── the shell trio's claims, pinned ──────────────────────────────────────────

test("a rolled buffer is REPORTED, not silently incomplete", async () => {
  // entry.truncated was set on overflow and then read by nothing, so a log missing
  // megabytes of output looked identical to a complete one. A real child writes past
  // the cap, which is the only way to exercise the roll through the public surface.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.stdout.write('x'.repeat(5200000))"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "noisy", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const shown = (await mgr.read(info.id))!;
  assert.equal(shown.info.truncated, true, "the roll must be visible on the public view");
  // …and it must reach the model, through the tool it actually calls.
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const listed = await listShells.execute({}, ctx);
  assert.match(listed.output, /this log is incomplete/i);
  mgr.dispose();
});

test("kill_shell reports a non-running shell plainly, not as a failure", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const r = await killShell.execute({ id: 999 }, ctx);
  assert.match(r.output, /wasn't running/i);
  assert.notEqual(r.isError, true, "nothing went wrong; there was simply nothing to stop");
  assert.match(killShell.description, /not an error/i);
  mgr.dispose();
});

test("list_shells' description names the two questions its output answers", () => {
  assert.match(listShells.description, /IS IT UP/i);
  assert.match(listShells.description, /WHY DID IT STOP/i);
});

test("shell_output's stated read cap is the real one", () => {
  assert.match(shellOutput.description, /at most 30,000 characters/i);
});

test("disposing kills a shell's descendants even after the wrapper has exited", async () => {
  // The POSIX leak, isolated. Killing the `sh -c` wrapper does NOT kill what it
  // started: the program is orphaned, keeps running, and keeps the stdio pipes open,
  // so the owning process can never exit. dispose() used to skip any shell it had
  // already marked "ended", which is exactly this case, so the orphan was never
  // reaped. Measured on Linux: it outlived the entire test run.
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
  } as unknown as ToolContext;

  await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true },
    ctx,
  );
  const id = mgr.running()[0]!.id;
  const entry = (mgr as unknown as { shells: Map<number, { child: { pid?: number; kill(): void } | null }> }).shells.get(id)!;
  const wrapperPid = entry.child!.pid!;

  // The wrapper dies; whatever it started does not.
  entry.child!.kill();
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.status !== "running");

  mgr.dispose();
  await new Promise((r) => setTimeout(r, 1200)); // killTree escalates asynchronously

  assert.equal(
    isProcessStopped(wrapperPid),
    true,
    "the shell's process group must be gone after dispose, wrapper and descendants alike",
  );
});
