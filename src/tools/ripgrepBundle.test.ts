/**
 * ripgrepBundle.test.ts — the search engine ships with Mindweave.
 *
 * This exists because the degradation it prevents is invisible. Search has two engines:
 * ripgrep, and a pure-Node walk that re-reads every candidate file and — until v1.9.3 —
 * did not honour `.gitignore` at all. A machine without ripgrep silently gets the slower,
 * less accurate one forever, and nothing on screen says so. That was the state of this
 * project's own dev machine for months, and it was only noticed because a multiline
 * search claimed a capability the walk did not implement.
 *
 * So the binary is bundled. What is asserted here is that it is REACHABLE, not merely
 * declared: a dependency in package.json that nothing can resolve is exactly the kind of
 * fact that stays true in the manifest and false on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ripgrepPath, ripgrepAvailable } from "./ripgrep.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

test("ripgrep is declared OPTIONAL, not required", () => {
  // The distinction is the whole install story. On an unsupported architecture, a
  // locked-down registry, or `npm install --no-optional`, a required dependency fails
  // the install outright — while an optional one just isn't there and search falls back
  // to the walk. Search getting slower is an acceptable failure; `npm install mindweave`
  // failing is not.
  assert.ok(pkg.optionalDependencies?.["@vscode/ripgrep"], "@vscode/ripgrep must be an optional dependency");
  assert.equal(pkg.dependencies?.["@vscode/ripgrep"], undefined, "declaring it required would break installs it should degrade on");
});

test("the bundled binary is found without ripgrep being on PATH", () => {
  // The point of bundling: a user who has never installed ripgrep still gets it. If this
  // resolves to the bare name "rg" we are back to depending on the user's machine.
  const resolved = ripgrepPath();
  assert.notEqual(resolved, "rg", "resolution fell through to PATH — the bundled binary was not found");
  assert.match(resolved, /ripgrep/, `unexpected binary: ${resolved}`);
});

test("and it actually runs", async () => {
  // A resolvable path is not a working binary. This is the check that would catch a
  // platform package installed for the wrong architecture.
  const version = execFileSync(ripgrepPath(), ["--version"]).toString();
  assert.match(version, /^ripgrep \d+\./, `unrecognised output: ${version.split("\n")[0]}`);

  // `ripgrepAvailable` answers a different question: whether search WILL use it. The CI
  // matrix runs the whole suite a second time under MINDWEAVE_NO_RIPGREP=1 so the
  // pure-Node walk gets exercised on a machine that has ripgrep, and under that switch
  // the honest answer is no. Asserting `true` unconditionally made this file fail the
  // one run that exists to prove the fallback works.
  const forcedOff = process.env.MINDWEAVE_NO_RIPGREP === "1";
  assert.equal(
    await ripgrepAvailable(),
    !forcedOff,
    forcedOff ? "the kill switch did not turn ripgrep off" : "the bundled ripgrep did not answer --version",
  );
});

test("an explicit override still wins", () => {
  // Someone pinning a specific build must not be quietly overridden by the bundled copy.
  // Read from the module's own resolution order rather than re-implementing it here.
  const src = readFileSync(new URL("./ripgrep.ts", import.meta.url), "utf8");
  const order = src.match(/const RG = ([^;]+);/)?.[1] ?? "";
  assert.match(order, /MINDWEAVE_RIPGREP_PATH/, "the env override is gone");
  assert.ok(
    order.indexOf("MINDWEAVE_RIPGREP_PATH") < order.indexOf("bundled"),
    "the bundled binary is consulted before the user's explicit override",
  );
  assert.ok(order.indexOf("bundled") < order.lastIndexOf('"rg"'), "PATH must be the last resort, not the first");
});
