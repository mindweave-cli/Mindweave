/**
 * approval.test.ts — the forbidden-path lift: ask the human, then proceed / refuse /
 * defer, and fall back to a hard refusal when there's no channel to ask.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestAgentDataAccess, requestForbiddenLift } from "./approval.js";
import type { ToolContext } from "./types.js";

function ctxWith(approve?: (q: string, o: string[]) => Promise<string>): ToolContext {
  return {
    cwd: "/proj",
    reads: new Map(),
    todos: [],
    governance: { rules: [], skills: [], forbidden: { patterns: ["secret.txt", "other"], root: "/proj" } },
    requestApproval: approve,
  };
}

test("no approval channel → hard refusal (fail-closed)", async () => {
  const ctx = ctxWith(undefined);
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "it is protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /protected/);
  // Deny-list untouched.
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["secret.txt", "other"]);
});

test("no approval channel → tagged as a governor row, not an ordinary tool failure", async () => {
  const ctx = ctxWith(undefined);
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "it is protected.");
  assert.equal(res!.displayKind, "governor");
  assert.equal(res!.displayName, "Governor");
});

test("Allow → proceeds (null) and lifts the pattern for the session", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[0]!); // first option = allow
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.equal(res, null); // proceed
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["other"]); // lifted just this one
});

test("Allow → records a one-shot notice for the UI to show as its own governor block", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[0]!); // allow
  await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.equal(ctx.governance!.notices?.length, 1);
  assert.match(ctx.governance!.notices![0]!, /secret\.txt/);
  assert.match(ctx.governance!.notices![0]!, /ALLOWED/);
});

test("Deny → keeps it protected", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[1]!); // second option = deny
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /declined to lift/);
  assert.deepEqual(ctx.governance!.forbidden.patterns, ["secret.txt", "other"]);
  assert.equal(res!.displayKind, "governor");
});

test("Defer → hands control back to the user", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[2]!); // third option = defer
  const res = await requestForbiddenLift(ctx, "secret.txt", "editing secret.txt", "protected.");
  assert.ok(res && res.isError);
  assert.match(res!.output, /will tell you how to proceed/);
  assert.equal(res!.displayKind, "governor");
});

// ── Another agent's data: ask first, remember the answer ───────────────────────

test("agent data: no approval channel → declines, and says whose data it is", async () => {
  const ctx = ctxWith(undefined);
  const res = await requestAgentDataAccess(ctx, "Cursor", "Reading .cursor/rules/x.md");
  assert.ok(res && res.isError);
  assert.match(res!.output, /Cursor/);
});

test("agent data: Yes → proceeds and is remembered for the session", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[0]!); // allow
  assert.equal(await requestAgentDataAccess(ctx, "Cursor", "Reading a.md"), null);
  assert.ok(ctx.agentDataAllowed?.has("Cursor"));

  // Asked once per tool, not once per file: a second file needs no new prompt.
  let askedAgain = false;
  ctx.requestApproval = async (_q, opts) => {
    askedAgain = true;
    return opts[1]!;
  };
  assert.equal(await requestAgentDataAccess(ctx, "Cursor", "Reading b.md"), null);
  assert.equal(askedAgain, false, "should not re-ask for a tool already allowed");
});

test("agent data: allowing one tool does not allow another", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[0]!);
  await requestAgentDataAccess(ctx, "Cursor", "Reading a.md");
  ctx.requestApproval = async (_q, opts) => opts[1]!; // deny the next one
  const res = await requestAgentDataAccess(ctx, "Claude Code", "Reading CLAUDE.md");
  assert.ok(res && res.isError, "a different tool must be asked about separately");
  assert.match(res!.output, /Claude Code/);
});

test("agent data: No → refuses and warns against passing it off as our own history", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[1]!); // deny
  const res = await requestAgentDataAccess(ctx, "Cursor", "Reading a.md");
  assert.ok(res && res.isError);
  assert.match(res!.output, /own history/);
  assert.ok(!ctx.agentDataAllowed?.has("Cursor"));
});

test("agent data: Defer → hands control back to the user", async () => {
  const ctx = ctxWith(async (_q, opts) => opts[2]!); // defer
  const res = await requestAgentDataAccess(ctx, "Cursor", "Reading a.md");
  assert.ok(res && res.isError);
  assert.match(res!.output, /wait for their direction/);
});
