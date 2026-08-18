/**
 * toolSelectionEval.mjs — does a smaller advertised tool set pick better tools?
 *
 * Runs the SAME 30 single-turn scenarios against two configurations:
 *   full:    every tool in the registry advertised (status quo, 39 tools)
 *   trimmed: the proposed 25-tool core, with deferred tools reachable only
 *            through a `find_tools` search stub (mirrors src/mcp/deferred.ts)
 *
 * Each scenario is a realistic user turn with ONE clearly-correct tool (or an
 * acceptable set). The model is asked to respond with a tool call; we score
 * whether its FIRST call names an accepted tool. For deferred-tool scenarios in
 * the trimmed config, calling `find_tools` with a sensible query counts as
 * correct — that IS the correct move in that configuration.
 *
 * Usage:
 *   node scripts/toolSelectionEval.mjs --dry-run          # validate scenarios, no API
 *   DEEPSEEK_API_KEY=... node scripts/toolSelectionEval.mjs --provider deepseek --model deepseek-chat
 *   ANTHROPIC_API_KEY=... node scripts/toolSelectionEval.mjs --provider anthropic --model claude-sonnet-4-5
 *
 * Prints per-config accuracy, the disagreements, and per-scenario detail.
 * Run each config 3x (temperature 0 still varies on some providers) before
 * believing a difference smaller than ~10 points.
 */
import { toolSchemas } from "../dist/tools/registry.js";

// ── The proposed split ─────────────────────────────────────────────────────────
export const CORE_TOOLS = new Set([
  "list_dir", "glob", "grep", "read_file", "web_search", "web_fetch",
  "outline", "definition", "references", "relevant", "read_symbol", "diagnostics",
  "shell_output", "list_shells", "kill_shell",
  "find_mcp_tools", "use_skill", "ask_user",
  "write_file", "replace_symbol_body",
  "spawn_subagent", "run_command", "todo_write",
]);

/** The §6.3 merge shipped in the trimmed config: one `edit` tool absorbs
 *  edit_file + multi_edit (an edits[] with one entry IS the single-edit case),
 *  which removes the measured routing nondeterminism between them. Hardcoded
 *  here because the eval compares layouts, not refactors. */
const MERGED_EDIT = {
  type: "function",
  function: {
    name: "edit",
    description:
      "Replace strings in ONE file. Pass `edits`: each entry's old_string must identify " +
      "exactly one place (or set replace_all), matched against the file as-is. One entry " +
      "for a single change; several entries apply in order, all-or-nothing. Read the " +
      "file first. This is the default way to change an existing file — prefer it over " +
      "rewriting whole files.",
    parameters: {
      type: "object", additionalProperties: false, required: ["path", "edits"],
      properties: {
        path: { type: "string", description: "File to change." },
        edits: {
          type: "array", minItems: 1,
          items: {
            type: "object", additionalProperties: false, required: ["old_string", "new_string"],
            properties: {
              old_string: { type: "string", description: "Text to find (must be unique unless replace_all)." },
              new_string: { type: "string", description: "Replacement text." },
              replace_all: { type: "boolean", description: "Replace every occurrence." },
            },
          },
        },
      },
    },
  },
};

/** Search stub standing in for the native deferred pool (same shape as find_mcp_tools). */
const FIND_TOOLS_STUB = {
  type: "function",
  function: {
    name: "find_tools",
    description:
      "Search the deferred tool pool for capabilities not in your current list: the " +
      "governor (standing rules; forbidding paths, commands, or MCP tools), " +
      "cross-session memory, creating skills, sessions history, MCP servers and " +
      "resources, workspace roots, screenshots. Matches are activated for use.",
    parameters: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string", description: "What capability you need." } },
    },
  },
};

