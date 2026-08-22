/**
 * useSkill.ts — run one of the project's skills by name.
 *
 * This is the model-driven half of skill invocation (the user-driven half is
 * typing `/name`). Only the skill catalog (name + description + when-to-use) sits
 * in the prompt; when the model decides a skill fits, it calls this tool, which
 * reads the full SKILL.md body from disk and returns it as the result — so the
 * steps enter context only on demand (progressive disclosure). Read-only: it puts
 * instructions in front of the model but changes nothing on disk.
 */
import type { Tool, ToolResult } from "./types.js";
import { findSkill, loadSkillBody, substituteSkillArgs } from "../governor/skills.js";
import { fail, failQuietly } from "./results.js";

export const useSkill: Tool = {
  name: "use_skill",
  readOnly: true,
  // Offered only where there is something to run. A project with no skills is the
  // common case, and in it this tool is not merely unused — it is uncallable, so its
  // schema was pure cost and any call it attracted could only fail.
  relevantWhen: (ctx) => (ctx.governance?.skills.length ?? 0) > 0,
  // available_skills is a FILTERED view: a skill scoped with `globs` only appears when
  // the working set matches, yet stays runnable by name. Describing the catalog as the
  // set of runnable skills therefore understated what is reachable, and the one place
  // the full list surfaces is the error you get for a name that does not exist.
  description:
    "Run one of this project's skills by name and get its full step-by-step " +
    "instructions back, to follow as written. Call this when a skill fits the task at " +
    "hand — the steps are not in your context until you do, which is the point.\n" +
    "available_skills lists the skills on offer right now, but it is filtered to what " +
    "suits the files in play, so a project can hold skills it is not currently showing " +
    "you. If you believe a skill exists, name it: an unknown name comes back with the " +
    "complete list, which costs one call and beats assuming it is absent. Names match " +
    "regardless of case and a leading slash is ignored.\n" +
    "Pass `arguments` when the skill takes them — they fill its $ARGUMENTS and $1…$9 " +
    "placeholders, and a skill with no placeholders receives them as extra context " +
    "instead, so nothing you pass is silently dropped.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "The skill's name, exactly as shown in available_skills.",
      },
      arguments: {
        type: "string",
        description:
          "Optional arguments for the skill — substituted into its $ARGUMENTS / $1 placeholders, " +
          "or added as context if it has none.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return failQuietly("`name` is required.");
    const argString = typeof args.arguments === "string" ? args.arguments : "";

    const skills = ctx.governance?.skills ?? [];
    const skill = findSkill(skills, name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(none configured)";
      return fail(`no skill named '${name}'. Available skills: ${available}.`);
    }

    const body = await loadSkillBody(skill);
    if (!body) {
      return fail(`skill '${skill.name}' has no readable SKILL.md.`);
    }

    return {
      output: `Skill "${skill.name}" — follow these steps:\n\n${substituteSkillArgs(body, argString)}`,
      summary: `loaded skill ${skill.name}`,
    };
  },
};

