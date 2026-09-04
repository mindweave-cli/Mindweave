/**
 * commandLabel.test.ts — a shell command named in one row.
 *
 * The failure these guard was on screen: a long PowerShell pipeline trimmed from the
 * front, so the row said `…-SimpleMatch:$false | Select-Object -Last 25` and named
 * neither the program nor what it was doing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandLabel, firstSegment } from "./commandLabel.js";

test("a pipeline is named by its first command", () => {
  const command =
    "gh run view 33756215434 --repo acme/site --log-failed 2>&1 | Select-String -Pattern 'error' | Select-Object -Last 25";
  assert.equal(commandLabel(command, 80), "gh run view 33756215434 --repo acme/site --log-failed");
});

test("a pipe inside quotes is not a pipe", () => {
  // `-Pattern 'error|ERR|failed'` carries pipes in an argument. Splitting on the first
  // one would name the command `… -Pattern 'error`.
  const command = "gh run view --log-failed | Select-String -Pattern 'error|ERR|failed'";
  assert.equal(firstSegment(command), "gh run view --log-failed ");
});

test("chains end the name too", () => {
  assert.equal(commandLabel("npm run build && npm test", 80), "npm run build");
  assert.equal(commandLabel("git fetch; git status", 80), "git fetch");
  assert.equal(commandLabel("mkdir out || true", 80), "mkdir out");
});

test("trailing redirection is plumbing, not the command", () => {
  assert.equal(commandLabel("npm test 2>&1", 80), "npm test");
  assert.equal(commandLabel("tsc --noEmit > build.log", 80), "tsc --noEmit");
});

test("a short command is left exactly as it is", () => {
  assert.equal(commandLabel("npm run build", 80), "npm run build");
});

test("what does not fit is cut from the END, keeping the program", () => {
  // The whole point. A path is identified by its tail and a command by its head.
  const label = commandLabel("gh run view 33756215434 --repo acme/site --log-failed", 30);
  assert.ok(label.startsWith("gh run view"), `lost the program: ${label}`);
  assert.ok(label.length <= 30, `over budget: ${label}`);
  assert.ok(label.endsWith("…"), `no sign it continues: ${label}`);
});

test("a cut lands on a token boundary, not mid-flag", () => {
  // Ending on a flag is fine; ending on HALF a flag is not. So every token kept has to
  // be a whole token of the original — `--force-rec…` would fail this, `--detach…` passes.
  const command = "docker compose up --detach --force-recreate --remove-orphans";
  const label = commandLabel(command, 34);
  const whole = new Set(command.split(" "));
  for (const token of label.replace(/…$/, "").trim().split(" ")) {
    assert.ok(whole.has(token), `cut through a token: ${token} in ${label}`);
  }
});

test("a distant boundary does not cost most of the row", () => {
  // The remaining argument is one long quoted token, so the nearest space is far back.
  // Honouring it there showed `Start-Process "chrome.exe" -ArgumentList…` in a row with
  // room for twice that, and said nothing about which file was being opened.
  const command =
    'Start-Process "chrome.exe" -ArgumentList "--new-window","file:///C:/src/site/changelog.html"';
  const label = commandLabel(command, 79);
  assert.ok(label.length >= 70, `gave up ${79 - label.length} columns: ${label}`);
  assert.match(label, /changelog|file:\/\/\//, `never reached the interesting part: ${label}`);
});

test("a single unbroken token still fits the budget", () => {
  // No space to cut at, so the budget wins over the boundary.
  const label = commandLabel("./" + "a".repeat(60), 20);
  assert.ok(label.length <= 20, `over budget: ${label}`);
});

test("a command that is nothing but a pipeline still gets a name", () => {
  // Nothing before the separator, so falling back to the whole line beats naming it "".
  assert.notEqual(commandLabel("| Select-Object -Last 5", 40), "");
});
