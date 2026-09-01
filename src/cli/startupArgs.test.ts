/**
 * startupArgs.test.ts — the flags handled before the UI starts.
 *
 * The bug these guard against could not fail a test that only checked output:
 * `--version` DID print the version, as part of the banner, and then started the
 * interactive app and never exited. So what matters is the decision — run, or print
 * and stop — not the text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStartupArgs, versionText, helpText, hasInteractiveInput, NO_TERMINAL_MESSAGE } from "./startupArgs.js";

test("--version and -v ask to print, not to run", () => {
  for (const flag of ["--version", "-v"]) {
    const s = parseStartupArgs([flag]);
    assert.equal(s.kind, "print", `${flag} must not start the session`);
  }
});

test("--help and -h ask to print, not to run", () => {
  for (const flag of ["--help", "-h"]) {
    assert.equal(parseStartupArgs([flag]).kind, "print", `${flag} must not start the session`);
  }
});

test("no arguments starts a session", () => {
  assert.equal(parseStartupArgs([]).kind, "run");
});

test("an unknown argument still starts a session", () => {
  // Refusing to launch over an undocumented argument would be a worse failure than
  // ignoring it: the session roots at the current directory either way.
  assert.equal(parseStartupArgs(["--colour=always"]).kind, "run");
  assert.equal(parseStartupArgs(["some-path"]).kind, "run");
});

test("a flag is recognised wherever it appears", () => {
  assert.equal(parseStartupArgs(["something", "--version"]).kind, "print");
});

test("only the exact flags count", () => {
  // "--versions" is not "--version", and silently treating it as one would print
  // and exit when the user asked for something else entirely.
  assert.equal(parseStartupArgs(["--versions"]).kind, "run");
  assert.equal(parseStartupArgs(["--helpme"]).kind, "run");
});

test("version output is one parseable line, not a banner", () => {
  const text = versionText();
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /^mindweave (\d+\.\d+\.\d+|\(version unknown\))$/);
});

test("help names the flags it supports and where the key goes", () => {
  const text = helpText();
  assert.match(text, /--help/);
  assert.match(text, /--version/);
  assert.match(text, /~\/\.mindweave\/\.env/);
  // /help is the in-session list; the two must not be confused for each other.
  assert.match(text, /\/help/);
});

test("--reset-terminal repairs instead of running or printing", () => {
  // Not `print`: whether there is a terminal to write escapes to is a question about the
  // real stdout, and this parser stays pure. Above all not `run` — the terminal is
  // already misbehaving, and starting a session would put it straight back.
  assert.equal(parseStartupArgs(["--reset-terminal"]).kind, "reset");
});

test("--reset-terminal is discoverable", () => {
  // The flag is worthless if nobody can find it: by the time it is needed the terminal
  // is spraying escape codes, and --help is where someone looks.
  assert.match(helpText(), /--reset-terminal/);
});

test("a near miss is not treated as the repair flag", () => {
  // Repairing when asked to start a session would look like a crash on launch.
  for (const arg of ["--reset", "--reset-term", "-r", "reset-terminal"]) {
    assert.equal(parseStartupArgs([arg]).kind, "run", arg);
  }
});

test("a pipe is not a terminal to read from, and a terminal is", () => {
  // The renderer needs raw mode on stdin. Without a terminal it fails from inside React
  // with a reconciler stack trace, on a process that still exits 0 — so the caller is
  // told the run succeeded. The entry point asks this first and stops.
  assert.equal(hasInteractiveInput({ isTTY: true }), true);
  assert.equal(hasInteractiveInput({ isTTY: false }), false, "a pipe is not a terminal");
  assert.equal(hasInteractiveInput({}), false, "a stream that says nothing is not a terminal");
});

test("the no-terminal message says what to do, and names nothing internal", () => {
  const m = NO_TERMINAL_MESSAGE;
  assert.match(m, /terminal/i, "it does not say what is missing");
  assert.match(m, /--help and --version work anywhere/, "it does not say what still works");
  for (const leak of [/raw mode/i, /react/i, /ink/i, /node_modules/, /stack/i]) {
    assert.doesNotMatch(m, leak, "the message repeats an internal detail the reader cannot act on");
  }
});

test("help names the release, not just the bare version", () => {
  // The tag is the release people actually know it by; the bare semver in --version is
  // for scripts, not for a person reading --help to see what they have installed.
  assert.ok(helpText().includes("Mindweave 1"), "the release name is missing from --help");
});