// ── Scenarios ──────────────────────────────────────────────────────────────────
// accept: tools that count as correct under the FULL config.
// deferred: true → under TRIMMED, `find_tools` is the correct answer instead.
const SCENARIOS = [
  { p: "Show me what's inside src/utils/dates.ts", accept: ["read_file"] },
  { p: "Find every place in the repo that calls parseConfig()", accept: ["grep", "references"] },
  { p: "Rename the variable `usr` to `user` on line 40 of auth.ts (you've read the file already this session).", accept: ["edit_file"] },
  { p: "In server.ts (already read), change the port to 8080, bump the version string, and fix the typo in the banner — three separate spots.", accept: ["multi_edit"] },
  { p: "Create a brand-new file called scripts/cleanup.sh that removes dist/", accept: ["write_file"] },
  { p: "Run the test suite and show me what fails", accept: ["run_command"] },
  { p: "What functions does src/memory/store.ts export?", accept: ["outline", "read_file"] },
  { p: "Where is the class SessionStore defined?", accept: ["definition", "grep"] },
  { p: "List all TypeScript files under src/drivers", accept: ["glob", "list_dir"] },
  { p: "Is the dev server I started earlier still printing errors?", accept: ["shell_output"] },
  { p: "Kill that background build, it's stuck", accept: ["kill_shell", "list_shells"] },
  { p: "What's the latest version of the ink npm package?", accept: ["web_search"] },
  { p: "Fetch https://example.com/changelog and summarize it", accept: ["web_fetch"] },
  { p: "Are there any type errors in the files we touched?", accept: ["diagnostics"] },
  { p: "Replace the whole body of function validateUser with a stub that returns true", accept: ["replace_symbol_body", "edit_file"] },
  { p: "Search the whole monorepo for TODO comments — it's huge, do it without flooding your context", accept: ["spawn_subagent", "grep"] },
  { p: "Plan the migration in steps and track them as we go", accept: ["todo_write"] },
  { p: "I can't decide between REST and tRPC for this — ask me what matters before choosing", accept: ["ask_user"] },
  { p: "Show me just the definition of the handleAuth function in that big file", accept: ["read_symbol", "read_file"] },
  { p: "Which parts of the codebase are most relevant to billing?", accept: ["relevant", "grep"] },
  // ── Deferred-pool scenarios (find_tools is correct under TRIMMED) ──
  { p: "From now on, never touch anything under infra/terraform in this project", accept: ["forbid_path"], deferred: true },
  { p: "Remember this rule for this repo: always run prettier before committing", accept: ["remember_rule"], deferred: true },
  { p: "Never run `git push --force` here, ever", accept: ["forbid_command"], deferred: true },
  { p: "Remember for future sessions: I prefer pnpm over npm", accept: ["save_memory"], deferred: true },
  { p: "What did you and I do in this project last week?", accept: ["list_sessions", "read_session"], deferred: true },
  { p: "Add the GitHub MCP server: npx @modelcontextprotocol/server-github", accept: ["add_mcp_server"], deferred: true },
  { p: "Turn this deploy procedure we just worked out into a reusable skill", accept: ["create_skill"], deferred: true },
  { p: "Also include ../shared-lib in this session's workspace", accept: ["add_directory", "link_workspace"], deferred: true },
  { p: "Take a screenshot of the app window so you can see the layout bug", accept: ["screenshot"], deferred: true },
  { p: "What resources does the connected postgres MCP server expose?", accept: ["list_mcp_resources", "find_mcp_tools"], deferred: true },
];

// ── Config assembly ────────────────────────────────────────────────────────────
function buildConfigs() {
  const all = toolSchemas();
  const full = all;
  const trimmed = [
    ...all.filter((s) => CORE_TOOLS.has(s.function.name)),
    MERGED_EDIT,
    FIND_TOOLS_STUB,
  ];
  return { full, trimmed };
}

/** §6.3 merges: under the trimmed config, calling the merged tool is correct
 *  wherever its absorbed source tool was. */
const MERGE_MAP = {
  edit_file: "edit", multi_edit: "edit",
  remember_rule: "governor", forbid_path: "governor", forbid_command: "governor", forbid_mcp_tool: "governor",
  list_sessions: "sessions", read_session: "sessions",
  list_mcp_resources: "mcp_resource", read_mcp_resource: "mcp_resource",
  add_directory: "workspace", link_workspace: "workspace",
};

function trimmedAccepts(scenario) {
  const names = new Set(scenario.accept);
  for (const a of scenario.accept) if (MERGE_MAP[a]) names.add(MERGE_MAP[a]);
  return names;
}

function scoreCall(scenario, config, calledName, calledArgs) {
  if (config === "full") return scenario.accept.includes(calledName);
  if (!scenario.deferred) return trimmedAccepts(scenario).has(calledName);
  // Trimmed + deferred: find_tools with any non-empty query is the right move.
  if (calledName === "find_tools") return typeof calledArgs?.query === "string" && calledArgs.query.length > 0;
  return trimmedAccepts(scenario).has(calledName); // (can't happen: not advertised)
}

