/**
 * planArtifact.ts — an approved plan is a commitment, so it lives on disk.
 *
 * Before this, an approved plan existed only in the transcript. Two things were
 * wrong with that. First, compaction: the plan sat in exactly the region of the
 * conversation that summarization rewrites, so the longer the approved work ran —
 * the case where fidelity to the plan matters MOST — the more mangled the record
 * of what was agreed became. Second, divergence: nothing distinguished "the plan"
 * from any other prose the model once wrote, so when reality disagreed with it,
 * improvising past it and following it looked identical.
 *
 * The fix follows BOUNDARY.md's own taxonomy: an approved plan is STANDING
 * KNOWLEDGE — a small, load-bearing fact injected whole every request — not a
 * transcript record. On approval the plan is written to `.mindweave/plan.md`
 * (user-visible, user-editable, survives the process), and the engine renders it
 * into the volatile tail each request the way rules and the task list already
 * are. Compaction cannot touch it because it is not in the transcript at all:
 * durability by construction, not by re-injection bookkeeping.
 *
 * Divergence gets a CONTRACT, in two layers:
 *   - The rendered block binds the model: work must follow the plan, and if
 *     reality makes a step impossible or wrong, the model must STOP and say so —
 *     the turn ends, and the agreement ends with it — the user decides whether to
 *     plan again — and unagreed work never silently replaces the agreed plan.
 *     Improvising past the agreed plan is named as the specific failure to avoid.
 *   - Mechanically: when the repeat-failure breaker trips DURING an approved
 *     plan's execution, the engine's interrupt names the plan and orders the stop
 *     — the one signal we can detect without a model call ("the plan's step is
 *     not working") escalates to "stop and replan", never "keep improvising".
 *
 * The file format is markdown with a small comment header, so the user can read
 * it, edit it, or delete it (deleting deactivates it — the user always wins).
 */
import { promises as fs } from "node:fs";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { dirname, join } from "node:path";

export const PLAN_DIR = ".mindweave";
export const PLAN_FILE = "plan.md";

export interface PlanArtifact {
  /** The approved plan, exactly as it passed approval. */
  plan: string;
  /** ISO timestamp of approval. */
  approvedAt: string;
  /** Which approval granted it: lightning (auto-accept) or sentinel (ask each). */
  mode: "lightning" | "sentinel";
}

function planPath(root: string): string {
  return join(root, PLAN_DIR, PLAN_FILE);
}

/** Write the artifact on approval. Overwrites any previous plan — a newly
 *  approved plan IS the current agreement; there is only ever one. */
export async function savePlanArtifact(root: string, plan: string, mode: PlanArtifact["mode"]): Promise<void> {
  const approvedAt = new Date().toISOString();
  const body = [
    `<!-- mindweave:plan status=active approved=${approvedAt} mode=${mode} -->`,
    "",
    "# Approved plan",
    "",
    plan.trim(),
    "",
  ].join("\n");
  const path = planPath(root);
  await fs.mkdir(dirname(path), { recursive: true });
  // Atomic: an approved plan is a decision the user made once, and the engine
  // refuses to improvise around a plan it cannot read.
  await writeFileAtomic(path, body);
}

/** Load the current artifact. Null when there is none, the file was deleted, or
 *  its status is no longer active — absence deactivates, so the user's `rm` (or
 *  edit of the status word) is a complete off switch with no other UI needed. */
export async function loadPlanArtifact(root: string): Promise<PlanArtifact | null> {
  let text: string;
  try {
    text = await fs.readFile(planPath(root), "utf8");
  } catch {
    return null;
  }
  const header = text.match(/<!--\s*mindweave:plan\s+status=(\S+)\s+approved=(\S+)\s+mode=(\S+)\s*-->/);
  if (!header || header[1] !== "active") return null;
  const mode = header[3] === "sentinel" ? "sentinel" : "lightning";
  // The body is everything after the generated heading; tolerate user edits by
  // falling back to everything after the header line.
  const afterHeading = text.split(/^# Approved plan\s*$/m)[1];
  const plan = (afterHeading ?? text.slice(header.index! + header[0].length)).trim();
  if (!plan) return null;
  return { plan, approvedAt: header[2], mode };
}

/** Flip the artifact to done in place. Kept, not deleted: the last agreed plan
 *  is useful history, and status is what injection keys on. */
export async function completePlanArtifact(root: string): Promise<void> {
  const path = planPath(root);
  try {
    const text = await fs.readFile(path, "utf8");
    await writeFileAtomic(path, text.replace("status=active", "status=done"));
  } catch {
    // No artifact is already the desired end state.
  }
}

/**
 * The standing-knowledge block the engine injects while a plan is active.
 * Binding language, same register as the rules block — this is an agreement the
 * user personally approved, which outranks the model's own judgment about scope.
 */
export function renderPlanBlock(artifact: PlanArtifact): string {
  return (
    "The user APPROVED this plan (" +
    artifact.approvedAt +
    "). It is the agreed scope of the current work — follow it in order, and do not " +
    "silently do something else. If a step turns out to be impossible, wrong, or " +
    "overtaken by what you find, do NOT improvise past it: STOP, state plainly which " +
    "step diverged and why, and end your turn. The agreement ends there, and the user " +
    "decides what happens next. Divergence is normal; unagreed work is not. " +
    "When every step is genuinely complete, say so in your final reply.\n" +
    "<approved_plan>\n" +
    artifact.plan.trim() +
    "\n</approved_plan>"
  );
}

/**
 * The interrupt used when the repeat-failure breaker trips while an approved plan
 * is active: the mechanical divergence signal. Same shape as the ordinary breaker
 * text but names the contract — stop and replan, do not push sideways.
 */
export function planDivergenceStop(failedLabel: string): string {
  return (
    `You are executing a plan the user approved, and \`${failedLabel}\` has now failed ` +
    "repeatedly — the plan's current step is not working as agreed. Do not keep " +
    "retrying it, and do not improvise around it: that would replace the agreed plan " +
    "with unagreed work. Stop here, state which step diverged and what you found, and " +
    "end your turn so the user can decide whether to replan."
  );
}
