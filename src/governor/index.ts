/**
 * governor — the per-project control layer (rules · skills · forbidden).
 *
 * Like an engine's governor regulates how it may run, this regulates how Mindweave
 * works inside a project: the standing rules it must follow, the skills it can
 * run, and the paths/actions it must never touch. Everything is scoped to one
 * project and stored under that project's state dir (`~/.mindweave/projects/<proj>/`),
 * the same place sessions live — so a rule set in project A never leaks into B.
 * (Global rules/skills are a planned second layer; the per-project design leaves
 * a clean seam for merging one on top.)
 *
 * `loadGovernance` reads it all once at session start (cheap: a couple of small
 * directory reads). The forbidden config rides on the tool context for
 * mechanical enforcement; the rules and skill catalog are rendered into the
 * system prompt by the engine.
 */
import { projectDir } from "../memory/store.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadRules } from "./rules.js";
import { loadSkillCatalog } from "./skills.js";
import { parseForbidden, parseForbiddenCommands, parseForbiddenMcpTools } from "./forbidden.js";
import type { Governance } from "./types.js";

/** Read a project state file (forbidden.md / forbidden-commands.md), "" if absent. */
async function readStateFile(stateDir: string, name: string): Promise<string> {
  try {
    return await fs.readFile(join(stateDir, name), "utf8");
  } catch {
    return "";
  }
}

/** Load all governance for the project rooted at `cwd`. Always succeeds (empties). */
export async function loadGovernance(cwd: string): Promise<Governance> {
  const stateDir = projectDir(cwd);
  const [rules, skills, forbiddenText, forbiddenCmdText, forbiddenMcpText] = await Promise.all([
    loadRules(stateDir),
    loadSkillCatalog(stateDir),
    readStateFile(stateDir, "forbidden.md"),
    readStateFile(stateDir, "forbidden-commands.md"),
    readStateFile(stateDir, "forbidden-mcp-tools.md"),
  ]);
  return {
    rules,
    skills,
    forbidden: {
      patterns: parseForbidden(forbiddenText),
      commands: parseForbiddenCommands(forbiddenCmdText),
      mcpTools: parseForbiddenMcpTools(forbiddenMcpText),
      root: cwd,
    },
  };
}

export { renderRules } from "./rules.js";
export { renderSkillCatalog } from "./skills.js";
export type { Governance, Rule, SkillMeta, ForbiddenConfig } from "./types.js";

/**
 * Re-read governance from disk, keeping everything that exists only in this session.
 *
 * Three things do NOT come from disk and must survive a reload:
 *   - `lifted` — patterns the user allowed for this session only (approval.ts). The
 *     on-disk rule is intentionally left in place, so a plain reload would restore it
 *     and re-block a path the user had just permitted.
 *   - `notices` — one-shot lines the UI has not drained yet. Dropping them loses the
 *     message rather than delaying it.
 *   - the fired rule-scope, which is not on `Governance` at all: it lives on the tool
 *     context and is re-judged against the new rule list by the caller.
 *
 * Returns a NEW object rather than mutating: the forbidden matcher caches compiled
 * patterns in a WeakMap keyed on array identity, so fresh arrays are what make it
 * recompile instead of enforcing the old list.
 */
export async function reloadGovernance(cwd: string, previous: Governance): Promise<Governance> {
  const fresh = await loadGovernance(cwd);
  const lifted = previous.lifted ?? [];
  return {
    ...fresh,
    forbidden: {
      ...fresh.forbidden,
      patterns: fresh.forbidden.patterns.filter((p) => !lifted.includes(p)),
      commands: (fresh.forbidden.commands ?? []).filter((c) => !lifted.includes(c)),
    },
    ...(lifted.length > 0 ? { lifted } : {}),
    ...(previous.notices && previous.notices.length > 0 ? { notices: previous.notices } : {}),
  };
}

export { governanceStamp } from "./freshness.js";
export { createRuleScope, noteScopePath, rescope } from "./scope.js";
export type { RuleScope } from "./scope.js";
