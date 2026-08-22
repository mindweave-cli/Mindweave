/**
 * exitPlan.ts — hand a finished plan to the user, and start work if they approve.
 *
 * Planning without this is only half a feature. The agent would work out what to do,
 * present it, and then stop and wait to be told to do the thing it had just described
 * — so approving cost three actions (read it, change mode, say "go") when approving
 * already means "start". Worse, after the mode switch the plan had to be recovered
 * from scrollback, so what got built drifted from what was agreed.
 *
 * Two things make this a TOOL rather than the client noticing the model went quiet:
 *
 *  1. **The plan gets shown whole.** Prose written between tool calls is narration,
 *     and the display cuts it to two sentences (one per turn) on purpose. A plan is
 *     the opposite of narration: it is the thing being read. Arriving as tool data
 *     puts it in a channel that trimming never touches.
 *  2. **The model says when it is done.** Pausing to think mid-research is not a
 *     finished plan, and no heuristic over an idle turn can tell those apart.
 *
 * Approval buys ONE turn of doing. The session returns to planning when the work
 * ends, because the mode was left by a tool call, not by the user.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { savePlanArtifact } from "../dynamo/planArtifact.js";
import { fail, failQuietly } from "./results.js";

/** What the user chose at the approval prompt. Order is the display order. */
export const PLAN_CHOICES = [
  "Approve — Lightning (auto-accept)",
  "Approve — Sentinel (ask each action)",
  "Reject",
  "Change something",
] as const;

/** The decision, separated from its wording so the engine never matches on prose. */
export type PlanVerdict = "lightning" | "sentinel" | "reject" | "revise";

/**
 * Read a verdict out of the chosen option (pure).
 *
 * Matched by POSITION-INDEPENDENT content rather than exact string equality: the
 * approval channel can hand back a trimmed or re-cased answer, and an unrecognised
 * reply must never be read as approval. Anything unknown is a refusal, because the
 * failure that matters here is acting when nobody said yes.
 */
export function readVerdict(choice: string): PlanVerdict {
  const c = choice.trim().toLowerCase();
  if (c.startsWith("approve")) {
    return c.includes("sentinel") ? "sentinel" : "lightning";
  }
  if (c.startsWith("change")) return "revise";
  return "reject";
}

export const exitPlan: Tool = {
  name: "exit_plan",
  // It writes nothing, but it is not offered outside planning: there is nothing to
  // exit from in an ordinary turn.
  readOnly: true,
  planOnly: true,
  description:
    "Present your finished plan to the user and ask them to approve it. Call this when " +
    "you have researched enough to say exactly what you would change and why — it is how " +
    "planning ends. " +
    "Put the WHOLE plan in `plan`: the user reads it here and nowhere else, so it must " +
    "stand on its own, in the order you would carry it out, naming the files you would " +
    "touch. Do not summarise it in your reply as well. " +
    "If the user approves, you begin immediately in the same turn, so write the plan as " +
    "the instruction you are about to follow. If they decline, stop and wait.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "string",
        description:
          "The complete plan, in markdown. Steps in the order you would do them, the " +
          "files each one touches, and anything you would need the user to decide.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const plan = typeof args.plan === "string" ? args.plan.trim() : "";
    if (!plan) return failQuietly("`plan` is required — put the whole plan in it.");

    if (!ctx.requestApproval) {
      return fail(
        "Cannot ask for approval from here, so the plan cannot be started. Present the " +
          "plan in your reply instead and let the user decide.",
      );
    }

    // The plan travels as DETAIL, not as the question. It is the longest thing any
    // tool asks about, and putting it in the prompt made the frame taller than the
    // terminal — the screen tore and the app looked hung with no way to answer. As
    // detail it prints into the transcript, which scrolls, and the prompt stays one
    // line. Nothing is summarised: the user still reads the whole plan.
    const choice = await ctx.requestApproval(PLAN_QUESTION, [...PLAN_CHOICES], plan);
    const verdict = readVerdict(choice);

    if (verdict === "reject") {
      return {
        output:
          "The user rejected the plan. Stop here and do not start any of it. Do not " +
          "propose a new plan until they say what they want changed.",
        summary: "plan rejected",
      };
    }
    if (verdict === "revise") {
      return {
        output:
          "The user wants the plan changed but has not said how yet. Stop and wait for " +
          "them to tell you. Do not guess at a revision or start any part of the plan.",
        summary: "plan sent back",
      };
    }

    // Approved. The plan is now the agreed scope of the work, so it becomes a
    // durable artifact: written to .mindweave/plan.md (user-visible, user-editable,
    // survives compaction BY CONSTRUCTION because the engine re-renders it from
    // here every request instead of trusting the transcript) and carried on the
    // context for this session. A failure to write must not un-approve the plan —
    // the in-memory copy still governs this session; only persistence is lost.
    ctx.activePlan = plan;
    ctx.activePlanApprovedAt = new Date().toISOString();
    try {
      await savePlanArtifact(ctx.roots?.[0] ?? ctx.cwd, plan, verdict === "sentinel" ? "sentinel" : "lightning");
    } catch {
      // Read-only filesystem or similar: session-local plan still applies.
    }
    // Leave planning for the rest of this turn only — `planResume` is the
    // engine's instruction to put it back when the work ends.
    ctx.planMode = false;
    ctx.guarded = verdict === "sentinel";
    // A fresh Sentinel pass starts vigilant: an "allow all" from some earlier point in
    // the session must not silently cover work the user has only just agreed to.
    if (ctx.guarded) ctx.guardAllowAll = false;
    ctx.planResume = true;
    ctx.onModeChange?.();

    return {
      output:
        `The user approved the plan${verdict === "sentinel" ? " and asked to confirm each action" : ""}. ` +
        `Start now, in this turn, and follow the plan you just presented. ` +
        (verdict === "sentinel"
          ? "Each change is confirmed with them before it happens, so work in small clear steps. "
          : "") +
        `Do not restate the plan — they have read it. Planning resumes automatically once you finish.`,
      summary: verdict === "sentinel" ? "plan approved (Sentinel)" : "plan approved (Lightning)",
    };
  },
};

/** The prompt itself — one line, because it renders in the height-bounded footer.
 *  The plan is passed alongside it as detail and printed into the transcript. */
export const PLAN_QUESTION = "Start on this?";

