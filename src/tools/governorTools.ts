/**
 * governorTools.ts — the model's hands on the governor: make a rule, forbid a path.
 *
 * These let natural language work: "make it a rule to use pnpm" → remember_rule;
 * "never touch src/legacy" → forbid_path. Each persists the change to the
 * project's state dir (so it survives restarts and applies in every future
 * session here) AND mirrors it into the live `ctx.governance` so it takes effect
 * this turn — a new rule is injected next prompt, a new forbidden path is enforced
 * by edit/write/run immediately. Deciding WHAT to make a rule/forbid is the
 * user's call relayed by the model; these tools only record it.
 */
import type { Tool, ToolResult } from "./types.js";
import { isMcpToolName } from "../mcp/catalog.js";
import { writeRule, appendForbidden, appendForbiddenCommand, appendForbiddenMcpTool, deriveRuleName, slugify, writeSkill } from "../governor/write.js";
import { rescope } from "../governor/scope.js";
import { parseGlobs } from "../governor/rules.js";
import { failQuietly } from "./results.js";

/** The project root for state files: the fixed session root, carried on the
 *  governance config (cwd may have moved via `cd`; the root never does). */
function projectRoot(ctx: { cwd: string; governance?: { forbidden: { root: string } } }): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

// ── the four actions, as plain functions ──────────────────────────────────────
// They were four TOOLS until an audit measured what that cost: four near-identical
// schemas, one domain, one approval flow, ~1000 advertised tokens on every uncached
// request, and four overlapping descriptions for the model to choose between. The
// logic below is unchanged; only the way it is offered to the model is.

type Ctx = Parameters<Tool["execute"]>[1];

async function doRememberRule(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const body = typeof args.value === "string" ? args.value.trim() : "";
  if (!body) return failQuietly("`value` is required — the rule text.");
  const name = (typeof args.name === "string" && args.name.trim()) || deriveRuleName(body);
  const globs = parseGlobs(typeof args.globs === "string" ? args.globs : undefined);

  const saved = await writeRule(projectRoot(ctx), name, body, "", globs);
  // Mirror into the live session so the rule is in the very next prompt.
  //
  // Deduplicate by SLUG, not by the display name. The rule FILE is `<slug>.md`, so
  // "Use pnpm" and "use pnpm!" are one rule on disk and were two in memory: the
  // session showed both, the next session showed one, and the user watched a rule
  // they had just set disappear on restart. Matching how the file is keyed is what
  // keeps the live list and the disk agreeing.
  if (ctx.governance) {
    const slug = slugify(saved.name);
    ctx.governance.rules = [...ctx.governance.rules.filter((r) => slugify(r.name) !== slug), saved];
    // A brand-new scoped rule never saw the paths this session already worked in, and
    // scoping is decided at touch time — so without this it would sit inert until the
    // model happened to touch a matching file again.
    if (ctx.ruleScope) rescope(ctx.ruleScope, ctx.governance.rules);
  }
  const scope = globs.length > 0 ? ` (scoped to ${globs.join(", ")})` : "";
  return {
    output: `Saved rule '${saved.name}'${scope}. It now applies to this project (this session and future ones).`,
    summary: `saved rule '${saved.name}'`,
  };
}