// ── Providers (OpenAI-compatible for DeepSeek; native for Anthropic) ───────────
async function callDeepseek(model, tools, prompt) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0, tools, tool_choice: "required",
      messages: [
        { role: "system", content: "You are a coding agent working inside the user's repository. Respond with the single most appropriate tool call for the user's request. Files mentioned as already read have been read this session." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json();
  const tc = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) return { name: null, args: null, raw: data };
  return { name: tc.function?.name ?? null, args: safeJson(tc.function?.arguments) };
}

async function callAnthropic(model, tools, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 300, temperature: 0,
      tool_choice: { type: "any" },
      tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
      system: "You are a coding agent working inside the user's repository. Respond with the single most appropriate tool call for the user's request. Files mentioned as already read have been read this session.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const block = (data.content ?? []).find((b) => b.type === "tool_use");
  if (!block) return { name: null, args: null, raw: data };
  return { name: block.name, args: block.input };
}

const safeJson = (s) => { try { return JSON.parse(s ?? ""); } catch { return null; } };

// ── Main ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const provider = argv[argv.indexOf("--provider") + 1] ?? "deepseek";
const model = argv[argv.indexOf("--model") + 1] ?? (provider === "anthropic" ? "claude-sonnet-4-5" : "deepseek-chat");

const { full, trimmed } = buildConfigs();

if (dryRun) {
  const names = new Set(full.map((s) => s.function.name));
  let ok = true;
  for (const sc of SCENARIOS) for (const a of sc.accept) {
    if (!names.has(a)) { console.error(`scenario accepts unknown tool: ${a} (${sc.p})`); ok = false; }
  }
  const coreMissing = [...CORE_TOOLS].filter((n) => !names.has(n));
  if (coreMissing.length) { console.error("CORE_TOOLS not in registry:", coreMissing); ok = false; }
  console.log(`scenarios: ${SCENARIOS.length} (${SCENARIOS.filter((s) => s.deferred).length} deferred)`);
  for (const synth of [MERGED_EDIT, FIND_TOOLS_STUB]) {
    const f = synth.function;
    if (!f?.name || !f?.description || f?.parameters?.type !== "object") {
      console.error(`malformed synthetic tool: ${f?.name}`); ok = false;
    }
  }
  console.log(`full config: ${full.length} tools | trimmed config: ${trimmed.length} tools (incl. merged 'edit' + find_tools stub)`);
  console.log(ok ? "DRY RUN OK — every accepted tool exists in the registry." : "DRY RUN FAILED");
  process.exit(ok ? 0 : 1);
}

const call = provider === "anthropic" ? callAnthropic : callDeepseek;
const keyVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "DEEPSEEK_API_KEY";
if (!process.env[keyVar]) { console.error(`Set ${keyVar} first.`); process.exit(1); }

const results = { full: [], trimmed: [] };
for (const [configName, tools] of [["full", full], ["trimmed", trimmed]]) {
  for (const sc of SCENARIOS) {
    const { name, args } = await call(model, tools, sc.p);
    const pass = name != null && scoreCall(sc, configName, name, args);
    results[configName].push({ prompt: sc.p, called: name, pass, deferred: !!sc.deferred });
    process.stdout.write(pass ? "." : "F");
  }
  process.stdout.write("\n");
}

for (const configName of ["full", "trimmed"]) {
  const r = results[configName];
  const pass = r.filter((x) => x.pass).length;
  console.log(`\n${configName.toUpperCase()}: ${pass}/${r.length} (${((100 * pass) / r.length).toFixed(1)}%)`);
  for (const x of r.filter((x) => !x.pass)) console.log(`  MISS: called ${x.called ?? "nothing"} — ${x.prompt}`);
}
const flipped = results.full.map((f, i) => ({ f, t: results.trimmed[i] })).filter(({ f, t }) => f.pass !== t.pass);
console.log(`\nDisagreements (${flipped.length}):`);
for (const { f, t } of flipped) console.log(`  ${f.pass ? "full✓" : "full✗"} ${t.pass ? "trim✓" : "trim✗"} — ${f.prompt}`);
