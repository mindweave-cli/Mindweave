/**
 * restart.test.ts — handing the terminal over, and what happens when the new copy
 * cannot take it.
 *
 * Nothing here spawns anything. The point of the split in `restart.ts` is that the
 * decisions — which command, what an exit means, what the user is told — are answerable
 * without a second process, so they can be tested exhaustively rather than once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyExit, failedStartMessage, relaunch, relaunchArgv, type RelaunchDeps } from "./restart.js";

const WIN_ROOT = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\mindweave";

// ── which command ────────────────────────────────────────────────────────────

test("the successor is launched through Node, not through the .cmd launcher", () => {
  // A `.cmd` has to go through a shell, and then every path with a space in it is a
  // quoting problem. Node is already here and takes its arguments as an array.
  const { command, args } = relaunchArgv("C:\\Program Files\\nodejs\\node.exe", WIN_ROOT, "abc-123");
  assert.equal(command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(args, [`${WIN_ROOT}\\dist\\index.js`, "--resume", "abc-123"]);
});

test("without a session there is no --resume to pass", () => {
  const { args } = relaunchArgv("/usr/bin/node", "/home/u/.local/lib/node_modules/mindweave");
  assert.deepEqual(args, ["/home/u/.local/lib/node_modules/mindweave/dist/index.js"]);
});

test("the separator follows the path it was given", () => {
  assert.match(relaunchArgv("node", WIN_ROOT).args[0]!, /\\dist\\index\.js$/);
  assert.match(relaunchArgv("node", "/opt/mindweave").args[0]!, /\/dist\/index\.js$/);
});

// ── what an exit means ───────────────────────────────────────────────────────

test("a clean exit is a session that ended, however long it ran", () => {
  assert.deepEqual(classifyExit(0, null, 12), { kind: "ok", code: 0 });
  assert.deepEqual(classifyExit(0, null, 900_000), { kind: "ok", code: 0 });
});

test("dying at once means the new version cannot start here", () => {
  // The only outcome the update is answerable for. A build that is broken on this
  // machine fails during startup, before anyone has typed anything.
  assert.equal(classifyExit(1, null, 200).kind, "failedStart");
});

test("failing much later is an ordinary crash, not a bad update", () => {
  // The distinction earns its keep by what it prevents: telling someone to reinstall an
  // older version because their session fell over an hour after they updated.
  assert.equal(classifyExit(1, null, 20 * 60 * 1000).kind, "crashed");
});

test("a signal is how a session is ended, not how a bad version behaves", () => {
  // Ctrl+C arrives whenever it arrives. Reading one as a failed start would send someone
  // back a version for stopping the app a moment after it opened.
  assert.equal(classifyExit(130, "SIGINT", 50).kind, "ok");
  assert.equal(classifyExit(null, "SIGTERM", 10).kind, "ok");
});

// ── the handover ─────────────────────────────────────────────────────────────

/** A relaunch whose every effect is recorded rather than performed. */
function fakeDeps(exit: { code: number | null; signal: string | null }, ranForMs = 1): {
  deps: RelaunchDeps;
  log: string[];
} {
  const log: string[] = [];
  let clock = 0;
  return {
    log,
    deps: {
      teardown: () => {
        log.push("teardown");
      },
      spawn: (command, args) => {
        log.push(`spawn ${command} ${args.join(" ")}`);
        clock += ranForMs;
        return Promise.resolve(exit);
      },
      report: (text) => log.push(`report: ${text.split("\n")[0]}`),
      now: () => clock,
    },
  };
}

test("the terminal is released BEFORE anything else is started", () => {
  // The one ordering that cannot be got wrong. Two renderers on one screen is precisely
  // the corruption this whole area has been chasing.
  const { deps, log } = fakeDeps({ code: 0, signal: null });
  return relaunch(WIN_ROOT, "s1", "2.2.1", "C:\\npm", deps).then(() => {
    assert.equal(log[0], "teardown");
    assert.match(log[1] ?? "", /^spawn /);
  });
});

test("the exit code of the successor is the exit code of the whole run", async () => {
  // The shell that started this sees one process with one result, whatever happened in
  // the middle.
  const { deps } = fakeDeps({ code: 3, signal: null }, 30_000);
  assert.equal(await relaunch(WIN_ROOT, "s1", "2.2.1", "C:\\npm", deps), 3);
});

test("a version that cannot start says so, and how to go back", async () => {
  const { deps, log } = fakeDeps({ code: 1, signal: null }, 100);
  await relaunch(WIN_ROOT, "s1", "2.2.1", "C:\\npm", deps);
  assert.ok(
    log.some((l) => l.startsWith("report:")),
    `nothing was reported: ${JSON.stringify(log)}`,
  );
});

test("an ordinary session says nothing at all", async () => {
  // A quiet exit must stay quiet: printing a rollback command after every normal close
  // would teach people to ignore it.
  const { deps, log } = fakeDeps({ code: 0, signal: null }, 60_000);
  await relaunch(WIN_ROOT, "s1", "2.2.1", "C:\\npm", deps);
  assert.ok(!log.some((l) => l.startsWith("report:")), JSON.stringify(log));
});

test("a late crash does not send anyone back a version", async () => {
  const { deps, log } = fakeDeps({ code: 1, signal: null }, 30 * 60 * 1000);
  await relaunch(WIN_ROOT, "s1", "2.2.1", "C:\\npm", deps);
  assert.ok(!log.some((l) => l.startsWith("report:")), JSON.stringify(log));
});

test("the rollback names the version that was working and the prefix it was in", () => {
  const text = failedStartMessage("2.2.1", "C:\\Users\\dev\\AppData\\Roaming\\npm");
  assert.match(text, /mindweave@2\.2\.1/);
  assert.match(text, /--prefix C:\\Users\\dev\\AppData\\Roaming\\npm/);
  assert.match(text, /did not start/);
});
