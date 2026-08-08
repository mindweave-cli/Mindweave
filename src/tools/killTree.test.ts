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

/** A long-lived child we can try to kill, spawned PLAINLY (leads no process group). */
function longLivedChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** The same, through the managed path that makes it a process-group leader. */
function longLivedManagedChild() {
  return spawnManaged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
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

test("killTreeSync has killed the process by the time it returns", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await sleep(400); // let it actually start
  assert.ok(alive(child.pid), "child should be running before the kill");

  killTreeSync(child.pid);

  // No await here on purpose: an exit handler gets nothing after this line.
  assert.equal(alive(child.pid), false, "killTreeSync must block until the process is gone");
});

test("killTree kills the process, just not synchronously", { timeout: 30_000 }, async () => {
  const child = longLivedChild();
  await sleep(400);
  assert.ok(alive(child.pid));

  killTree(child.pid);
  await sleep(1500); // the async variant needs an event loop to finish the job

  assert.equal(alive(child.pid), false, "killTree should still kill, given time");
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
  await sleep(800);
  const wrapperPid = wrapper.pid!;

  const { execSync } = await import("node:child_process");
  const kids = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${wrapperPid} } | Select-Object -ExpandProperty ProcessId"`,
    { encoding: "utf8" },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
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
  await sleep(400);
  assert.ok(alive(child.pid), "child should be running before the kill");

  killTreeSync(child.pid);

  assert.equal(alive(child.pid), false, "a non-group-leader pid must still be killed");
});

test("a managed child is killed through its process group", { timeout: 30_000 }, async () => {
  const child = longLivedManagedChild();
  await sleep(400);
  assert.ok(alive(child.pid));

  killTree(child.pid);
  await sleep(1500);

  assert.equal(alive(child.pid), false);
});

test("a zombie counts as stopped, so a killed child is not reported alive", { timeout: 30_000 }, async () => {
  // Guards the liveness check itself. Without this, the whole file passes on Windows
  // and fails on POSIX for a reason that has nothing to do with killing.
  const child = longLivedManagedChild();
  await sleep(400);
  killTreeSync(child.pid);

  assert.equal(isProcessStopped(child.pid), true, "killed child must read as stopped");
  assert.equal(isProcessStopped(undefined), true, "no pid is trivially stopped");
  assert.equal(isProcessStopped(process.pid), false, "this very process is running");
});
