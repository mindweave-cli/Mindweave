/**
 * verifyReport.test.ts — the one mechanism that makes verification mean anything.
 *
 * The behaviour under test is not parsing. It is the REFUSAL: a model that skipped the
 * work and wrote "pass" must not be able to have that word taken at face value. Asking a
 * model to be honest does not survive load; counting whether its report contains command
 * output does, because that is a property of the text rather than of its intentions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceCount, parseVerdict, renderVerdict } from "./verifyReport.js";

/** A report in the shape the contract asks for. */
const withEvidence = `### Check: the CLI reports the new version
$ node dist/index.js --version
mindweave 2.4.5
=> PASS

### Check: an unknown flag is refused rather than ignored
$ node dist/index.js --nonsense
error: unknown option --nonsense
=> PASS

VERDICT: pass`;

test("a pass backed by commands and output is taken at its word", () => {
  const r = parseVerdict(withEvidence);
  assert.equal(r.verdict, "pass");
  assert.equal(r.evidence, 2);
  assert.equal(r.downgraded, false);
  assert.deepEqual(r.concerns, []);
  assert.ok(!r.body.includes("VERDICT:"), "the protocol line is stripped from the body");
});

test("a pass with NO evidence is downgraded — this is the whole point of the file", () => {
  // The default failure mode: read the code, describe the checks, write pass. Every word
  // here is plausible and none of it was run.
  const talk = `### Check: the refresh path
I reviewed the retry logic in flow.ts and the backoff is correct. The tests for it
look thorough and would pass. The error handling covers the transient cases.

VERDICT: pass`;
  const r = parseVerdict(talk);
  assert.equal(r.verdict, "partial", "an unevidenced pass must not stay a pass");
  assert.equal(r.downgraded, true);
  assert.equal(r.evidence, 0);
  assert.match(r.concerns[0]!, /without showing a single command/);
});

test("fail and partial are never downgraded, however thin", () => {
  // Claiming something is broken, or that you were blocked, is not a claim that benefits
  // the claimer — so there is nothing to police and no reason to second-guess it.
  const failed = parseVerdict("The build is broken.\n\nVERDICT: fail");
  assert.equal(failed.verdict, "fail");
  assert.equal(failed.downgraded, false);

  const blocked = parseVerdict("No test framework is configured.\n\nVERDICT: partial");
  assert.equal(blocked.verdict, "partial");
  assert.equal(blocked.downgraded, false);
});

test("a single evidenced check passes, but is flagged as not having tried to break anything", () => {
  const thin = `### Check: it builds
$ npm run build
tsc -p tsconfig.build.json
=> PASS

VERDICT: pass`;
  const r = parseVerdict(thin);
  assert.equal(r.verdict, "pass", "one real check is still a real check");
  assert.equal(r.evidence, 1);
  assert.match(r.concerns[0]!, /attempt to break it/);
});

test("the verdict line survives the decoration models put around it", () => {
  // Asked for a bare line, models reliably emit bold, quoted or punctuated versions. A
  // verdict that fails to parse reads as "reached no conclusion", which would flag every
  // well-behaved run and train the caller to ignore the flag.
  for (const line of ["VERDICT: pass", "**VERDICT: pass**", "> VERDICT: PASS", "- VERDICT: pass.", "#### VERDICT:  Pass"]) {
    const r = parseVerdict(`$ npm test\nall good\n\n${line}`);
    assert.equal(r.verdict, "pass", `did not parse: ${line}`);
  }
});

test("no verdict at all is reported as such, not guessed at", () => {
  const r = parseVerdict("$ npm test\neverything passed, looks good to me");
  assert.equal(r.verdict, "unstated");
  assert.match(r.concerns[0]!, /never stated a verdict/);
});

test("evidence needs OUTPUT, not just a command someone typed", () => {
  // A command with nothing after it is a command that appears in a report, not one that
  // was run. The output is the half that cannot be produced without running something.
  assert.equal(evidenceCount("$ npm test\nok 1 - it works"), 1);
  assert.equal(evidenceCount("$ npm test"), 0, "a bare command line proves nothing");
  assert.equal(evidenceCount("$ npm test\n\n### Check: next thing"), 0, "the next heading is not output");
  // The alternate shape models drift to when not using `$`.
  assert.equal(evidenceCount("**Command run:**\nnpm test\nok 1 - it works"), 1);
});

test("the rendered line says the outcome and how much work backs it", () => {
  assert.equal(renderVerdict(parseVerdict(withEvidence)), "verified · 2 checks");
  assert.equal(renderVerdict(parseVerdict("broken\n\nVERDICT: fail")), "FAILED verification · 0 checks");
  assert.match(renderVerdict(parseVerdict("$ x\ny\n\nVERDICT: pass")), /^verified · 1 check$/);
});

// ── the mechanical nudge ────────────────────────────────────────────────────

test("closing out a run of work with no check in it earns the reminder", async () => {
  const { needsVerificationNudge } = await import("./todo.js");
  const done = (content: string) => ({ content, activeForm: content, status: "completed" as const });

  // Three finished tasks, none of which was itself a check: this is the moment a long
  // run ends and the standing rule in the prompt is furthest away.
  assert.equal(needsVerificationNudge([done("add the oauth flow"), done("wire the transport"), done("update the UI")]), true);
});

test("the reminder stays quiet when it would be wrong", async () => {
  const { needsVerificationNudge } = await import("./todo.js");
  const done = (content: string) => ({ content, activeForm: content, status: "completed" as const });
  const open = (content: string) => ({ content, activeForm: content, status: "pending" as const });

  // Already verified: nagging here teaches the model to ignore the note, which costs more
  // than the note ever buys.
  assert.equal(needsVerificationNudge([done("add the flow"), done("wire it"), done("run the tests")]), false);
  assert.equal(needsVerificationNudge([done("add the flow"), done("wire it"), done("verify the redirect")]), false);
  // Mid-run: there is still work, so the turn is not ending.
  assert.equal(needsVerificationNudge([done("add the flow"), done("wire it"), open("update the UI")]), false);
  // Too small to be a run of work.
  assert.equal(needsVerificationNudge([done("fix the typo"), done("rebuild")]), false);
});
