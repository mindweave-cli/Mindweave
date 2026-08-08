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
import { runCommand, composeOutput } from "./runCommand.js";

const IS_WINDOWS = process.platform === "win32";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] };
}

// ── composeOutput (pure) ─────────────────────────────────────────────────────

test("composeOutput joins the two ends untouched when nothing was dropped", () => {
  assert.equal(composeOutput("start", "end", 0), "startend");
  assert.equal(composeOutput("only", "", 0), "only");
});

test("composeOutput keeps BOTH ends and names the gap between them", () => {
  const out = composeOutput("FIRST", "LAST", 1234);
  assert.match(out, /^FIRST/);
  assert.match(out, /LAST$/);
  assert.match(out, /1,234 characters omitted from the middle/);
});

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
