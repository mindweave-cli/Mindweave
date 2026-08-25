/**
 * trust.probe.test.tsx — the gate on where Mindweave is allowed to work.
 *
 * Choosing the folder is the widest permission there is: every other guard is scoped to
 * the workspace. Opened at a drive root the workspace is the whole drive, so the
 * outside-the-workspace prompt can never fire — nothing is outside it. That is the case
 * this screen exists for, and it is why a broad root is never remembered.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { TrustGate } from "./components/TrustGate.js";
import { rootBreadth, trustPersists, breadthWarning, isTrusted, rememberTrust } from "./trust.js";

const DRIVE_ROOT = parse(resolve(process.cwd())).root;

test("a drive root and the home directory are recognised as broad", () => {
  assert.equal(rootBreadth(DRIVE_ROOT), "root");
  assert.equal(rootBreadth(homedir()), "home");
  assert.equal(rootBreadth(mkdtempSync(join(tmpdir(), "ordinary-"))), "ordinary");
});

test("a broad root is NEVER remembered, an ordinary folder is", () => {
  // Saying yes once to your home directory should not make everything you own a trusted
  // workspace forever. Claude Code makes the same call for the same case.
  assert.equal(trustPersists("root"), false);
  assert.equal(trustPersists("home"), false);
  assert.equal(trustPersists("ordinary"), true);

  const state = mkdtempSync(join(tmpdir(), "trust-state-"));
  rememberTrust(state, "root");
  assert.equal(existsSync(join(state, "trusted")), false, "a whole drive was recorded as trusted");
  assert.equal(isTrusted(state, "root"), false, "and it would not be asked about again");

  rememberTrust(state, "ordinary");
  assert.equal(isTrusted(state, "ordinary"), true, "an ordinary project is asked only once");
});

function frame(cwd: string) {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 88, rows: 30, on: () => {}, off: () => {}, removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const b = rootBreadth(cwd);
  const app = render(
    <TrustGate cwd={cwd} breadth={b} warning={breadthWarning(b, cwd)} persists={trustPersists(b)}
      version=" v1.9.9" docsUrl="mindweave.dev/docs" onTrust={() => {}} onQuit={() => {}} active={false} />,
    { stdout: stream, patchConsole: false },
  );
  app.unmount();
  // Whitespace collapsed: rendered text wraps at the terminal width, so a sentence the
  // screen shows perfectly well is split across lines in the frame.
  return out.join("").replace(/\s+/g, " ");
}

test("the screen names the folder and what will happen in it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ordinary-"));
  const out = frame(dir);
  assert.ok(out.includes(dir), "the folder being trusted is not shown");
  assert.match(out, /read, change and run files/, "it does not say what it will be able to do");
  assert.match(out, /Yes, work in this folder/);
  assert.match(out, /No, quit/, "there is no way to decline");
});

test("opening a whole drive says so, in the user's terms", () => {
  const out = frame(DRIVE_ROOT);
  assert.match(out, /whole drive/i, "the user is not told how wide this is");
  assert.match(out, /nothing is outside it/i, "the actual consequence is not stated");
  assert.match(out, /never remembered/i, "it does not say the answer is session-only");
});
