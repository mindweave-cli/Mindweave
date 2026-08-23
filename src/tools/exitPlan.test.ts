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
import { exitPlan, readVerdict, readDecision, PLAN_QUESTION, PLAN_CHOICES, PLAN_FEEDBACK } from "./exitPlan.js";
import { APPROVAL_TEXT, APPROVAL_DISMISSED } from "./approval.js";
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
  assert.equal(readVerdict(PLAN_CHOICES[1]), "lightning");
  assert.equal(readVerdict(PLAN_CHOICES[2]), "sentinel");
  assert.equal(readVerdict(PLAN_CHOICES[3]), "sentinel");
  assert.equal(readVerdict(PLAN_CHOICES[4]), "reject");
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

test("the whole plan reaches the user as DETAIL, and the question stays one line", async () => {
  // The plan must still arrive in full — but not through the question. The prompt
  // renders in the footer, which has no height bound, so a 40-step plan there made the
  // frame taller than the terminal and tore the screen; the app looked hung because
  // the input box had been pushed off it. Detail prints into the scrollable transcript.
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. step ${i + 1}`).join("\n");
  let askedQuestion = "";
  let askedDetail: string | undefined;
  let wasAsked = false;
  const c = ctx(undefined, {
    requestApproval: async (question: string, _o: string[], detail?: string) => {
      wasAsked = true;
      askedQuestion = question;
      askedDetail = detail;
      return PLAN_CHOICES[0]!;
    },
  });
  await exitPlan.execute({ plan: long }, c);

  assert.ok(wasAsked, "approval must be requested");
  assert.equal(askedDetail, long, "the plan must travel in full, unsummarised");
  assert.equal(askedQuestion, PLAN_QUESTION);
  assert.ok(!askedQuestion.includes("step 1"), "the plan must NOT be in the question");
  assert.equal(askedQuestion.split("\n").length, 1, "the question must be a single line");
});

// ── refusal paths ────────────────────────────────────────────────────────────

test("a rejected plan leaves planning in force", async () => {
  const c = ctx(PLAN_CHOICES[4]);
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, true, "rejection must not lift plan mode");
  assert.match(r.output, /rejected/i);
});

test("sending the plan back for changes leaves planning in force", async () => {
  const c = ctx("Change something");
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, true);
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

test("approving into Lightning ENDS planning, it does not lift it for one turn", async () => {
  // Approval used to lift planning for a single turn and then force the session back
  // into it. Work that ran past one turn then came back with no editing tools and no
  // plan in context, needing a second approval for the same agreement.
  const c = ctx(PLAN_CHOICES[0]);
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, false, "work must be able to start");
  assert.equal(c.guarded, false);
  assert.match(r.output, /approved/i);
  assert.doesNotMatch(r.output, /resumes automatically/i, "planning no longer comes back by itself");
});

test("approving into Sentinel lifts planning but keeps each action gated", async () => {
  const c = ctx(PLAN_CHOICES[2], { guardAllowed: new Set(["edit"]) });
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planMode, false);
  assert.equal(c.guarded, true);
  // A stale "allow all" from earlier must not silently cover newly approved work.
  assert.equal(c.guardAllowed, undefined);
});

test("approval tells the UI its mode flags moved", async () => {
  let told = 0;
  const c = ctx(PLAN_CHOICES[0], { onModeChange: () => void told++ });
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(told, 1);
});

test("a refusal does not tell the UI anything moved", async () => {
  let told = 0;
  const c = ctx(PLAN_CHOICES[4], { onModeChange: () => void told++ });
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

  const c = ctx(PLAN_CHOICES[2]);
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(modeFromFlags(c), "sentinel", "approval into Sentinel must read as Sentinel");
});


// ── the fresh-context and feedback answers ───────────────────────────────────

test("every offered choice is readable, and fresh context is carried separately", () => {
  const seen = PLAN_CHOICES.map(readDecision);
  assert.deepEqual(
    seen.map((d) => [d.verdict, d.fresh]),
    [
      ["lightning", false],
      ["lightning", true],
      ["sentinel", false],
      ["sentinel", true],
      ["reject", false],
    ],
    "an offered option no longer maps to the decision it names",
  );
});

test("a typed answer is a revision request carrying its text", () => {
  const d = readDecision(`${APPROVAL_TEXT}use the existing queue instead of a new one`);
  assert.equal(d.verdict, "revise");
  assert.equal(d.feedback, "use the existing queue instead of a new one");
  assert.equal(d.fresh, false, "typing must never start work");
});

test("dismissing the prompt is still a refusal, never approval", () => {
  // The failure that matters here is acting when nobody said yes.
  assert.equal(readDecision(APPROVAL_DISMISSED).verdict, "reject");
  assert.equal(readDecision("").verdict, "reject");
  assert.equal(readDecision("yes go on then").verdict, "reject");
});

test("the user's words reach the model instead of a shrug", async () => {
  const c = ctx(`${APPROVAL_TEXT}split step 2 into two steps`);
  const r = await exitPlan.execute({ plan: PLAN }, c);
  assert.match(r.output, /split step 2 into two steps/, "the feedback never reached the model");
  assert.match(r.output, /do not start/i, "feedback must not read as approval");
  assert.equal(c.planMode, true, "planning stays in force until something is approved");
});

test("approving with a fresh context asks the engine for it and nothing more", async () => {
  const c = ctx(PLAN_CHOICES[1]);
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planFreshStart, PLAN, "the engine was never told to clear the conversation");
  assert.equal(c.planMode, false);
  assert.equal(c.guarded, false);
});

test("approving WITHOUT a fresh context leaves the conversation alone", async () => {
  const c = ctx(PLAN_CHOICES[0]);
  await exitPlan.execute({ plan: PLAN }, c);
  assert.equal(c.planFreshStart, undefined, "the conversation would have been cleared unasked");
});

test("the typed answer is offered to the user, not just accepted if guessed", async () => {
  // A free-text answer nothing advertises is an answer nobody gives.
  let offered: unknown;
  const c = ctx(PLAN_CHOICES[0]);
  c.requestApproval = async (_q, _o, _d, _t, freeText) => {
    offered = freeText;
    return PLAN_CHOICES[0];
  };
  await exitPlan.execute({ plan: PLAN }, c);
  assert.deepEqual(offered, PLAN_FEEDBACK);
});

test("the prompt still fits the box: at most six choices, one-line question", () => {
  // ApprovalBox renders MAX_CHOICES = 6 and clips beyond it, so a seventh option would
  // be invisible rather than merely crowded — and the typed row is one of the six.
  assert.ok(PLAN_CHOICES.length + 1 <= 6, `${PLAN_CHOICES.length + 1} rows will not fit`);
  assert.equal(PLAN_QUESTION.split(String.fromCharCode(10)).length, 1, "the question must stay one line");
});