async function doForbidPath(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the path glob to forbid.");

  const result = await appendForbidden(projectRoot(ctx), pattern);
  if (!result.pattern) return failQuietly("the pattern is empty after normalization.");

  // Mirror into the live forbidden config (new array → matcher recompiles).
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      patterns: [...ctx.governance.forbidden.patterns, result.pattern],
    };
  }
  return {
    output: result.added
      ? `Forbidden '${result.pattern}'. I won't modify it or run commands against it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

async function doForbidCommand(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the command to forbid.");

  const result = await appendForbiddenCommand(projectRoot(ctx), pattern);
  if (!result.pattern) return failQuietly("the pattern is empty after normalization.");

  // Mirror into the live forbidden config (new array → enforced this turn on).
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      commands: [...(ctx.governance.forbidden.commands ?? []), result.pattern],
    };
  }
  return {
    output: result.added
      ? `Forbidden the command '${result.pattern}'. I won't run it (or anything containing it) unless you lift it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade command '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

async function doForbidMcpTool(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const name = typeof args.value === "string" ? args.value.trim() : "";
  if (!name) return failQuietly("`value` is required — the full MCP tool name.");
  // Guarding the shape matters: a bare tool name would be written to disk, never
  // match anything, and look like the ban silently failed.
  if (!isMcpToolName(name)) {
    return failQuietly(`'${name}' is not an MCP tool name. Use the full name from your tool list, e.g. 'mcp__github__create_issue'.`);
  }

  const result = await appendForbiddenMcpTool(projectRoot(ctx), name);
  if (!result.pattern) return failQuietly("the name is empty after normalization.");

  // Mirror into the live config AND the live pool, so the ban takes effect on the
  // next step rather than the next session.
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      mcpTools: [...(ctx.governance.forbidden.mcpTools ?? []), result.pattern],
    };
    ctx.mcp?.setForbidden(ctx.governance.forbidden.mcpTools ?? []);
  }
  return {
    output: result.added
      ? `Forbidden the MCP tool '${result.pattern}'. It's no longer available to me unless you lift it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

const ACTIONS = {
  remember_rule: doRememberRule,
  forbid_path: doForbidPath,
  forbid_command: doForbidCommand,
  forbid_mcp_tool: doForbidMcpTool,
} as const;

export type GovernorAction = keyof typeof ACTIONS;

export const governor: Tool = {
  name: "governor",
  deferred: true,
  readOnly: false,
  // Each action keeps the ONE warning that changes what the model does, and loses the
  // rest. The dropped prose explained things the tool already reports in its own reply
  // (that a duplicate is harmless, that a refusal can be lifted), which is a worse
  // place to learn it than the reply itself and was being paid for every turn.
  description:
    "Record a standing decision for THIS project. Persists across sessions and takes " +
    "effect immediately. Pass `action` and `value`:\n" +
    "- remember_rule — a durable directive to follow here ('Use pnpm, never npm'). " +
    "Injected into your context EVERY turn from now on, so prefer few sharp rules; " +
    "pass `globs` to scope one to matching files instead. Write it as a standing " +
    "instruction, not a note about now. Reusing a `name` replaces that rule.\n" +
    "- forbid_path — a file/folder/glob that must never be MODIFIED ('src/legacy/**'). " +
    "It can still be read and searched; this protects against changes, not against " +
    "looking.\n" +
    "- forbid_command — a command that must never be RUN ('git push --force'). Matched " +
    "as a case-insensitive substring, so a short pattern catches far more than it " +
    "looks like: forbid the specific command the user meant, not a word from it.\n" +
    "- forbid_mcp_tool — one MCP tool, by its FULL 'mcp__server__tool' name; a bare " +
    "name is rejected rather than silently matching nothing.\n" +
    "Use it when the user states a durable preference or says not to touch/run " +
    "something — not for a one-off instruction about the task in hand.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action", "value"],
    properties: {
      action: {
        type: "string",
        enum: ["remember_rule", "forbid_path", "forbid_command", "forbid_mcp_tool"],
        description: "What to record.",
      },
      value: {
        type: "string",
        description:
          "The rule text, path glob, command fragment, or full MCP tool name — whichever the action takes.",
      },
      name: {
        type: "string",
        description: "remember_rule only: short name for the rule; derived from the text if omitted.",
      },
      globs: {
        type: "string",
        description:
          "remember_rule only: comma-separated path globs that scope the rule to matching files " +
          "(e.g. 'src/api/**'). Omit for an always-on rule.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    const handler = ACTIONS[action as GovernorAction];
    // Naming the valid set beats a bare "invalid action": the model corrects in one
    // step instead of guessing at the spelling.
    if (!handler) {
      return failQuietly(`\`action\` must be one of: ${Object.keys(ACTIONS).join(", ")}.`);
    }
    return handler(args, ctx);
  },
};

export const createSkill: Tool = {
  name: "create_skill",
  deferred: true,
  readOnly: false,
  // Two things the model could not have known: the name is normalised (so the
  // invocation it announces may not be the name it passed), and creating over an
  // existing name destroys that skill.
  description:
    "Create a reusable skill for THIS project: a named, step-by-step procedure that " +
    "you or the user (via /name) can run later. Use it when the user says to save a " +
    "skill, or to capture a multi-step workflow clearly worth repeating. It persists " +
    "across sessions.\n" +
    "Unlike a rule, a skill is CHEAP to keep: only its name and description sit in " +
    "your context, and the steps are loaded only when it runs. So prefer a skill for " +
    "anything procedural, and a rule only for something that must colour every turn.\n" +
    "The name is normalised to lowercase-with-dashes, so 'Release Process' becomes " +
    "/release-process — the result tells you the real invocation. Creating one under a " +
    "name that normalises to an existing skill REPLACES it, with no warning, so check " +
    "available_skills first if you are unsure. Write `steps` as a clear markdown " +
    "checklist for someone starting cold, and use $ARGUMENTS or $1…$9 where the " +
    "procedure needs input.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "steps"],
    properties: {
      name: {
        type: "string",
        description: "Short invocation name, e.g. 'release' (becomes /release).",
      },
      description: {
        type: "string",
        description: "One line on what the skill does — shown in the catalog and used to pick it.",
      },
      steps: {
        type: "string",
        description:
          "The skill body: the procedure as markdown. May use $ARGUMENTS or $1/$2 placeholders " +
          "for arguments passed at invocation.",
      },
      when_to_use: {
        type: "string",
        description: "Optional: when you should reach for this skill.",
      },
      argument_hint: {
        type: "string",
        description: "Optional usage hint for arguments, e.g. '<env>' for /release <env>.",
      },
      globs: {
        type: "string",
        description:
          "Optional comma-separated globs that scope the skill's catalog visibility to matching " +
          "files (it stays invokable by name regardless).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const body = typeof args.steps === "string" ? args.steps.trim() : "";
    if (!name) return failQuietly("`name` is required.");
    if (!body) return failQuietly("`steps` is required — the skill needs a body.");

    const saved = await writeSkill(projectRoot(ctx), {
      name,
      description,
      body,
      whenToUse: typeof args.when_to_use === "string" ? args.when_to_use.trim() : "",
      argumentHint: typeof args.argument_hint === "string" ? args.argument_hint.trim() : "",
      globs: parseGlobs(typeof args.globs === "string" ? args.globs : undefined),
    });
    // Mirror into the live catalog so it can be used immediately.
    if (ctx.governance) {
      ctx.governance.skills = [
        ...ctx.governance.skills.filter((s) => s.name !== saved.name),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      output: `Created skill '${saved.name}'. Run it with /${saved.name} or call use_skill.`,
      summary: `created skill '${saved.name}'`,
    };
  },
};

