/**
 * exitPlan.test.ts — the plan handoff.
 *
 * What matters here is not that the tool runs, but that it never grants work nobody
 * approved, and that approval actually changes what the model may do. Both are
 * checked against the real registry filter and the real flags, not a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { exitPlan, readVerdict, planQuestion, PLAN_CHOICES } from "./exitPlan.js";
import { toolSchemas } from "./registry.js";
import { modeFromFlags } from "../cli/modes.js";

/** A context in plan mode, with an approval channel that answers `choice`. */
function ctx(choice?: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    reads: new Map(),
    todos: [],
    planMode: true,
    guarded: false,
    ...(choice === undefined ? {} : { requestApproval: async () => choice }),
    ...extra,
  } as ToolContext;
}

const PLAN = "1. Change foo.ts\n2. Change bar.ts";

// ── readVerdict ──────────────────────────────────────────────────────────────

test("readVerdict maps each offered choice to its decision", () => {
  assert.equal(readVerdict(PLAN_CHOICES[0]), "lightning");
  assert.equal(readVerdict(PLAN_CHOICES[1]), "sentinel");
  assert.equal(readVerdict(PLAN_CHOICES[2]), "reject");
  assert.equal(readVerdict(PLAN_CHOICES[3]), "revise");
});

test("readVerdict treats anything it does not recognise as a refusal", () => {
  // The failure that matters is starting work nobody approved, so an empty,
  // garbled, or unexpected answer must never read as yes.
  for (const odd of ["", "   ", "yes", "ok go", "Esc", "undefined"]) {
    assert.equal(readVerdict(odd), "reject", `"${odd}" must not approve`);
  }
});

test("readVerdict tolerates casing and surrounding space", () => {
  assert.equal(readVerdict("  APPROVE — SENTINEL (ask each action)  "), "sentinel");
});

// ── the approval prompt ──────────────────────────────────────────────────────

test("the whole plan reaches the approval prompt, not a summary of it", () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n");
  const q = planQuestion(long);
  assert.ok(q.startsWith(long), "the plan must be shown in full and first");
  assert.match(q, /Start on this\?$/);
});

// ── refusal paths ────────────────────────────────────────────────────────────

test("a rejected plan leaves planning in force", async () => {
  const c = ctx(PLAN_CHOICES[2]);
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, true, "rejection must not lift plan mode");
  assert.equal(c.planResume, undefined);
  assert.match(r.output, /rejected/i);
});

test("sending the plan back for changes leaves planning in force", async () => {
  const c = ctx(PLAN_CHOICES[3]);
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, true);
  assert.equal(c.planResume, undefined);
});

test("an empty plan is refused before the user is ever asked", async () => {
  let asked = false;
  const c = ctx(undefined, { requestApproval: async () => { asked = true; return PLAN_CHOICES[0]; } });
  const r = await exitPlan.execute({ plan: "   " }, c);
  assert.equal(r.isError, true);
  assert.equal(asked, false, "nothing should be put to the user without a plan");
});

test("with no way to ask, nothing is approved", async () => {
  const c = ctx(); // no requestApproval
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(r.isError, true);
  assert.equal(c.planMode, true);
});

// ── approval ─────────────────────────────────────────────────────────────────

test("approving into Lightning lifts planning for this turn only", async () => {
  const c = ctx(PLAN_CHOICES[0]);
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, false, "work must be able to start");
  assert.equal(c.guarded, false);
  assert.equal(c.planResume, true, "the engine must know to restore planning");
  assert.match(r.output, /approved/i);
});

test("approving into Sentinel lifts planning but keeps each action gated", async () => {
  const c = ctx(PLAN_CHOICES[1], { guardAllowAll: true });
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, false);
  assert.equal(c.guarded, true);
  // A stale "allow all" from earlier must not silently cover newly approved work.
  assert.equal(c.guardAllowAll, false);
  assert.equal(c.planResume, true);
});

test("approval tells the UI its mode flags moved", async () => {
  let told = 0;
  const c = ctx(PLAN_CHOICES[0], { onModeChange: () => void told++ });
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(told, 1);
});

test("a refusal does not tell the UI anything moved", async () => {
  let told = 0;
  const c = ctx(PLAN_CHOICES[2], { onModeChange: () => void told++ });
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(told, 0);
});

// ── what the model is offered ────────────────────────────────────────────────

test("exit_plan is offered while planning and hidden otherwise", () => {
  const named = (o: Parameters<typeof toolSchemas>[0]) =>
    toolSchemas(o).map((s) => s.function.name);
  assert.ok(named({ planMode: true }).includes("exit_plan"), "planning must be able to end");
  assert.ok(!named({}).includes("exit_plan"), "there is nothing to exit in an ordinary turn");
  // A read-only sub-agent is restricted, not planning: it has no plan to hand over.
  assert.ok(!named({ readOnlyOnly: true }).includes("exit_plan"));
});

test("planning still withholds the editing tools", () => {
  const named = toolSchemas({ planMode: true }).map((s) => s.function.name);
  for (const t of ["write_file", "edit_file", "run_command"]) {
    assert.ok(!named.includes(t), `${t} must not be offered while planning`);
  }
});

// ── the flags name a mode ────────────────────────────────────────────────────

test("the indicator can name whatever state the flags are left in", async () => {
  assert.equal(modeFromFlags({ planMode: true }), "architect");
  assert.equal(modeFromFlags({ guarded: true }), "sentinel");
  assert.equal(modeFromFlags({}), "lightning");
  // Read-only wins: a turn that cannot act has nothing left to confirm.
  assert.equal(modeFromFlags({ planMode: true, guarded: true }), "architect");

  const c = ctx(PLAN_CHOICES[1]);
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(modeFromFlags(c), "sentinel", "approval into Sentinel must read as Sentinel");
});
