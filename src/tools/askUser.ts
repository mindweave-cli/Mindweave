/**
 * askUser.ts — a structured question to the user.
 *
 * Underspecification is one of the top real-world failure modes for coding agents:
 * faced with an ambiguous request, a model guesses and builds the wrong thing.
 * This gives the model an explicit escape hatch — ask a focused question with a
 * few concrete options — instead of guessing. It reuses the same client approval
 * channel the forbidden-lift flow uses (`ctx.requestApproval`), which renders the
 * question + options and returns the chosen one.
 *
 * Model-work boundary: WHETHER to ask is the model's judgment (guided by the
 * prompt: ask when genuinely blocked, don't overuse it). This tool only carries
 * the question to the human and the answer back.
 */
import type { Tool, ToolResult } from "./types.js";
import { APPROVAL_DISMISSED } from "./approval.js";

const askUserDef: Tool = {
  name: "ask_user",
  readOnly: true,
  // The old text promised "the user's choice is returned to you" with no account of the
  // two ways that does not happen — dismissal, and no channel at all. Both now return a
  // plain instruction to carry on, so the model must know they are possible or it will
  // read either one as a choice.
  description:
    "Ask the user a focused question when the task is genuinely ambiguous and you " +
    "cannot proceed well without their input: which of two real approaches they want, " +
    "a missing requirement, an unclear denial. Give 2-4 concrete options — only the " +
    "first 4 are shown — and their choice comes back to you.\n" +
    "Use it sparingly. Anything you can settle with a sensible default, or find out by " +
    "reading the project, is not a question; asking about it spends the user's " +
    "attention on work they delegated. Prefer acting when the answer is obvious, and " +
    "prefer one question that decides the direction over several small ones.\n" +
    "You may not get an answer: the user can dismiss the question, and some sessions " +
    "have no way to ask at all. Both come back saying so, and neither is a choice — do " +
    "not treat an option as picked. Carry on with the most reasonable default, say " +
    "which one you assumed, and do any part of the work that does not depend on it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["question", "options"],
    properties: {
      question: {
        type: "string",
        description: "The specific question to ask. Clear and self-contained.",
      },
      options: {
        type: "array",
        description: "2-4 concrete answer options for the user to choose from.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
      : [];
    if (!question) return fail("`question` is required.");
    if (options.length < 2) return fail("provide at least 2 concrete `options`.");

    // No approval channel (headless run / tests): can't ask — tell the model to
    // proceed on its best judgment rather than stall.
    if (!ctx.requestApproval) {
      return {
        output:
          "Can't ask the user right now (no interactive channel). Proceed with your best " +
          "judgment using a sensible default, and note the assumption in your reply.",
        summary: "ask_user unavailable — proceed with a default",
      };
    }

    const choice = await ctx.requestApproval(question, options.slice(0, 4));
    // Dismissing the question is not an answer, and must never be reported as one.
    // It used to resolve as the second option, so "Postgres or SQLite?" dismissed came
    // back as "The user chose: SQLite" — a decision attributed to someone who declined
    // to make it, which is worse than not having asked.
    if (choice === APPROVAL_DISMISSED) {
      return {
        output:
          "The user dismissed the question without answering, so you do not have their " +
          "preference. Do not treat any option as chosen. Proceed with the most " +
          "reasonable default and say which one you assumed, or continue with the part " +
          "of the work that does not depend on the answer.",
        summary: `asked: ${clip(question)} → dismissed`,
      };
    }
    return {
      output: `The user chose: ${choice}`,
      summary: `asked: ${clip(question)} → ${clip(choice)}`,
    };
  },
};

/**
 * Never renders a row.
 *
 * The user has just been shown the question in the approval box and answered it — a
 * row afterwards restating "asked: which database? → SQLite" tells them something they
 * did a second ago. The model still gets the full result, which is the half that
 * matters: it needs the answer, the user does not need the receipt.
 *
 * Wrapped at the export rather than flagged at each `return`, so a new return site
 * cannot start rendering again by omission — the same shape `navigational()` uses for
 * the code-intel lookups.
 */
export const askUserTool: Tool = {
  ...askUserDef,
  async execute(args, ctx) {
    return { ...(await askUserDef.execute(args, ctx)), quiet: true };
  },
};

function clip(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}
