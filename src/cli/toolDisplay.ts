/**
 * toolDisplay.ts — map a Mindweave tool call to its display name + argument.
 *
 * A compact tool header: a bold verb-noun name and the one telling
 * argument in parens — `Update(home.html)`, `Search(refreshToken)`, `Run(npm
 * test)`. Pure, display-only (never sent to a model), and deterministic from the
 * tool name + parsed args.
 */

/** Raw tool name → the bold display name shown in the row. */
const DISPLAY_NAME: Record<string, string> = {
  read_file: "Read",
  read_symbol: "Read",
  edit: "Update",
  write_file: "Write",
  search: "Search",
  run_command: "Executed shell command",
  outline: "Map",
  definition: "Map",
  references: "Map",
  relevant: "Map",
  diagnostics: "Check",
  web_fetch: "Fetch",
  web_search: "WebSearch",
  screenshot: "WindowCapture",
  use_skill: "Skill",
  create_skill: "Skill",
  todo_write: "Todo",
  add_directory: "Add",
  link_workspace: "Link",
  remember_rule: "Rule",
  forbid_path: "Forbid",
  spawn_subagent: "Subagent",
  shells: "Shell",
  // Tools the redesign originally missed. Without an entry each fell through to the
  // capitalize-the-raw-name fallback and rendered as `Replace_symbol_body` —
  // snake_case in a UI that has none anywhere else. TOOL_DISPLAY_COVERAGE in
  // toolDisplay.test.ts now fails the build if a registered tool is missing here.
  replace_symbol_body: "Update",
  save_memory: "Remember",
  sessions: "Session",
  workspace: "Workspace",
  kill_shell: "Shell",
  add_mcp_server: "MCP",
  mcp_resource: "MCP",
  find_tools: "MCP",
  governor: "Governor",
  exit_plan: "Plan",
  ask_user: "Ask",
  web: "Web",
};

/** What an unrecognized tool name renders as. A model can call a tool that does not
 *  exist (a hallucinated `index_results`, say). The row still has to appear — the call
 *  happened and it failed — but it renders under a plain English name with the raw
 *  name as its argument, rather than title-casing whatever the model invented. */
export const UNKNOWN_TOOL = "Unknown tool";

// Consecutive calls to these fold into ONE row (see ToolGroup) rather than
// stacking a line each — a burst of reads is "Read 9 files" with the files
// listed under it.
//
// Deliberately narrow. `search` is not here, and does not render at all — like the
// code-intel lookups (outline/definition/references/relevant), it is how the agent
// finds its way around rather than work done to the project, and the user asked for
// it to stay out of the stream. `todo_write` is silent for the same reason: its
// reader is the model, not the user. Mutating tools (edit/write/run) were never
// grouped and still keep their own row with the diff/output.
const GROUPABLE = new Set([
  "read_file",
  "read_symbol",
  // Background-shell status checks: silent, and a model tends to POLL them in a loop
  // while waiting on a build — so they fold into the group and their repeats collapse
  // (see collapseAdjacent) instead of stacking a row per poll. kill_shell mutates → stays.
  "shells",
]);
// `diagnostics` was here, and grouping it was the wrong answer to the right problem.
// A burst of them after an edit did stack a wall of rows — but folding them into the
// group threw away the caret block each one carries (a group row shows a label, never
// a detail), so the one case worth seeing, an actual compiler error with its source
// line and squiggle, was the case that got hidden. It now stays ungrouped and reports
// nothing at all when it finds nothing (`quiet`), which removes the wall outright.

/** Whether a tool call should fold into the discovery group rather than its own row. */
export function isGroupable(name: string): boolean {
  return GROUPABLE.has(name);
}

/**
 * The action a tool performs, used to colour its row dot. A small blue family
 * (with red reserved for failures) so the transcript reads at a glance — the
 * product's blue/black vision: looking is light, changing is vivid, running is
 * indigo, a failure is red.
 */
export type ToolKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "run"
  | "check"
  | "agent"
  | "websearch"
  | "screenshot"
  | "mcp"
  | "checkpoint"
  | "governor"
  | "meta";

const TOOL_KIND: Record<string, ToolKind> = {
  read_file: "read",
  read_symbol: "read",
  search: "search",
  outline: "search",
  definition: "search",
  references: "search",
  relevant: "search",
  edit: "edit",
  replace_symbol_body: "edit",
  write_file: "write",
  run_command: "run",
  diagnostics: "check",
  spawn_subagent: "agent",
  shells: "run",
  // web_fetch and web_search are both "reaching out to the web" — same family,
  // distinct from codebase "search". Was mislabeled "search" before.
  web_fetch: "websearch",
  web_search: "websearch",
  web: "websearch",
  screenshot: "screenshot",
  kill_shell: "run",
  governor: "governor",
  // The MCP family: finding an external server's tools, reading its data, adding one.
  // Pink like the servers' own tools, since that is what they are all about.
  find_tools: "mcp",
  mcp_resource: "mcp",
  add_mcp_server: "mcp",
  // everything else (todo, skills, rules, workspace) → "meta"
};

