/**
 * commandRoute.ts — deciding WHICH command a typed line is.
 *
 * This used to be the condition half of a 460-line `if (name === "/x")` chain inside a
 * React component, which is why every one of the eighteen commands had zero coverage:
 * there was nothing to call. The bodies still live in `App.tsx`. Only the decision
 * moved here, because the decision is where the defects were:
 *
 *  - **`/mcp add` and `/mcp remove` were DEAD.** The guard read
 *    `/^(add|remove|rm)\b/` on screen, but the byte where `\b` should have been was a
 *    literal backspace (0x08) — an escape lost somewhere in editing. The pattern
 *    therefore required the user to type a backspace character, so it never matched
 *    anything, and every `/mcp add …` silently opened the server-health view instead.
 *    The command was advertised in its own `/help` description the whole time.
 *  - The unknown-command reply listed thirteen of the eighteen commands, hardcoded. It
 *    had drifted, and the four it omitted included `/help`.
 *
 * Both are the same shape as the bugs found in the queue and the first run: the feature
 * worked, the routing to it did not, and reading the code did not show it — the first
 * one was INVISIBLE in the source, which is why the verb list here is data rather than
 * a pattern. There is nothing in `["add","remove","rm"]` that can be mistyped into
 * something that still compiles and never matches.
 *
 * Order matters and is deliberate: a builtin beats a project skill, a project skill
 * beats a third-party server's prompt. A server cannot shadow `/undo`, and a project's
 * own command always wins over something a dependency installed.
 */
import { findSkill } from "../governor/skills.js";
import type { SkillMeta } from "../governor/types.js";
import { parsePromptCommand } from "../mcp/prompts.js";

/** The sub-commands `/mcp` understands as configuration rather than as a status view. */
export const MCP_CONFIG_VERBS = ["add", "remove", "rm"] as const;

export interface ParsedCommand {
  /** The command word, lowercased, including its leading slash. */
  name: string;
  /** Everything after the command word, trimmed. Case is PRESERVED — it can be a path. */
  arg: string;
}

/**
 * Split a typed line into the command word and its argument.
 *
 * The name is lowercased so `/Help` works; the argument is not, because it is as
 * likely to be a path, a label or a directive, and lowercasing `/include SRC/Api`
 * would break it on a case-sensitive checkout.
 */
export function parseCommandLine(raw: string): ParsedCommand {
  const trimmed = raw.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  return { name: first.toLowerCase(), arg: trimmed.slice(first.length).trim() };
}

export type Route =
  /** One of the built-in commands. `name` is the lowercased word with its slash. */
  | { kind: "builtin"; name: string; arg: string }
  /** `/mcp add …` / `/mcp remove …` — writes the server config. */
  | { kind: "mcp-config"; arg: string }
  /** A skill this project defines, invoked as `/name`. */
  | { kind: "skill"; skill: SkillMeta; arg: string }
  /** A prompt offered by a connected MCP server, invoked as `/server:prompt`. */
  | { kind: "prompt"; server: string; prompt: string; arg: string }
  | { kind: "unknown"; name: string };

/**
 * Which built-in commands exist. Passed in rather than imported so this stays the same
 * list the input's autocomplete and `/help` render from — three places agreeing by
 * construction instead of by maintenance.
 */
export interface RouteCatalog {
  builtins: readonly string[];
  skills: readonly SkillMeta[];
}

export function routeCommand(raw: string, catalog: RouteCatalog): Route {
  const { name, arg } = parseCommandLine(raw);

  if (catalog.builtins.includes(name)) {
    // `/mcp` is the one builtin that splits: with a configuration verb it writes the
    // server config, bare it shows server health. An EXACT first word — a prefix match
    // would send `/mcp rmdir-server` to the remove branch, which fails its own exact
    // check one layer down and falls through to being parsed as an ADD.
    if (name === "/mcp") {
      const verb = arg.split(/\s+/)[0]?.toLowerCase() ?? "";
      if ((MCP_CONFIG_VERBS as readonly string[]).includes(verb)) {
        return { kind: "mcp-config", arg };
      }
    }
    return { kind: "builtin", name, arg };
  }

  // A project's own skill beats a server's prompt of the same name.
  const skill = findSkill(catalog.skills as SkillMeta[], name);
  if (skill) return { kind: "skill", skill, arg };

  const promptRef = parsePromptCommand(name);
  if (promptRef) return { kind: "prompt", server: promptRef.server, prompt: promptRef.name, arg };

  return { kind: "unknown", name };
}

/**
 * What to say when nothing matched.
 *
 * The old message hardcoded thirteen command names and had drifted from the real
 * eighteen — including omitting `/help`, the one that would have answered the
 * question. Pointing at `/help` cannot drift, and is shorter than the list it replaces.
 */
export function unknownCommandMessage(name: string): string {
  return `Unknown command ${name}. /help lists every command.`;
}
