/**
 * runCommandExit.test.ts — exit-code honesty and output truncation.
 *
 * Both fix defects that were SILENT: a failing PowerShell command that reported
 * success, and a long command whose failure was thrown away in favour of its
 * banner. Neither showed up as a crash, which is why both survived shipping —
 * so they get behavioural tests rather than shape assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { runCommand } from "./runCommand.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


const IS_WINDOWS = process.platform === "win32";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] };
}

// ── exit codes ───────────────────────────────────────────────────────────────

test(
  "a failing PowerShell cmdlet is reported as a failure, not a success",
  { skip: !IS_WINDOWS && "PowerShell path is Windows-only" },
  async () => {
    // The defect: $LASTEXITCODE is only set by native executables, so a cmdlet
    // failure left it null, which was coerced to 0 and reported as success. The
    // model then built on work that never happened.
    const result = await runCommand.execute(
      { command: 'Get-Content "D:\\mindweave-definitely-missing-xyzzy.txt"' },
      ctx(),
    );
    assert.equal(result.isError, true, "a failed command must not report success");
    assert.match(result.output, /exited with code/);
  },
);

test(
  "a native program's own exit code survives, rather than being flattened to 1",
  { skip: !IS_WINDOWS && "PowerShell path is Windows-only" },
  async () => {
    const result = await runCommand.execute({ command: 'cmd /c "exit 3"' }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.output, /code 3/);
  },
);

test("a command that works still reports success", async () => {
  const result = await runCommand.execute(
    { command: IS_WINDOWS ? 'Write-Output "hello"' : 'echo hello' },
    ctx(),
  );
  assert.ok(!result.isError, "a working command must not be flagged as an error");
  assert.match(result.output, /hello/);
});

// ── truncation ───────────────────────────────────────────────────────────────

test("a long output keeps its END, where a failure actually reports itself", async () => {
  // 40k+ of noise, then the line that matters. Head-only truncation dropped
  // exactly this, so a failing build read as a wall of progress and nothing else.
  const command = IS_WINDOWS
    ? '1..1200 | ForEach-Object { "noise line $_ ................................" }; Write-Output "THE_REAL_ERROR_IS_HERE"'
    : 'for i in $(seq 1 1200); do echo "noise line $i ................................"; done; echo "THE_REAL_ERROR_IS_HERE"';
  const result = await runCommand.execute({ command, timeout: 60_000 }, ctx());
  assert.match(result.output, /THE_REAL_ERROR_IS_HERE/, "the tail must survive truncation");
  assert.match(result.output, /noise line 1 /, "the head must survive too");
  assert.match(result.output, /omitted from the middle/);
});

test("the dropped middle is KEPT on disk and the model is told where", async () => {
  // Before this, the output file was composed into head+tail and then deleted on the
  // spot, so the middle of a long build or test log was gone for good and the only way
  // back to it was running the command again — impossible for anything not repeatable.
  const command = IS_WINDOWS
    ? '1..1200 | ForEach-Object { "noise line $_ ................................" }; Write-Output "NEEDLE_IN_THE_MIDDLE_TAIL"'
    : 'for i in $(seq 1 1200); do echo "noise line $i ................................"; done; echo "NEEDLE_IN_THE_MIDDLE_TAIL"';
  const result = await runCommand.execute({ command, timeout: 60_000 }, ctx());

  assert.match(result.output, /The FULL output is at /, "a truncated run must name where the rest is");

  // The named path has to be real, and has to hold what the model was NOT shown.
  const named = /The FULL output is at (\S+)/.exec(result.output)?.[1];
  assert.ok(named, `no path in: ${result.output.slice(-300)}`);
  const whole = await readFile(named!, "utf8");
  assert.ok(whole.length > result.output.length, "the file should hold more than was shown");
  assert.match(whole, /noise line 600 /, "a line from the dropped middle is recoverable");
  assert.doesNotMatch(result.output, /noise line 600 /, "…and was genuinely not shown inline");

  await rm(named!, { force: true });
});

test("a command whose output fitted leaves no file behind", async () => {
  // Retention is for what was DROPPED. Keeping a file per command run would litter the
  // temp directory for no gain — there is nothing to go back for.
  //
  // The temp directory is POINTED SOMEWHERE PRIVATE for this check. Counting files in
  // the shared one looks equivalent and is not: the suite runs test files concurrently
  // in separate processes against the same directory, so another file's command creates
  // an output file mid-count and this fails with an off-by-one that has nothing to do
  // with the behaviour under test. It did exactly that on CI.
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const isolated = await mkdtemp(join(tmpdir(), "mw-retain-"));
  process.env.TMPDIR = isolated;
  process.env.TEMP = isolated;
  process.env.TMP = isolated;
  try {
    const result = await runCommand.execute({ command: 'echo "small"', timeout: 30_000 }, ctx());
    assert.doesNotMatch(result.output, /The FULL output is at/, "nothing was dropped, so nothing to point at");

    // WAIT for the delete rather than assuming it has landed. `removeOutputFile` is
    // deliberately fire-and-forget (`void fs.rm(...)`) so a finished command is not held
    // up by its own cleanup, which means the file legitimately outlives the call by a
    // tick. Asserting immediately tests the scheduler, not the behaviour.
    const remaining = async () => (await readdir(isolated)).filter((n) => n.startsWith("mindweave-out-"));
    const deadline = Date.now() + 5_000;
    while ((await remaining()).length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(await remaining(), [], "an untruncated run must clean up after itself");
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(isolated, { recursive: true, force: true });
  }
});