/** The action category for a raw tool name — an MCP call (`mcp__server__tool`) is
 *  detected by prefix rather than a static map entry, since the tool name is
 *  generated per-server (see src/mcp/manager.ts). Defaults to bookkeeping "meta". */
export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_KIND[name] ?? "meta";
}

/** Terminal colour per action kind — a blue family, truecolor hex (terminals that
 *  can't render it downsample gracefully). Red is reserved for the error state. */
export const KIND_COLOR: Record<ToolKind, string> = {
  read: "#7cc4ff", // light blue — looking at code
  search: "#4a90d9", // blue — searching / mapping the codebase
  edit: "#3b82f6", // vivid blue — changing code
  write: "#38bdf8", // sky — creating a file
  run: "#6366f1", // indigo — running a command
  check: "#22d3ee", // cyan — diagnostics / verifying
  agent: "#a78bfa", // violet — a spawned sub-agent (set apart from the blue tool family)
  websearch: "#2dd4bf", // teal — reaching outside the machine (web search / fetch)
  screenshot: "#facc15", // amber — a capture, set apart since it's visual not textual
  mcp: "#f472b6", // pink — an external server's own tool, not one of ours
  checkpoint: "#94a3b8", // slate — housekeeping you'd want to notice (a rollback)
  governor: "#fb923c", // orange — a policy decision, not an ordinary tool result
  meta: "#60a5fa", // soft blue — bookkeeping (todo, skills, rules)
};

/** The dot colour for a failed tool / failed test. */
export const ERROR_COLOR = "#ff5f56";

export interface ToolDisplay {
  name: string;
  arg?: string;
  /** Action category, for the row's dot colour. */
  kind: ToolKind;
  /** A dim qualifier after the name — currently a non-default command timeout, shown
   *  because it changes how long the row may sit there before it means anything. */
  meta?: string;
}

/** Build the `Name(arg)` display parts for a tool call. */
export function toolDisplay(name: string, args: Record<string, unknown>): ToolDisplay {
  const kind = toolKind(name);

  // mcp__<server>__<tool> has no static DISPLAY_NAME entry (the name is generated
  // per-server, see src/mcp/manager.ts) — parse it back into "MCPServer(server)"
  // the way the tool header for everything else reads.
  if (name.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return { name: "MCPServer", arg: server || undefined, kind };
  }

  // Every REGISTERED tool has an entry above (enforced by test), so reaching the
  // fallback means the model named a tool that does not exist.
  const known = DISPLAY_NAME[name];
  if (!known) return { name: UNKNOWN_TOOL, arg: name, kind: "meta" };
  const display = known;

  // `search` is quiet and never renders, but it still resolves a name/arg for the
  // sub-agent rail and for any future surface — and it takes either argument.
  if (name === "search") {
    return { name: display, arg: str(args.pattern) || str(args.files) || str(args.path) || undefined, kind };
  }
  if (name === "run_command") {
    // NO arg: the command goes on its own row inside the block (see ToolLine's
    // ShellLines), where it is never truncated. As a header argument it was clipped
    // to 48 characters, and a real command line is longer than that far more often
    // than not, so the part that said what it did was the part that got cut.
    //
    // Only when the model asked for one. The default is invisible on purpose — a
    // marker on every command would say nothing, and this one exists precisely to
    // explain a row that is allowed to take longer than usual.
    const t = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : undefined;
    return {
      name: display,
      kind,
      ...(t ? { meta: `[Timeout: ${Math.round(t / 1000)}s]` } : {}),
    };
  }
  if (name === "web_fetch") return { name: display, arg: clip(str(args.url), 48) || undefined, kind };
  if (name === "web_search") return { name: display, arg: clip(str(args.query), 48) || undefined, kind };
  if (name === "screenshot") return { name: display, arg: str(args.window) || undefined, kind };
  if (name === "spawn_subagent") return { name: display, arg: clip(str(args.task), 48) || undefined, kind };

  const path = str(args.path);
  const detail = path ? base(path) : str(args.symbol) || str(args.name) || str(args.query) || str(args.label);
  return { name: display, arg: detail || undefined, kind };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A path's last segment, so rows stay short: `src/a/session.ts` → `session.ts`. */
function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
