/**
 * subagentReport.ts — checking a sub-agent's report before believing it.
 *
 * A child returned a plain string and the parent folded it into state as an answer.
 * There was no contract: `output_format` was a suggestion in the task text, so a child
 * that ran out of budget halfway, or misunderstood the task, or found nothing and said
 * something agreeable, produced output indistinguishable from a child that succeeded.
 * The parent then reasoned confidently on top of it.
 *
 * That is the documented dominant failure mode of multi-agent systems rather than a
 * hypothetical: the MAST taxonomy (Cemri et al., 1,600+ traces across 7 frameworks)
 * puts 21.3% of failures in task verification, and a separate 2026 study found ~75% of
 * multi-agent failures are "silent gray errors" — plausible-looking and wrong. Plausible
 * is exactly what an unverified string is optimised to be.
 *
 * ── WHY THIS IS MOSTLY MECHANICAL ───────────────────────────────────────────────
 *
 * The obvious fix is to make the child declare its own outcome, and this does ask for
 * that. But a self-declared status is worth only as much as the child's self-awareness,
 * and a child that misunderstood its task is precisely the one that will report success.
 * So the signals that carry weight here are the ones the HARNESS can see without
 * trusting the child at all:
 *
 *   - it stopped at its step budget (it did not finish, whatever it says),
 *   - it came back with almost nothing,
 *   - it never stated an outcome despite being told to.
 *
 * Those are facts about the run. The declared status is folded in as a fourth, weaker
 * signal. Nothing here BLOCKS a report: the parent is the one that can judge whether a
 * partial answer is still useful, and hiding it would trade a silent error for a silent
 * omission. The contract is that the parent is told, in the same breath as the report,
 * what it should not assume about it.
 */

/** What the child says happened, as far as it is willing to commit. */
export type SubagentStatus = "complete" | "partial" | "failed" | "unstated";

export interface SubagentVerdict {
  status: SubagentStatus;
  /** The report with its status line removed — what the parent should actually read. */
  body: string;
  /** Things the parent must not assume away. Empty when the run looks clean. */
  concerns: string[];
  /** True when the parent should treat this as an answer rather than a lead. */
  trustworthy: boolean;
}

/** The line the child is asked to end on, and the instruction that asks for it. */
export const STATUS_INSTRUCTION =
  "End your reply with a final line of exactly `STATUS: complete`, `STATUS: partial`, or " +
  "`STATUS: failed` — complete only if you fully did what was asked, partial if you ran " +
  "out of room or could only do some of it, failed if you could not. Be honest: a partial " +
  "answer labelled correctly is useful, and one labelled complete is worse than nothing.";

/** A reply shorter than this almost certainly is not a report. */
const MIN_USEFUL_CHARS = 20;

/**
 * Match the status line through the decoration a model puts around it.
 *
 * Both ends are tolerant on purpose. Asked for a line, models routinely emit
 * `**STATUS: complete**`, `> STATUS: complete`, or `- STATUS: complete.` — and a
 * status that fails to parse reads as "never stated an outcome", which would flag
 * every well-behaved child as unverified and train the parent to ignore the flag.
 * Leniency here costs nothing: the words themselves are still required.
 */
const STATUS_LINE = /^[ \t>*_#-]*STATUS[:\s]+\s*(complete|partial|failed)[ \t*_.!]*$/im;

/**
 * Read the child's declared status and strip the line that declared it.
 *
 * The line is removed because it is protocol, not content: leaving it in means every
 * nested report carries a stray marker into the parent's context, and a parent that
 * echoes reports upward would stack them.
 */
export function parseStatus(reply: string): { status: SubagentStatus; body: string } {
  const match = reply.match(STATUS_LINE);
  if (!match) return { status: "unstated", body: reply.trim() };
  const status = match[1]!.toLowerCase() as Exclude<SubagentStatus, "unstated">;
  return { status, body: reply.replace(STATUS_LINE, "").trimEnd() };
}

/**
 * Judge a finished sub-agent run (pure).
 *
 * `steps` and `budget` are the mechanical half and the reason this is not just prompt
 * text: a child that used every step it had did not choose to stop, so its report is
 * a snapshot of unfinished work no matter how confident it reads.
 */
export function verifySubagentReport(
  reply: string,
  run: { steps: number; budget: number; outputFormat?: string },
): SubagentVerdict {
  const { status, body } = parseStatus(reply);
  const concerns: string[] = [];

  // MECHANICAL: it ran out of room. This outranks anything the child says about itself.
  const exhausted = run.steps >= run.budget;
  if (exhausted) {
    concerns.push(
      `it used its entire ${run.budget}-step budget, so it stopped rather than finished — ` +
        `treat this as partial work and re-run with a larger max_steps if you need the rest`,
    );
  }

  // MECHANICAL: there is barely anything here.
  if (body.trim().length < MIN_USEFUL_CHARS) {
    concerns.push("it came back with almost no content, so there may be nothing usable in it");
  }

  // DECLARED: weaker, but the child is the only one who knows some of this.
  if (status === "failed") {
    concerns.push("it reported that it could NOT do the task — do not treat the text below as a result");
  } else if (status === "partial") {
    concerns.push("it reported doing only part of the task");
  } else if (status === "unstated" && !exhausted) {
    concerns.push(
      "it did not state whether it finished, so whether this is a complete answer is unverified",
    );
  }

  // A clean run is: it stopped on its own, said it finished, and said something.
  const trustworthy = concerns.length === 0 && status === "complete";
  return { status, body, concerns, trustworthy };
}

/**
 * Render the verdict for the parent.
 *
 * The concerns go ABOVE the report rather than below it. A caveat after several hundred
 * lines of findings is one the parent reads after it has already formed a conclusion,
 * which is the same as not printing it.
 */
export function renderVerdict(verdict: SubagentVerdict): string {
  if (verdict.concerns.length === 0) return verdict.body;
  const header =
    verdict.concerns.length === 1
      ? `Before using this report: ${verdict.concerns[0]}.`
      : `Before using this report:\n${verdict.concerns.map((c) => `- ${c}`).join("\n")}`;
  return `${header}\n\n---\n\n${verdict.body}`;
}
