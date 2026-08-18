/**
 * killTree.test.ts — the property that makes exit-handler teardown work.
 *
 * `killTreeSync` exists because Node runs no async work during `process.exit`,
 * so a kill that spawns `taskkill` asynchronously never reaches the OS and the
 * server survives. The guarantee under test is therefore not "the process dies
 * eventually" but "the process is dead by the time the call RETURNS", with no
 * awaiting in between — that is the only thing an exit handler can rely on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killTree, killTreeSync, isProcessStopped, spawnManaged } from "./killTree.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * The child announces itself before settling into its loop, so the test can WAIT for it
 * rather than guess how long booting takes. `ready()` below is the other half.
 *
 * The guess is what made this file flaky: it slept 400ms and assumed a Node process had
 * started. Alone that is true with room to spare; inside a full suite run — a hundred
 * test files, each with its own Node — it is a race, and this file failed twice in one
 * day while passing every time it was run on its own.
 */
const CHILD_SCRIPT = 'process.stdout.write("up"); setInterval(() => {}, 1000)';

/** A long-lived child we can try to kill, spawned PLAINLY (leads no process group). */
function longLivedChild() {
  return spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

/** The same, through the managed path that makes it a process-group leader. */
function longLivedManagedChild() {
  return spawnManaged(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Still running? Deliberately NOT a bare `kill(pid, 0)`.
 *
 * On POSIX a killed child is a ZOMBIE until reaped, and `kill(pid, 0)` succeeds
 * against a zombie, so that check calls a correctly killed process alive and these
 * tests failed on Linux while the kill was working perfectly.
 */
function alive(pid: number | undefined): boolean {
  return !isProcessStopped(pid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the child's own "up" byte — a real readiness signal, not a timer.
 *
 * Polling `kill(pid, 0)` instead would be no better than the sleep it replaces, and
 * arguably worse: a pid exists the instant `spawn` returns, so the test would race
 * ahead and kill a process that had not finished initialising. Waiting for output the
 * child itself produced means it is genuinely running.
 *
 * A spawn that never produced a pid is called out separately, because "the child never
 * started" and "the child started slowly" are different problems and a flake that
 * reappears should say which it was.
 */
async function ready(child: { pid?: number; stdout: NodeJS.ReadableStream | null }, budgetMs = 15_000): Promise<void> {
  assert.ok(child.pid, "spawn produced no pid at all — the child never started");
  const stdout = child.stdout;
  assert.ok(stdout, "the child must be spawned with a pipe so it can report readiness");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child ${child.pid} never reported ready within ${budgetMs}ms`)),
      budgetMs,
    );
    stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The child pids of `pid`, once at least one exists (Windows). Polled, because a
 *  shell spawning a real process takes as long as the machine takes. */
async function waitForChildren(pid: number, budgetMs = 15_000): Promise<number[]> {
  const { execSync } = await import("node:child_process");
  const t0 = Date.now();
  let kids: number[] = [];
  while (Date.now() - t0 < budgetMs) {
    kids = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8" },
    )
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    if (kids.length > 0) return kids;
    await sleep(50);
  }
  return kids;
}

/**
 * Wait until the process is gone, reporting how long it took if it never is.
 *
 * The guarantee being tested is "killTree kills it, given time" — the test's own name
 * says so. A fixed sleep asserts something stricter and accidental ("within exactly
 * 1500ms"), which is a property no caller depends on and the machine can break under
 * load. Polling keeps the real guarantee and, when it genuinely fails, says how long it
 * waited instead of just that a boolean was wrong.
 */
async function waitDead(pid: number | undefined, budgetMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (!alive(pid)) return;
    await sleep(25);
  }
  assert.fail(`process ${pid} was still alive ${budgetMs}ms after killTree`);
}

test("killTreeSync has killed the process by the time it returns", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await ready(child);

  killTreeSync(child.pid);

  // No await here on purpose: an exit handler gets nothing after this line.
  assert.equal(alive(child.pid), false, "killTreeSync must block until the process is gone");
});

test("killTree kills the process, just not synchronously", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await ready(child);

  killTree(child.pid);
  // Polled, not slept: the async variant needs an event loop turn to finish the job,
  // and how many turns that takes is the machine's business, not this test's.
  await waitDead(child.pid);
});

test("both variants tolerate a missing pid rather than throwing", () => {
  assert.doesNotThrow(() => killTree(undefined));
  assert.doesNotThrow(() => killTreeSync(undefined));
  // A pid that cannot exist: the caller races process death constantly, so this
  // has to be a no-op rather than an exception on a teardown path.
  assert.doesNotThrow(() => killTreeSync(0x7ffffff0));
});

test("killTreeSync reaps a shelled tree, not just the wrapper", { timeout: 30_000 }, async (t) => {
  if (!IS_WINDOWS) {
    t.skip("shell-shim orphaning is the Windows spawn path");
    return;
  }
  // The shape npm-installed language servers arrive in: a shell wrapper whose
  // real work is a grandchild. Killing the handle alone leaves the grandchild.
  const wrapper = spawn(`node -e "setInterval(()=>{},1000)"`, {
    stdio: "ignore",
    windowsHide: true,
    shell: true,
  });
  const wrapperPid = wrapper.pid!;
  // The readiness signal here is the GRANDCHILD existing — that is the thing this test
  // is about, and the wrapper cannot report it. Polled for the same reason as
  // everywhere else in this file: a shell spawning a Node process takes as long as the
  // machine takes, and the previous fixed 800ms wait was a guess about that.
  const kids = await waitForChildren(wrapperPid);
  assert.ok(kids.length > 0, "the shell wrapper should have a real child to orphan");

  killTreeSync(wrapperPid);

  const survivors = kids.filter(alive);
  assert.deepEqual(survivors, [], `orphaned descendants after killTreeSync: ${survivors.join(", ")}`);
});

test("a plainly-spawned child is killed too, not silently ignored", { timeout: 30_000 }, async () => {
  // The POSIX hang, in one test. killTree signals the process GROUP led by the pid,
  // but a plain (non-detached) spawn leads no group, so the signal raised ESRCH and
  // the catch swallowed it: no error, no signal, nothing dead. The child then kept
  // Node's event loop alive and the whole test FILE hung instead of failing.
  // MEASURED on Linux before the fix: state "S" (running) after killTreeSync returned.
  const child = longLivedChild();
  await ready(child);

  killTreeSync(child.pid);

  assert.equal(alive(child.pid), false, "a non-group-leader pid must still be killed");
});

test("a managed child is killed through its process group", { timeout: 30_000 }, async () => {
  const child = longLivedManagedChild();
  await ready(child);

  killTree(child.pid);
  await waitDead(child.pid);
});

test("a zombie counts as stopped, so a killed child is not reported alive", { timeout: 30_000 }, async () => {
  // Guards the liveness check itself. Without this, the whole file passes on Windows
  // and fails on POSIX for a reason that has nothing to do with killing.
  const child = longLivedManagedChild();
  await ready(child);
  killTreeSync(child.pid);

  assert.equal(isProcessStopped(child.pid), true, "killed child must read as stopped");
  assert.equal(isProcessStopped(undefined), true, "no pid is trivially stopped");
  assert.equal(isProcessStopped(process.pid), false, "this very process is running");
});
