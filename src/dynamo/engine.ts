/**
 * dynamo — the engine.
 *
 * Takes a live session and produces Mindweave's next reply, running tools along the
 * way. The loop is intentionally tiny: ask the model → if it wants tools, run
 * them and feed the results back → repeat → when it answers with no tool call,
 * that's the reply. The model does the reasoning; the loop stays out of the way.
 *
 * The engine owns the TRANSCRIPT (it appends every user/assistant/tool turn to
 * `session.transcript`) and keeps it healthy with the compaction cascade. It is
 * pure of the filesystem: it never reads or writes session files (the CLI
 * persists). The one disk touch is re-reading project files, which goes through
 * the read-only tool exactly like any other tool call — so this whole function
 * can later move to a server unchanged, with tools executing on the client.
 */
import { activeDriver, ensureDriver, manifestForModel } from "../drivers/registry.js";
import type { ChatMessage, ImagePart, ModelRequest, StopReason, StreamResult, Usage, WireToolCall } from "../drivers/types.js";
import { summarizeTask, taskLimitReason, type TaskLimits } from "./pricing.js";
import { mutationNeedsVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, repeatFailureStep, repeatFailureNudge, failedActionLabel, firstErrorLine, sameFileEditCounts, overusedSingleEdits, batchEditNudge, narrationFault, narrationNudge, unknownToolError, replyFault, replyRewrite, VERIFY_NUDGE } from "./verify.js";
import { GUARD_OPTIONS, GUARD_REFUSAL, guardQuestion, guardDetail, interpretGuardChoice } from "./guard.js";
import { findTool, toolSchemas, TOOLS } from "../tools/registry.js";
import { deferredToolsIndex } from "../tools/deferredNative.js";
import { commandShellLabel } from "../tools/runCommand.js";
import { isInteractiveServerCommand } from "../tools/backgroundShells.js";
import { basePrompt } from "./prompt.js";
import { basename, relative } from "node:path";
import { promises as fsp } from "node:fs";
import { relativize, resolvePath, rootLabel } from "../tools/paths.js";
import { todoListText } from "../tools/todo.js";
import { renderRules, renderSkillCatalog } from "../governor/index.js";
import type { Session, Entry, ToolCallRecord } from "../memory/types.js";
import { forkSession, reloadProjectMemory } from "../memory/session.js";
import { buildWorkingSet, selectActiveFiles } from "../memory/workingSet.js";
import { fullReadPaths } from "../memory/presence.js";
import {
  KEEP_LAST_N,
  KEEP_LAST_N_BOUNDARY,
  SUMMARY_REQUEST,
  SUMMARY_SYSTEM_PROMPT,
  estimateEntriesTokens,
  formatTranscriptForSummary,
  isContinuation,
  microcompact,
  spliceSummary,
  usableSummary,
} from "../memory/compaction.js";
import { loadPlanArtifact, renderPlanBlock, planDivergenceStop } from "./planArtifact.js";
import {
  autoCompactThreshold,
  microCompactThreshold,
  measuredOverhead,
  sharpContextWindow,
  type CompactionReport,
} from "./contextWindow.js";
import { renderSessionMemory, shouldUpdateSessionMemory, updateSessionMemory } from "../memory/sessionMemory.js";

/** Stop retrying autocompact after this many consecutive failures in a session, so a
 *  transcript that's irrecoverably over the limit can't hammer the summarizer each turn
 *  (a circuit-breaker for runaway retry loops, which can otherwise pile up thousands of doomed retries). */
const MAX_COMPACT_FAILURES = 3;

// The static base (identity, output/formatting, tone, tool mechanics, safety,
// task hygiene, and how to use cross-session memory) comes from basePrompt in
// prompt.ts. Here we wrap it with the per-session, per-turn context: the
// governor (rules/forbidden/skills), the project snapshot, MINDWEAVE.md, the memory
// index, the ranked code map, the task list, and the multi-root workspace. The
// line we hold is the thin-prompt boundary: rich on what the harness owns, but
// we still do NOT teach engineering judgment (how to debug, how to write code) —
// that is the model's job.
export function staticSystemPrompt(
  projectContext: string,
  projectMemory: string,
  memoryDir: string,
  memoryIndex: string,
  governance: GovernancePrompt,
  workspace: string,
  priorSessions = 0,
): string {
  let prompt = basePrompt(commandShellLabel());

  if (workspace) {
    prompt += `

This session spans more than one root folder. Each file is addressed as \`label/path\`; search tools cover every root unless you pass a specific \`path\`. The roots are:
<workspace>
${workspace}
</workspace>`;
  }

  // NOTE: the user's standing rules are deliberately NOT rendered here. They live
  // in the volatile tail (volatileContext) instead — rebuilt every turn at the
  // boundary where attention is strongest, so a long session can't bury them in the
  // middle of a huge cached prefix. Rules are the one governance layer that depends
  // purely on the model reading and obeying (forbidden is enforced mechanically;
  // skills are a reference catalog), so they alone get the salience boost. Keeping
  // them out of the prefix also stops a mid-session `remember_rule` from busting it.
  if (governance.forbidden) {
    prompt += `

You are FORBIDDEN from modifying these paths — never write, edit, or run a command that changes them. The tools also enforce this and will refuse, but do not even try:
<forbidden>
${governance.forbidden}
</forbidden>`;
  }
  if (governance.forbiddenCommands) {
    prompt += `

You are FORBIDDEN from running these commands (or any command that contains one) — run_command will refuse them and only the user can lift that. Do not attempt them or a workaround:
<forbidden_commands>
${governance.forbiddenCommands}
</forbidden_commands>`;
  }
  if (governance.skills) {
    prompt += `

You have project skills available — named procedures you can run. To run one, call use_skill with its name; its full steps are loaded then (you only see the summary here). Use one when its description fits the task:
<available_skills>
${governance.skills}
</available_skills>`;
  }

  if (projectContext) {
    prompt += `

The following describes the project and machine you're working in, captured at the start of this session (a snapshot — use tools for anything current or deeper):
${projectContext}`;
  }
  if (projectMemory) {
    prompt += `

The project provides this context in its MINDWEAVE.md — treat it as background facts about this codebase:
<project_memory>
${projectMemory}
</project_memory>`;
  }
  // Its own past work in this project. The COUNT goes in the prompt (so the model
  // knows the history exists without being told every turn what is in it); the
  // CONTENT is pulled on demand with list_sessions / read_session. Injecting the
  // sessions themselves would be ruinous — this way an ordinary turn pays nothing
  // and a question about past work gets a real answer instead of a deflection.
  if (priorSessions > 0) {
    const s = priorSessions === 1 ? "" : "s";
    prompt += `

You have worked in this project before: ${priorSessions} earlier session${s} of yours are saved, and you can read them. When the user refers to earlier work — "last session", "what did we do", "the bug we fixed" — call \`list_sessions\`, then \`read_session\` for the one they mean, and answer from what you find. Do not say you cannot see your past sessions, and do not guess from the project files instead. \`/continue\` is for the user to RESUME a session; it is not a substitute for you looking. Never present another tool's saved conversations as your own.`;
  }

  if (memoryDir) {
    prompt += `

Your cross-session memory for this project lives in \`${memoryDir}\` (read or grep the topic files there for the full text of any entry). Its index:
<memory_index>
${memoryIndex || "(empty — nothing has been saved to memory yet)"}
</memory_index>`;
  }

  // The deferred pool's index. Roughly forty tokens standing in for several hundred of
  // schema, and it earns them: without it a deferred tool is indistinguishable from a
  // missing feature, and the model routes around a capability it actually has.
  const deferred = deferredToolsIndex();
  if (deferred) {
    prompt += `

${deferred}`;
  }

  return prompt;
}

/**
 * The volatile per-turn context, rendered at the TAIL of the request (outside the
 * cacheable prefix): the ranked code map and the live task list. These change
 * across steps/turns, so keeping them out of the system prompt is what lets the
 * system + conversation prefix stay byte-stable and be served from the provider's
 * prompt cache. Returns "" when there's nothing to add.
 */
export function volatileContext(
  rules: string,
  relevantMap: string,
  todoList: string,
  workingFiles: string,
  planMode: boolean,
  sessionMemory: string,
  approvedPlan = "",
  /** Whether the ranked map was narrowed to files the model has actually worked on. */
  mapPersonalized = true,
): string {
  const parts: string[] = [];
  // Standing rules FIRST in the volatile tail. They're rebuilt every turn here (not
  // in the cached prefix), so a long conversation can never bury them — and they sit
  // at the top of the freshest context the model reads before it acts. Binding by
  // design: they override the model's own defaults.
  if (rules) {
    parts.push(
      "The user's standing rules for this project. They are BINDING — follow them exactly, and let them " +
        "override your own defaults and habits. Do not violate them or work around them:\n" +
        `<rules>\n${rules}\n</rules>`,
    );
  }
  // The approved plan is standing knowledge: rendered fresh here every request
  // (never from the transcript), which is what makes it immune to compaction. It
  // binds EXECUTION turns; while planning, the model is deliberately not anchored
  // to the previous agreement — the artifact stays on disk if it wants history.
  if (approvedPlan && !planMode) {
    parts.push(approvedPlan);
  }
  // Plan mode (Architect) lives in the VOLATILE tail, not the cached prefix, so
  // toggling it with shift-tab never invalidates the cached system prompt.
  if (planMode) {
    parts.push(
      "You are in PLAN MODE (Architect). Research the codebase and think the change through; do NOT modify files, " +
        "run commands, or take any action while planning — the editing tools are withheld until the plan is approved. " +
        "Where a decision is genuinely the user's (which approach, which of two designs), ask with ask_user rather " +
        "than choosing for them. " +
        "When you know exactly what you would change, call exit_plan with the WHOLE plan in it. That is how planning " +
        "ends: the user reads the plan there, and approving it starts the work immediately, in the same turn, with " +
        "you following that plan. Do not write the plan out as an ordinary reply and stop — prose between steps is " +
        "shortened before the user sees it, so a plan presented that way reaches them in pieces.",
    );
  }
  // The maintained session state — first in the volatile tail so the model reads
  // "here's where we are" before the map/task list. Survives compaction.
  const memBlock = renderSessionMemory(sessionMemory);
  if (memBlock) parts.push(memBlock);
  if (relevantMap) {
    // Two different things wear the same block. Once files have been read the ranking is
    // personalized to them and "most relevant to your current focus" is true. Before
    // that there is no focus to rank against, so it is whatever the graph ranks highest
    // overall — on a frontend task in a Tauri project, twelve Rust file-IO functions,
    // presented as the code most relevant to what the model was about to do. Say which
    // one this is rather than letting the model act on a claim we cannot support.
    parts.push(
      (mapPersonalized
        ? "Code most relevant to your current focus (from the code map; use the code-map tools for more):\n"
        : "The most-connected symbols in this project (from the code map). Nothing has been read yet this " +
          "session, so this is NOT yet narrowed to your task — treat it as a starting point, not an answer:\n") +
        `<relevant_code>\n${relevantMap}\n</relevant_code>`,
    );
  }
  if (todoList) {
    parts.push(
      "Your current task list (maintain it with todo_write; [x] done, [~] in progress, [ ] pending):\n" +
        `<task_list>\n${todoList}\n</task_list>`,
    );
  }
  // Working files LAST — the freshest, most task-critical content sits at the very end
  // of the request (the boundary), where attention is strongest (lost-in-the-middle).
  if (workingFiles) {
    parts.push(`<working_files>\n${workingFiles}\n</working_files>`);
  }
  parts.push(REPLY_STYLE);
  return parts.join("\n\n");
}

/**
 * How to write the message that ENDS a turn. Rebuilt at the boundary every request,
 * for the same reason the standing rules are: this lived in the cached system prefix
 * and was reliably ignored by turn three, which is exactly what "a long conversation
 * buries it" predicts.
 *
 * Written against the observed failure, which was NOT mainly length. Asked to read a
 * roadmap and say what to do next, it answered with a heading, a status recap nobody
 * requested, four numbered items carrying three sentences of justification each, six
 * further phases, a design digression, and two closing questions. Rewritten by the
 * user as plain paragraphs it kept nearly all the content at a third less text — the
 * bulk was scaffolding, not substance. So the rule leads on SHAPE.
 */
const REPLY_STYLE = [
  "How to write your final reply this turn (the message that ends it, with no tool call):",
  "<reply_style>",
  "Match the answer to the question. Finishing a task, confirming something, reporting a result: FOUR LINES OR FEWER, not counting code blocks. That is most turns, and there the budget is hard.",
  "A question that genuinely asks for an account — what did we do last session, what does this code do, what are the options, why did that break — earns as many plain paragraphs as the answer actually needs. Do not cram a real explanation into one line; the budget exists to stop padding, not to stop answering.",
  "After doing work, just stop. Do not explain what you did, summarise the changes, or recap where the project stands — the user watched every tool call and can read the diff. Do not append an adjacent topic you noticed, a second recommendation, or a consideration for later. Ask at most ONE question, and only when you genuinely cannot proceed without it.",
  "Plain prose. No headings, no bullet lists, no bold labels on a short answer — that is a sentence dressed as a document. A list only when the items are genuinely parallel, a table only for real rows and columns.",
  "Examples of the right length:",
  "  user: is it built?  →  Yes, dist is current. Go ahead.",
  "  user: why is the test failing?  →  The fixture passes mtimeMs: 0, so the freshness gate treats the file as stale. Set it from the real stat.",
  "  user: add the subscription row  →  Added. The spending-cap branch now subtracts subs before the S&P split, which it was not doing.",
  "And one that earns more, still as plain paragraphs with no headings or bullets:",
  "  user: what did we build last session?  →  We closed the round-3 audit. The empty src/pages and src/js/modules directories are gone, the subscription-cost logic is deduped into a single getSubscriptionCost in salary.js, and getTaxBracket is wired into calculateSalary instead of the inline copy.\\n\\n  We also added the File → Import Data flow end to end, menu through IPC to storage and a UI refresh. The build passed and import/export was verified by hand.\\n\\n  The open thread is the Subscriptions UI, and whether to settle the ALL to EUR model before touching Settings.",
  "Long is not thorough. Twice the length is not twice the help; it is the same answer with the reader's time spent on nothing.",
  "</reply_style>",
].join("\n");

// The governor's three prompt blocks, pre-rendered to strings ("" when empty so
// the block is omitted). Built fresh each turn from the session's governance.
interface GovernancePrompt {
  rules: string;
  forbidden: string;
  forbiddenCommands: string;
  skills: string;
}

function governancePrompt(session: Session): GovernancePrompt {
  const g = session.governance;
  // The working set: project-relative POSIX paths the model has touched this
  // session. Glob-scoped rules fire only when one of these matches their globs.
  const root = g.forbidden.root;
  const workingSet = [...session.toolContext.reads.keys()].map((abs) =>
    relative(root, abs).split("\\").join("/"),
  );
  return {
    rules: renderRules(g.rules, workingSet),
    forbidden: g.forbidden.patterns.map((p) => `- ${p}`).join("\n"),
    forbiddenCommands: (g.forbidden.commands ?? []).map((c) => `- ${c}`).join("\n"),
    skills: renderSkillCatalog(g.skills, workingSet),
  };
}

// The tiny, budgeted ranked map injected each turn (the "auto-map" half of the
// relevance feed). Personalized to the files recently read. A pure in-memory
// chassis query — no I/O, no model call — so the engine stays filesystem-pure.
const AUTO_MAP_LIMIT = 12;
/** How many recently-worked-on files personalize the ranking. */
const AUTO_MAP_FOCUS = 5;

async function relevantMapText(session: Session): Promise<{ text: string; personalized: boolean }> {
  const chassis = session.toolContext.chassis;
  if (!chassis || !chassis.status().ready) return { text: "", personalized: false };
  // By RECENCY, which is not what iterating the ledger gives. `ctx.reads` is a Map, and
  // neither `touch()` (mutates the record in place) nor `recordWrite()` (re-sets an
  // existing key) changes insertion order — so slicing the key list returned the five
  // files first SEEN, not the five most recently worked on. In a session that keeps
  // returning to one file, that file dropped out of its own relevance feed as soon as
  // five others had been opened. `selectActiveFiles` already sorts the right way.
  const focus = selectActiveFiles(session.toolContext.reads, AUTO_MAP_FOCUS).map((f) => f.path);
  const ranked = await chassis.relevant(focus, AUTO_MAP_LIMIT);
  if (ranked.length === 0) return { text: "", personalized: false };
  const text = ranked
    .map((r) => {
      const s = r.symbol;
      const where = `${relativize(session.toolContext, s.file)}:${s.line}`;
      // A short doc conveys intent so the always-on map is more than names.
      const doc = s.doc ? ` — ${s.doc}` : "";
      return `- ${s.name} (${s.kind}) ${where}${doc}`;
    })
    .join("\n");
  return { text, personalized: focus.length > 0 };
}

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** A boolean env flag. Default ON unless explicitly set to 0/false/off/no. */
function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

/** A non-negative number from the environment, or the fallback. */
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Per-task cost/time ceilings. OFF (0) by default — opt-in via env, so there are
 *  no surprise pauses; a runaway is one env var away from being capped. */
function taskLimits(): TaskLimits {
  return {
    maxUsd: envNum("MINDWEAVE_MAX_TASK_USD", 0),
    maxSeconds: envNum("MINDWEAVE_MAX_TASK_SECONDS", 0),
  };
}

// Max model turns (tool rounds) in one reply. A generous ceiling: real multi-file
// work — a feature across a dozen files, a refactor — should finish in one go, so
// this is a circuit-breaker against a runaway loop, NOT a work limit. When it is
// hit the loop pauses LOSSLESSLY (the transcript, task list, and working set are
// intact) and hands the decision to continue back to the user, so it can never
// silently burn tokens. Env-overridable for power users.
const STEP_BUDGET = envInt("MINDWEAVE_STEP_BUDGET", 50);
// Verification gate: when the model edits files then tries to finish without
// running any check, nudge it once to verify. On by default; MINDWEAVE_VERIFY_GATE=0
// disables it. See verify.ts for the (pure, tested) fact detectors.
const VERIFY_GATE = envFlag("MINDWEAVE_VERIFY_GATE", true);
// Background-poll allowance: how many still-running background-shell polls the model
// may make in one turn before the loop stops it. A finished shell notifies the model
// automatically, so polling is redundant; one poll is allowed (a legitimate "grab the
// current tail" when the user asks), the wait-loop after that is stopped deterministically.
const BG_POLL_ALLOWANCE = envInt("MINDWEAVE_BG_POLL_LIMIT", 1);
// How many times in a row the model may fire a step that fails the SAME way before we
// stop it. 3 is the threshold: repeated identical failures past that are a stuck loop,
// not progress. Env-overridable for tuning.
const REPEAT_FAIL_LIMIT = envInt("MINDWEAVE_REPEAT_FAIL_LIMIT", 3);

/**
 * A live event from a turn, for the streaming UI. The model's reasoning and answer
 * arrive as `reasoning`/`text` deltas; each tool the model runs bookends with a
 * `tool` start (name + parsed args, before it runs) and end (summary, after) keyed
 * by the call `id`; `usage` reports the turn's token count once the answer lands.
 * Out-of-band notices (compaction) still go through `onActivity`, not here.
 */
export type EngineEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  /** The draft reply was rejected by the reply gate — discard whatever text has been
   *  buffered for this turn's reply, because a rewrite is about to stream in its place.
   *  Nothing has been rendered yet (text reveals whole, on seal), so this is invisible. */
  | { type: "replyReset" }
  // `agent` (a sub-agent id) tags a tool event that came from a spawned worker, so the
  // UI can nest it under that worker's row instead of the main stream. Absent on the
  // lead agent's own calls.
  | { type: "tool"; phase: "start"; id: string; name: string; args: Record<string, unknown>; agent?: string }
  | {
      type: "tool";
      phase: "end";
      id: string;
      name: string;
      summary: string;
      error: boolean;
      detail?: string;
      /** See ToolResult.detailKind — whether `detail` is a real +/- diff (colour it)
       *  or ordinary text (do not). Absent means text. */
      detailKind?: "diff" | "text" | "shell";
      agent?: string;
      /** Display-only: a failure the model resolves itself, so the UI drops the row
       *  rather than painting an error the user can do nothing about. See ToolResult.quiet. */
      quiet?: boolean;
      /** See ToolResult.displayKind/displayName — a result-driven override of the
       *  row's category/name (a governance decision, not an ordinary outcome). */
      displayKind?: import("../cli/toolDisplay.js").ToolKind;
      displayName?: string;
    }
  // A spawned sub-agent's lifecycle: `start` when it's dispatched (with its task +
  // read-only flag), `end` when it reports back. Between them, its own tool events
  // arrive tagged with this `id`, so the UI can render a live nested rail per worker.
  | { type: "subagent"; phase: "start"; id: string; task: string; readOnly: boolean }
  | { type: "subagent"; phase: "end"; id: string; summary: string; error: boolean }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number };

export interface RespondOptions {
  /** Called once per tool run (and on compaction) with a short line for the live
   *  UI. `opts.error` marks a failed tool so the UI can flag it; `opts.context`
   *  marks a context-housekeeping line (compaction) so the UI sets it apart. */
  onActivity?: (line: string, opts?: { error?: boolean; context?: boolean }) => void;
  /**
   * A compaction pass finished, with what it cost and recovered.
   *
   * Separate from `onActivity` because it is numbers, not a line of text — the client
   * draws its own bars from them, and a pre-formatted string would force the engine to
   * know about terminal width. Automatic and manual compactions both report here, so a
   * user who never typed /compact still learns their conversation was summarized.
   */
  onCompaction?: (report: CompactionReport) => void;
  /** Called for every live event of the turn (deltas, tool lifecycle, usage). The
   *  streaming UI renders from these; omit it for a non-interactive caller. */
  onEvent?: (event: EngineEvent) => void;
  /** Aborts the in-flight model call, kills a running command, and stops the loop at
   *  the next boundary (the user pressing Esc). run_command listens to the same signal. */
  signal?: AbortSignal;
  /** Persist the session NOW — called after every transcript step (assistant message,
   *  tool results, final reply) so a hard crash / PC shutdown loses at most the current
   *  in-flight step, not the whole turn. Best-effort; awaited so the write lands before
   *  the next model call. Omit for callers that don't persist (e.g. sub-agents). */
  persist?: () => Promise<unknown> | void;
  /** Cap on tool rounds for THIS run, overriding the default step budget. Used to
   *  give a spawned sub-agent a smaller budget than the main agent. */
  maxSteps?: number;
}

/** True if an error is an AbortError (the model call was cancelled). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Record and return a clean interrupted reply (well-formed transcript). */
function interrupted(session: Session): string {
  const msg = "(interrupted)";
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Map our stored tool calls to the provider's wire shape. */
function toWire(calls: ToolCallRecord[]): WireToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.arguments },
  }));
}

/** The labeled root list for the prompt — "" for an ordinary single-root session. */
function workspaceText(session: Session): string {
  const roots = session.toolContext.roots ?? [];
  if (roots.length <= 1) return "";
  return roots.map((r) => `- ${rootLabel(roots, r)}  →  ${r}`).join("\n");
}

/**
 * Build the provider-agnostic request from a session. The split is deliberate and
 * is what makes prompt caching work on every model (see ModelRequest):
 *   - `system`   — the STABLE system prompt (identity, tools guidance, governance,
 *                  project facts). Same bytes every step → cached prefix.
 *   - `messages` — the conversation, append-only, plus any one-shot background-shell
 *                  notes for this turn (transient — never stored, so they can't
 *                  re-inject).
 *   - `context`  — the VOLATILE per-turn map + task list, rendered at the tail so it
 *                  never invalidates the cached prefix.
 */
/**
 * Read the bytes for every image still live in the transcript, keyed by path.
 *
 * Bytes are loaded HERE, once per turn, rather than stored in the transcript or read
 * by each driver. That keeps the session file small, keeps drivers off the filesystem
 * (they format, they don't fetch), and means the caps and validation live in one place.
 * A file that has since been deleted or become unreadable is simply absent from the
 * map; `buildRequest` turns that into a line the model can read, never a crash.
 */
async function loadImagePayloads(session: Session): Promise<Map<string, string>> {
  const paths = new Set<string>();
  for (const e of session.transcript) {
    if (e.role === "user" && e.images) for (const img of e.images) paths.add(img.path);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...paths].map(async (p) => {
      try {
        out.set(p, (await fsp.readFile(p)).toString("base64"));
      } catch {
        // Gone or unreadable — deliberately left out of the map.
      }
    }),
  );
  return out;
}

function buildRequest(
  session: Session,
  relevantMap: { text: string; personalized: boolean },
  workingFiles: string,
  bgEvents: string[],
  tools: ReturnType<typeof toolSchemas>,
  imagePayloads: Map<string, string> = new Map(),
): ModelRequest {
  const messages: ChatMessage[] = [];
  for (const e of session.transcript) {
    if (e.role === "user" || e.role === "summary") {
      // Attached images ride with the message, but only while their payload is still
      // live: microcompaction drops the refs once the turn is old, and a file deleted
      // since it was attached simply isn't in the payload map. Either way the model is
      // TOLD rather than quietly handed a message that claims an image it cannot see.
      const refs = e.role === "user" ? e.images : undefined;
      if (refs && refs.length > 0) {
        const images: ImagePart[] = [];
        const missing: string[] = [];
        for (const ref of refs) {
          const data = imagePayloads.get(ref.path);
          if (data) images.push({ path: ref.path, mediaType: ref.mediaType, data });
          else missing.push(basename(ref.path));
        }
        const content =
          missing.length > 0 ? `${e.content}\n\n[${missing.join(", ")} could not be read from disk]` : e.content;
        messages.push({ role: "user", content, ...(images.length > 0 ? { images } : {}) });
        continue;
      }
      messages.push({ role: "user", content: e.content });
    } else if (e.role === "assistant") {
      messages.push({
        role: "assistant",
        content: e.content,
        ...(e.toolCalls && e.toolCalls.length > 0 ? { tool_calls: toWire(e.toolCalls) } : {}),
      });
    } else {
      messages.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content });
    }
  }
  for (const note of bgEvents) messages.push({ role: "user", content: note });

  // Compute the governance blocks once: the prefix uses forbidden/skills, the
  // volatile tail uses the rules (moved there for salience — see volatileContext).
  const gov = governancePrompt(session);
  return {
    system: staticSystemPrompt(
      session.projectContext,
      session.projectMemory,
      session.memoryDir,
      session.memoryIndex,
      gov,
      workspaceText(session),
      session.priorSessions,
    ),
    messages,
    context: volatileContext(
      gov.rules,
      relevantMap.text,
      todoListText(session.toolContext),
      workingFiles,
      session.toolContext.planMode ?? false,
      session.sessionMemory ?? "",
      session.toolContext.activePlan
        ? renderPlanBlock({
            plan: session.toolContext.activePlan,
            approvedAt: session.toolContext.activePlanApprovedAt ?? "",
            mode: "lightning",
          })
        : "",
      relevantMap.personalized,
    ),
    tools,
    model: session.modelConfig,
  };
}

/**
 * Collect one-shot notes for background shells that finished since the last turn.
 * Drained ONCE here (the manager marks them reported), so the model is told exactly
 * once — never the re-injecting-forever leak that plagues other agents.
 */
async function backgroundEventNotes(session: Session): Promise<string[]> {
  const mgr = session.toolContext.backgroundShells;
  if (!mgr) return [];
  const events = await mgr.drainEvents();
  return events.map(({ info, kind, tail, wake }) => {
    // It came up. This is the only positive event a server ever produces, and it is
    // what lets the model actually deliver the "I'll tell you when it's running" it
    // was told to say. Nothing has gone wrong, so there is nothing to fix.
    if (kind === "ready") {
      return (
        `[Background shell #${info.id} (\`${info.command}\`) is up and running.]\n` +
        `Recent output:\n${tail || "(no output)"}\n\n` +
        `Tell the user in one short line that it's running. Nothing is wrong — do not investigate, ` +
        `do not restart it, and do not change any files because of this.`
      );
    }
    const status =
      info.status === "killed"
        ? info.stoppedBy === "user"
          ? "was stopped by the user"
          : "was killed"
        : `finished with exit code ${info.exitCode}`;
    // An ending that is NOT worth interrupting for still arrives, so the model knows the
    // thing is down and can answer about it. It is explicitly not a task: this is the
    // path a user closing their own app takes, and treating it as news is what made the
    // agent reopen it.
    if (!wake) {
      return (
        `[Background shell #${info.id} (\`${info.command}\`) ${status}. It had already started up, so ` +
        `this is the user stopping their own app, not a failure.]\n` +
        `This is background information only. Do NOT mention it unless it is relevant, do NOT restart ` +
        `it, and do NOT change any files because of it. If the user later asks about this app, you now ` +
        `know it is stopped.`
      );
    }
    // For a server, only a failure to come up reaches here: a normal stop does not wake.
    const guidance =
      info.notify === "on_failure"
        ? "This is a server or app that never came up, so the user never saw it running. Tell them what happened and offer to fix it — but do not restart it repeatedly on your own."
        : "If it failed, tell the user briefly what went wrong and propose a fix — don't change files unless they agree.";
    return (
      `[Background shell #${info.id} (\`${info.command}\`) ${status}.]\n` +
      `Recent output:\n${tail || "(no output)"}\n\n` +
      guidance
    );
  });
}

/**
 * Produce Mindweave's next reply for the latest user message already on
 * `session.transcript`. Appends the assistant/tool turns it generates and
 * returns the final assistant text.
 */
/**
 * Whether a tool call may run in the PARALLEL lane (pure — unit-tested). A tool's
 * per-args `isConcurrencySafe` wins when present (e.g. a read-only sub-agent is safe
 * to fan out, an editing one is not); otherwise the default is read-only ⇒ safe.
 */
export function callIsConcurrencySafe(
  tool: { readOnly: boolean; isConcurrencySafe?: (args: Record<string, unknown>) => boolean },
  args: Record<string, unknown>,
): boolean {
  return tool.isConcurrencySafe ? tool.isConcurrencySafe(args) : tool.readOnly;
}

/**
 * Run one turn, and put planning back afterwards if an approved plan left it.
 *
 * The restore is in a `finally` rather than at the end of the turn because approval
 * grants ONE turn of doing however that turn ends — a step-budget pause, an error, or
 * Esc all have to come back to planning. Leaving it off would strand the session in a
 * mode it was put into by a tool call rather than by the user, and the next request
 * would run unplanned.
 */
export async function respond(session: Session, options: RespondOptions = {}): Promise<string> {
  try {
    return await respondTurn(session, options);
  } finally {
    if (session.toolContext.planResume) {
      session.toolContext.planResume = false;
      session.toolContext.planMode = true;
      session.toolContext.guarded = false;
      session.toolContext.guardAllowAll = false;
      session.toolContext.onModeChange?.();
    }
  }
}

async function respondTurn(session: Session, options: RespondOptions = {}): Promise<string> {
  // Make sure the provider serving the selected model is loaded before anything
  // in this turn reaches for it. Cached after the first call, so this is free on
  // every subsequent turn, and it keeps `activeDriver()` safe to call synchronously
  // from here down (including from inside a tool).
  await ensureDriver(session.modelConfig.model);

  // Resume an approved plan from disk, once per session (undefined = unchecked).
  // A plan approved last session is still the agreed scope this session — that is
  // the point of it being an artifact — and the user deleting the file (or its
  // status flipping) is a complete off switch, honored here by loading nothing.
  if (session.toolContext.activePlan === undefined) {
    const artifact = await loadPlanArtifact(session.cwd).catch(() => null);
    session.toolContext.activePlan = artifact?.plan ?? "";
    session.toolContext.activePlanApprovedAt = artifact?.approvedAt;
  }
  const planMode = session.toolContext.planMode ?? false;
  // Built-in tools plus whatever the connected MCP servers offer. An MCP tool is
  // dispatched, displayed and gated by exactly the same machinery as a built-in — the
  // merge here and the lookup fallback below are the entire integration.
  let readOnlyTurn = planMode || session.toolContext.readOnlyTools === true;
  // ONE frozen view of the MCP catalog for the whole turn, used for BOTH the advertised
  // list and dispatch. Reading live state twice let a server die (or announce a changed
  // tool list) between the two, so the model could be refused a tool we had just told it
  // it had. It also pins the exact `tools` bytes across the turn's steps, which is what
  // keeps the provider's cached prefix intact while the tool loop runs.
  let mcpTurn = session.toolContext.mcp?.snapshot(readOnlyTurn);
  // Recomputed PER STEP, not once per turn: a large catalog is held behind
  // `find_mcp_tools`, and a tool the model just searched for has to be callable on the
  // very next step or the search was a lie. When nothing is deferred (the common case)
  // this returns identical bytes every step, so the cached prefix is untouched.
  // Rebuilt per step rather than once per turn, because an approved plan LIFTS plan
  // mode mid-turn and the model has to receive the tools it was just granted. When
  // nothing changes this returns identical bytes every step, so the provider's cached
  // prefix is untouched — the same argument that already applies to deferred MCP tools.
  const stepTools = () => {
    const ro = (session.toolContext.planMode ?? false) || session.toolContext.readOnlyTools === true;
    if (ro !== readOnlyTurn) {
      // The MCP catalog is re-snapshotted too, or approving a plan would grant the
      // built-in editing tools while leaving every MCP action hidden until next turn.
      readOnlyTurn = ro;
      mcpTurn = session.toolContext.mcp?.snapshot(ro);
    }
    return [
      ...toolSchemas({
        planMode: session.toolContext.planMode ?? false,
        readOnlyOnly: session.toolContext.readOnlyTools,
        // Deferred native tools appear once find_tools has activated them, and then
        // stay for the session — same sticky contract as the MCP pool above.
        activated: session.toolContext.activatedTools,
        // Lets `relevantWhen` tools (use_skill) check the live session, so a tool with
        // nothing to act on is not advertised and a skill created mid-session brings
        // it back next turn.
        ctx: session.toolContext,
      }),
      ...(mcpTurn?.exposedSchemas() ?? []),
    ];
  };
  const lookup = (name: string) => findTool(name) ?? mcpTurn?.asTool(name);
  const stepLimit = options.maxSteps ?? STEP_BUDGET;
  // Sinks the spawn_subagent tool reuses (it only ever gets the ToolContext, not the
  // Session): fork a scoped child, forward the child's usage to this turn's meter,
  // and share this turn's abort signal so Esc stops a sub-agent too.
  session.toolContext.forkChild = (task, opts) => forkSession(session, task, opts);
  session.toolContext.reportUsage = (u) => options.onEvent?.({ type: "usage", ...u });
  // The raw event sink, so spawn_subagent can surface a child's nested activity
  // (its lifecycle + tagged tool calls) up this same stream instead of running dark.
  session.toolContext.emitEvent = options.onEvent;
  session.toolContext.abortSignal = options.signal;

  // WORKING-DIRECTORY RESET. Each turn starts at the project root — the working
  // directory is already set to the correct project directory automatically. Within a
  // turn cd still persists (so a multi-step command sequence works), but it never
  // carries a stale `cd` into the next
  // turn — the bug where `cd src-tauri` run in two turns became `…/src-tauri/src-tauri`.
  // The primary root (session.cwd) is fixed; only toolContext.cwd moves.
  session.toolContext.cwd = session.cwd;

  // TASK-BOUNDARY SWEEP. If the previous turn finished a task (a todo list completed)
  // and this new message opens a DIFFERENT one (not a "continue"), close the finished
  // task out now — sweep its tool results and status recaps down hard — so a weaker
  // model can't drift back to already-done work. This is the fix for "the model went
  // back to a task from 6 turns ago." Cheap (no model call); the live working set keeps
  // current file content regardless.
  if (session.taskJustCompleted && !isContinuation(lastUserText(session))) {
    const swept = microcompact(session.transcript, KEEP_LAST_N_BOUNDARY);
    if (swept.cleared > 0 || swept.recapsCleared > 0) {
      session.transcript = swept.entries;
      // Silent by design — closing out a finished task is background housekeeping, not
      // something the user should watch scroll by.
    }
  }
  session.taskJustCompleted = false;

  // SESSION MEMORY. At a natural break (turn start), if the transcript has grown enough
  // since the last refresh, update the maintained "state of this session" notes. They
  // live outside the transcript, so compaction never erodes them — which is what lets a
  // session run indefinitely without slowly losing the thread. One cheap call, gated so
  // it fires rarely; degrade-safe.
  await sweepSessionMemory(session, options);

  // Computed once per turn from the current working set (refreshes as reads change
  // across turns); kept tiny to bound per-turn token cost.
  const relevantMap = await relevantMapText(session);
  // Background shells that finished since last turn — surfaced to the model once.
  const bgEvents = await backgroundEventNotes(session);

  // Per-task guards: cost/time ceilings (opt-in) alongside the step budget. Every
  // call's usage is summed so the ceiling reflects the whole task.
  const limits = taskLimits();
  const startedAt = Date.now();
  const usages: Usage[] = [];

  // Verification-gate bookkeeping for this turn: did the model change any file,
  // did it ever run a check, and have we already nudged once (one-shot).
  let mutatedThisTurn = false;
  let verifiedThisTurn = false;
  let verifyNudged = false;
  // Re-scope guard: once the model completes a WHOLE todo list, spinning up a
  // fresh one and pressing on within the same turn is self-assigned scope the user
  // never asked for (the "did the task three times" runaway). This flips true when
  // a todo list is fully completed; a new pending list afterward triggers a pause.
  let completedAList = false;
  // Background-poll guard: consecutive steps that did nothing but poll a still-running
  // background shell. Once past the allowance, stop the wait-loop (the model won't
  // stop on the prose nudge alone). Any step that does real work resets it to 0.
  let bgPollStreak = 0;
  // Repeat-failure breaker: consecutive steps that failed the SAME way (identical error
  // signature). A model can grind the same broken command for dozens of steps; once the
  // streak crosses REPEAT_FAIL_LIMIT we interrupt with the fact that it is repeating
  // itself, and only stop the turn if it does it again afterwards. `repeatFailNudged`
  // resets whenever the failure changes, so each distinct loop gets one interrupt.
  let repeatFailStreak = 0;
  let repeatFailNudged = false;
  // Single edits per file across the whole turn, and whether the batching reminder has
  // already fired. One reminder per turn: it is a nudge, not a rule to enforce twice.
  const singleEditsByFile = new Map<string, number>();
  let batchEditNudged = false;
  // Narration budget: one nudge per turn, and the turn's earlier prose to compare against.
  let narrationNudged = false;
  const narratedBefore: string[] = [];
  // Judged next to the prose, pushed after the tool results — see the gate below.
  let pendingNarrationFault: ReturnType<typeof narrationFault> = null;
  let lastFailSig: string | null = null;
  let lastFailOutput = "";
  // Reply gate: ONE rewrite per turn. `overlongReplyAt` is where the rejected draft sits
  // in the transcript, so it and its instruction can be spliced back out once the
  // rewrite lands — history should hold what the user actually saw, not the draft.
  let replyRegated = false;
  let overlongReplyAt: number | null = null;

  // Seal whatever files this turn edits into one restorable checkpoint (/undo),
  // no matter how the turn ends (finish, pause, interrupt, throw). Labeled with
  // the request that drove it. No-op when nothing was edited.
  const turnLabel = lastUserText(session);
  try {
    const reply = await runTurn();
    // END-OF-TURN sweep. The turn-start check above works one turn behind: it can only
    // see what happened before this turn ran, so a session whose LAST turn did the real
    // work ended with notes that never mentioned it (or none at all). Sweeping here is
    // the "write a note before the session can end" fix, without needing a process-exit
    // hook — a turn boundary is the only moment we reliably get. The token gate means
    // this and the turn-start check can never both fire for the same growth.
    //
    // Deliberately NOT in the `finally`: that path also runs on abort and on throw, and
    // a user pressing Esc should not be charged for a background model call.
    if (!options.signal?.aborted) await sweepSessionMemory(session, options);
    return reply;
  } finally {
    const before = session.toolContext.checkpoints?.list().length ?? 0;
    session.toolContext.checkpoints?.seal(turnLabel);
    // Say that a restore point exists. It was made silently, so `/undo` was a feature
    // you had to already know about — and the moment to learn it is the moment there is
    // something to undo, not after you have lost it.
    const sealed = session.toolContext.checkpoints?.list()[0];
    if (sealed && (session.toolContext.checkpoints?.list().length ?? 0) > before) {
      options.onActivity?.(
        `Checkpoint sealed · ${sealed.files} file${sealed.files === 1 ? "" : "s"} · /undo restores it`,
        { context: true },
      );
    }
  }

  // The turn's model↔tool loop. Kept as a closure so the try/finally above owns
  // every exit path; it reads the flags/usages declared in the enclosing scope.
  async function runTurn(): Promise<string> {
  for (let step = 0; step < stepLimit; step++) {
    if (options.signal?.aborted) return interrupted(session);
    // Stop before another (billable) call if a cost/time ceiling is hit — pause
    // losslessly, exactly like the step budget, so the user can raise it and resume.
    const limitReason = taskLimitReason(summarizeTask(usages, session.modelConfig.model), Date.now() - startedAt, limits);
    if (limitReason) return pauseTask(session, options, `hit the ${limitReason}`);
    await maybeCompact(session, options);

    // The live working set: current contents of the files being worked on, rebuilt
    // each step (so it reflects edits made mid-turn) and injected in the volatile tail.
    // `workingSetFull` lets read_file short-circuit a re-read of a file already shown.
    const workingSet = await buildWorkingSet(session.toolContext);
    session.toolContext.workingSetFull = workingSet.fullPaths;
    session.toolContext.workingSetSpans = workingSet.shownSpans;
    // The other half of "what can the model still see": full reads still sitting in the
    // transcript. Derived here, AFTER any compaction above, so it can never disagree
    // with the bytes this step is about to send. This is what makes a stored presence
    // bit — and the ledger surgery that used to keep one honest — unnecessary.
    session.toolContext.transcriptFull = fullReadPaths(session.transcript, (p) => {
      try {
        return resolvePath(session.toolContext, p);
      } catch {
        return undefined;
      }
    });

    let result: StreamResult;
    // The transcript half of what we are about to send, measured the same way the
    // compaction bars measure it — so the provider's reported total minus this is the
    // real size of everything else in the prompt.
    const sentTranscriptTokens = estimateEntriesTokens(session.transcript);
    const request = buildRequest(
      session,
      relevantMap,
      workingSet.text,
      bgEvents,
      stepTools(),
      await loadImagePayloads(session),
    );
    try {
      result = await streamModel(request, options);
    } catch (error) {
      if (isAbort(error)) return interrupted(session);
      throw error;
    }
    const { content, toolCalls } = result;
    // Every model call's usage counts toward the task total — a task (one turn)
    // may span several calls across tool rounds, and the UI sums them.
    emitUsage(result, options);
    if (result.usage) {
      usages.push(result.usage);
      // Measure, don't guess. The provider just told us exactly how big the prompt was;
      // subtracting the transcript we measured on the way out leaves the fixed overhead
      // the bars were blind to. Recomputed every call, so it tracks a growing tool
      // catalog or working set instead of being a constant someone chose once.
      if (result.usage.promptTokens > 0) {
        session.contextOverhead = {
          tokens: measuredOverhead(result.usage.promptTokens, sentTranscriptTokens),
          model: session.modelConfig.model,
        };
      }
    }

    // The provider can end a turn for reasons that are NOT "finished answering".
    // Without checking, a reply cut off at the output ceiling looks identical to a
    // complete one and the loop carries on with half an answer.
    if (result.stop && result.stop !== "end") {
      const note = stopReasonNote(result.stop);
      if (content.trim()) session.transcript.push({ role: "assistant", content });
      await options.persist?.();
      return pauseTask(session, options, note);
    }

    // No tool calls → the model is done. Record the reply.
    if (toolCalls.length === 0) {
      session.transcript.push({ role: "assistant", content });
      await options.persist?.(); // durable: the reply is on disk before we return
      // Verification gate: it edited files but never checked them. Nudge once and
      // let it continue — a fact-based reminder, not a decision about the code.
      // Live, not the value captured at the top: an approved plan lifts plan mode
      // mid-turn, and the work that follows has to be verified like any other.
      if (VERIFY_GATE && !session.toolContext.planMode && mutatedThisTurn && !verifiedThisTurn && !verifyNudged) {
        verifyNudged = true;
        session.transcript.push({ role: "user", content: VERIFY_NUDGE, synthetic: true });
        continue;
      }

      // Reply gate. The prompt has asked for this budget in three wordings and a model
      // mid-flow still answers a finished job with a page, so here it is enforced rather
      // than requested: the draft is rejected, the model rewrites it, and the rewrite is
      // what the user sees. ONE retry — a gate that can fire twice is a loop.
      if (!replyRegated) {
        const fault = replyFault(content, mutatedThisTurn);
        if (fault) {
          replyRegated = true;
          overlongReplyAt = session.transcript.length - 1; // the draft pushed just above
          session.transcript.push({ role: "user", content: replyRewrite(fault), synthetic: true });
          // The draft has been streaming into the UI's buffer, unrendered. Drop it, or
          // the rewrite would append to it and the user would read both.
          options.onEvent?.({ type: "replyReset" });
          continue;
        }
      }
      // The rewrite landed. Drop the rejected draft and its instruction so what is saved
      // (and resumed, and compacted) is the answer that was actually given.
      if (overlongReplyAt !== null) {
        session.transcript.splice(overlongReplyAt, 2);
        overlongReplyAt = null;
        await options.persist?.();
      }
      return content;
    }

    // Record the assistant's tool request so the conversation stays well-formed.
    const records: ToolCallRecord[] = toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    session.transcript.push({ role: "assistant", content, toolCalls: records });
    // Durable BEFORE running the tools: if the machine dies mid-tool, the resume path
    // sees these dangling tool_calls and reconciles them (reconcileInterruptedTools).
    await options.persist?.();

    // Narration gate, part one: JUDGE here, where this message's prose and the turn's
    // earlier prose are both in hand. Do NOT push anything yet — an assistant message
    // carrying tool_calls must be followed immediately by a tool message per call, and
    // slipping a nudge in between makes the request invalid (DeepSeek 400: "must be
    // followed by tool messages responding to each tool_call_id"). The nudge is queued
    // and pushed after the results land, which is where the other nudges already fire.
    if (!narrationNudged && content.trim()) {
      pendingNarrationFault = narrationFault(content, narratedBefore);
      narratedBefore.push(content);
    }

    // Announce every tool the model chose, in its order, BEFORE running any —
    // the UI's reveal queue paces them and a slow tool (test/run) can show a live
    // "running" state until its end event lands.
    for (const call of toolCalls) {
      options.onEvent?.({ type: "tool", phase: "start", id: call.id, name: call.name, args: parseArgs(call.arguments) });
    }

    // Concurrency-safe calls run in PARALLEL; the rest run one at a time, in order
    // (parallel edits to one file race, and an edit must see the last write). A call
    // is concurrency-safe when the tool says so for THESE args (isConcurrencySafe) —
    // e.g. a read-only sub-agent, which lets the model fan out research — otherwise
    // the default is: read-only ⇒ safe, mutating ⇒ serial.
    const concurrencySafe = (call: (typeof toolCalls)[number]): boolean => {
      const tool = lookup(call.name);
      return tool ? callIsConcurrencySafe(tool, parseArgs(call.arguments)) : false;
    };
    const parallelCalls = toolCalls.filter(concurrencySafe);
    const serialCalls = toolCalls.filter((call) => !concurrencySafe(call));

    const runCall = async (call: (typeof toolCalls)[number]) => {
      // Esc: once the turn is aborted, no further tool may START. The step loop only
      // re-checks BETWEEN steps, so without this gate the rest of a batch still runs
      // after the interrupt — and a `run_in_background` command in that batch would
      // outlive the turn entirely, leaving a process the user thought they cancelled.
      // Placed here, at the single execution choke point, so it covers both the
      // parallel and serial lanes and every tool uniformly.
      if (options.signal?.aborted) {
        return {
          call,
          output: "Not run: the turn was interrupted before this tool started.",
          summary: "interrupted",
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      const tool = lookup(call.name);
      if (!tool) {
        // A name the model invented. The row renders as "Unknown tool(index_results)"
        // (see toolDisplay), and the model gets the near misses so it can correct on
        // the next step instead of guessing again at a bare "unknown tool".
        // Built-ins only: an MCP tool is always `mcp__server__tool`, which is never a
        // near miss for a plain name, so including them would only add noise.
        return { call, output: unknownToolError(call.name, TOOLS.map((t) => t.name)), summary: `unknown tool '${call.name}'`, isError: true, detail: undefined as string | undefined, fullContentOf: undefined as string | undefined };
      }
      // Belt-and-suspenders for plan mode: the schema filter already hides mutating
      // tools, but if the model calls one anyway, refuse it instead of running it.
      // Live, not the captured value. Reading the stale one here would refuse the
      // editing tools the user had just approved, for the rest of the turn.
      if (session.toolContext.planMode && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but you're in plan mode. Present your plan instead; the user will approve and switch out of plan mode to carry it out.`,
          summary: `blocked in plan mode`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // A read-only sub-agent: same schema-hiding + refusal, without the plan framing.
      if (session.toolContext.readOnlyTools && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but this sub-agent is read-only. Report your findings instead.`,
          summary: `blocked (read-only sub-agent)`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // Sentinel mode: confirm every mutating action with the human first. Gated
      // here (the single execution choke point) so it covers every mutating tool
      // uniformly — including subagent edits. Fails safe: no approval channel, or an
      // unclear answer, refuses rather than runs.
      const ctx = session.toolContext;
      if (!tool.readOnly && ctx.guarded && !ctx.guardAllowAll) {
        const args = parseArgs(call.arguments);
        // The question is one line; WHAT is about to happen rides as detail, which the
        // CLI prints into the transcript. A gate the user cannot read is a gate they
        // learn to wave through.
        const choice = ctx.requestApproval
          ? await ctx.requestApproval(guardQuestion(), [...GUARD_OPTIONS], guardDetail(call.name, args), "Permission Request")
          : undefined;
        const decision = interpretGuardChoice(choice);
        if (decision === "refuse") {
          return { call, output: GUARD_REFUSAL, summary: `declined ${call.name}`, isError: true, detail: undefined as string | undefined };
        }
        if (decision === "allow-all") ctx.guardAllowAll = true;
      }
      const result = await tool.execute(parseArgs(call.arguments), session.toolContext);
      return {
        call,
        output: result.output,
        summary: result.summary,
        isError: result.isError,
        detail: result.detail,
        detailKind: result.detailKind,
        quiet: result.quiet,
        fullContentOf: result.fullContentOf,
        images: result.images,
        displayKind: result.displayKind,
        displayName: result.displayName,
      };
    };

    // Emit each tool's END the instant IT finishes — not batched after the whole
    // turn — so the UI can resolve that row promptly (and show it already-expanded
    // rather than a header that pops its output in later). Transcript order is still
    // the model's call order (the sort below); only the UI events go out eagerly.
    const runAndEmit = async (call: (typeof toolCalls)[number]) => {
      const r = await runCall(call);
      options.onEvent?.({
        type: "tool",
        phase: "end",
        id: r.call.id,
        name: r.call.name,
        summary: r.summary ?? r.call.name,
        error: r.isError ?? false,
        detail: r.detail,
        ...(r.detailKind ? { detailKind: r.detailKind } : {}),
        ...(r.quiet ? { quiet: true } : {}),
        ...(r.displayKind ? { displayKind: r.displayKind } : {}),
        ...(r.displayName ? { displayName: r.displayName } : {}),
      });
      return r;
    };
    const results = await Promise.all(parallelCalls.map(runAndEmit));
    for (const call of serialCalls) {
      results.push(await runAndEmit(call));
    }
    // Hand results back in the model's original call order (start events were emitted
    // in that order too), no matter which lane each call ran in.
    const callOrder = new Map(toolCalls.map((c, i) => [c.id, i]));
    results.sort((a, b) => (callOrder.get(a.call.id) ?? 0) - (callOrder.get(b.call.id) ?? 0));

    // Track the verification-gate facts: a successful edit/write to a file with a
    // runtime surface counts as a mutation that needs checking — a docs-only edit
    // (MINDWEAVE.md, a README) does NOT, so the gate never fires on it. A diagnostics/
    // build/test check counts ONLY when it PASSED. A failing check (non-zero exit /
    // isError) is not verification — it means work remains, so the gate must stay
    // unsatisfied and nudge again rather than let a red build finish.
    for (const r of results) {
      if (!r.isError && mutationNeedsVerification(r.call.name, parseArgs(r.call.arguments))) mutatedThisTurn = true;
      if (!r.isError && isVerification(r.call.name, parseArgs(r.call.arguments))) verifiedThisTurn = true;
      // A write to MINDWEAVE.md means the frozen copy in the cached system prompt is
      // behind the file. Noted, NOT acted on: re-reading it here would rewrite the
      // system prompt string and throw away the whole cached prefix mid-turn. The
      // model just wrote the content so it already has it; the prefix catches up at
      // the next compaction, where the cache is being discarded anyway.
      if (!r.isError && touchesProjectMemory(r.call.name, parseArgs(r.call.arguments))) {
        session.projectMemoryStale = true;
      }
    }

    for (const result of results) {
      // The end event already went out eagerly (runAndEmit) the moment this tool
      // finished; here we only record it into the transcript, in call order.
      session.transcript.push({
        role: "tool",
        toolCallId: result.call.id,
        content: result.output,
        // Display fields, stored so a resumed session replays the exact same row
        // (summary line + diff/detail). Ignored when building the wire request.
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.isError ? { isError: true } : {}),
        // Presence, as recorded by the tool that knows: this result IS the whole
        // content of that file. Not display — the presence derivation reads it.
        ...(result.fullContentOf ? { fullContentOf: result.fullContentOf } : {}),
      });
    }
    await options.persist?.(); // durable: tool results recorded, transcript well-formed

    // Images a tool produced (screenshot) reach the model HERE, as a following user
    // message, rather than inside the tool result. Two reasons, both hard:
    //
    //  1. Wire compatibility. An image inside a tool-result message is fine on
    //     Anthropic and rejected by OpenAI-compatible providers, which is most of
    //     the driver folders. A user message with images is the one shape every
    //     provider already takes — the same path a user's `@file` attachment uses,
    //     so it inherits payload loading, eviction, and token accounting for free.
    //  2. Ordering. Nothing may sit between an assistant's tool_calls and their
    //     results, so this runs after the loop above, where the other queued pushes
    //     already land (a nudge slipped in mid-run once broke every tool-calling
    //     turn on DeepSeek).
    //
    // Whether the picture is SENT or merely named is core's call, made once from a
    // fact the manifest states — a tool never asks which provider is running.
    const shots = results.flatMap((r) => r.images ?? []);
    if (shots.length > 0) {
      const canSee = manifestForModel(session.modelConfig.model).acceptsImages?.(session.modelConfig.model) ?? false;
      const names = shots.map((i) => basename(i.path)).join(", ");
      session.transcript.push({
        role: "user",
        content: canSee
          ? `Here ${shots.length === 1 ? "is the image" : "are the images"} just captured (${names}).`
          : `${names} was captured and saved, but this model cannot see images, so you are ` +
            `being told about it rather than shown it. Describe what you expected to verify ` +
            `and ask the user what they see, or switch to a model with vision using /model.`,
        synthetic: true,
        ...(canSee ? { images: shots } : {}),
      });
      await options.persist?.();
    }

    // Re-scope guard. A todo_write that clears the list ("all tasks completed")
    // marks a natural stopping point: the requested work is done. If the model
    // then opens a NEW list of pending work in the same turn, it's taking on scope
    // the user didn't ask for — pause losslessly here and hand the wheel back,
    // rather than letting it rebuild the same thing over and over (a weaker model
    // won't self-stop the way a stronger one does; this is the deterministic
    // backstop for that). The decision is a pure fn (verify.ts) so it's unit-tested.
    const reScope = reScopeCheck(
      completedAList,
      results.map((r) => ({ name: r.call.name, summary: r.summary })),
      session.toolContext.todos,
    );
    completedAList = reScope.completed;
    // Remember, for the NEXT turn's boundary sweep, that a task just finished here.
    session.taskJustCompleted = reScope.completed;
    if (reScope.pause) return pauseReScope(session, options);

    // Background-poll guard. A still-running shell's completion is pushed to the model
    // automatically, so polling it in a loop is pure waste and reads as spam ("still
    // compiling… let me check again", over and over). Allow a single informative poll,
    // then stop the wait-loop here — deterministically, because a weaker model doesn't
    // stop on the prose nudge in the tool result. Nothing is lost: when the shell
    // finishes, backgroundEventNotes wakes the model to report it.
    if (isBackgroundPollStep(results.map((r) => ({ name: r.call.name, summary: r.summary })))) {
      bgPollStreak++;
      if (bgPollStreak > BG_POLL_ALLOWANCE) return pauseForBackgroundPoll(session, options);
    } else {
      bgPollStreak = 0;
    }

    // Repeat-failure breaker. If this step failed exactly the way the last one(s) did —
    // same tools, same error — the model is stuck grinding a broken command instead of
    // changing course. Keyed on the error MESSAGE, so a run of near-identical commands
    // that all fail the same way still trips it.
    //
    // The first trip does NOT end the turn. Nothing in the conversation tells the model
    // it is repeating itself, so ending there would kill it for something it could not
    // see. Instead we inject that fact (with the shell's real cwd, the usual culprit)
    // and let it diagnose. Repeat it after being told and the turn stops for real.
    const failSig = stepFailureSignature(
      results.map((r) => ({ name: r.call.name, output: r.output, isError: !!r.isError })),
    );
    if (failSig) {
      if (failSig === lastFailSig) {
        repeatFailStreak++;
      } else {
        // A different failure is a different loop: it gets its own interrupt.
        repeatFailStreak = 1;
        repeatFailNudged = false;
      }
      lastFailSig = failSig;
      const failed = results.find((r) => r.isError);
      lastFailOutput = failed?.output ?? "";
      const action = repeatFailureStep(repeatFailStreak, REPEAT_FAIL_LIMIT, repeatFailNudged);
      if (action === "stop") return pauseForRepeatedFailure(session, options, lastFailOutput);
      if (action === "nudge") {
        repeatFailNudged = true;
        const failedLabel = failed
          ? failedActionLabel(failed.call.name, parseArgs(failed.call.arguments))
          : "the same step";
        // A repeat failure DURING an approved plan is the mechanical divergence
        // signal: the agreed step is not working. The interrupt then orders a stop
        // and a return to planning, never a sideways improvisation — that is the
        // plan contract, enforced at the one point the engine can detect it.
        const inApprovedWork =
          !!session.toolContext.activePlan && !(session.toolContext.planMode ?? false);
        session.transcript.push({
          role: "user",
          content: inApprovedWork
            ? planDivergenceStop(failedLabel)
            : repeatFailureNudge({
                attempts: repeatFailStreak,
                action: failedLabel,
                error: firstErrorLine(lastFailOutput),
                // Only when `cd` has actually moved us — otherwise it's noise.
                cwd: session.toolContext.cwd !== session.cwd ? session.toolContext.cwd : undefined,
              }),
          synthetic: true,
        });
        await options.persist?.();
      }
    } else {
      repeatFailStreak = 0;
      lastFailSig = null;
      repeatFailNudged = false;
    }

    // Batching gate: it keeps editing ONE file a single change at a time, where one
    // edit call belonged. Mechanical rather than a line in the tool description,
    // because the same task with the same descriptions routes correctly on one run and
    // not the next — prose biases a choice, it cannot make it hold, and this has to hold
    // on every provider. Nudge once and let the turn continue; nothing is blocked, since
    // the edits themselves are perfectly valid.
    // Narration gate, part two: the results are in, so the transcript is valid again
    // and the queued nudge can land. One per turn; nothing is blocked and nothing the
    // user already read is rewritten behind them.
    if (!narrationNudged && pendingNarrationFault) {
      narrationNudged = true;
      session.transcript.push({ role: "user", content: narrationNudge(pendingNarrationFault), synthetic: true });
      pendingNarrationFault = null;
      await options.persist?.();
    }

    if (!batchEditNudged) {
      for (const [path, n] of sameFileEditCounts(
        results.map((r) => ({ name: r.call.name, args: parseArgs(r.call.arguments) })),
      )) {
        singleEditsByFile.set(path, (singleEditsByFile.get(path) ?? 0) + n);
      }
      const overused = overusedSingleEdits(singleEditsByFile);
      if (overused) {
        batchEditNudged = true;
        session.transcript.push({
          role: "user",
          content: batchEditNudge(overused, singleEditsByFile.get(overused) ?? 0),
          synthetic: true,
        });
        await options.persist?.();
      }
    }
  }

  // Step ceiling reached without the model finishing. Don't spend another call
  // forcing a (misleading) wrap-up the way a tools-off final turn would — that
  // reads as "done" when it isn't. Pause cleanly instead: the transcript, task
  // list, and working set are all intact, so telling Mindweave to continue resumes
  // exactly here with nothing lost, and the user stays in control of the spend.
  return pauseTask(session, options, `reached the step budget of ${stepLimit} tool steps in one turn`);
  }
}

/** The most recent user request in the transcript, clipped — labels a checkpoint. */
function lastUserText(session: Session): string {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const e = session.transcript[i]!;
    if (e.role === "user") {
      const oneLine = e.content.replace(/\s+/g, " ").trim();
      return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
    }
  }
  return "(edits)";
}

/**
 * End the turn with a message, recording it AND putting it on the wire.
 *
 * The emit is the point. A normal reply reaches the screen as `text` events while
 * the model streams it; a pause message is composed here, after streaming, so it
 * has no such path of its own. Without this the transcript and the next model turn
 * both get the explanation while the user gets a turn that just ends, blank — which
 * is exactly how a tripped guard came to look like a crash.
 *
 * respond()'s return value is deliberately not what the UI renders: sub-agents call
 * respond() directly and use the return as their report, with no UI attached at all.
 */
function endTurnWith(session: Session, options: RespondOptions, msg: string): string {
  session.transcript.push({ role: "assistant", content: msg });
  options.onEvent?.({ type: "text", delta: msg });
  return msg;
}

/** Lossless hand-back when the model finishes its task list and then starts a new
 *  one in the same turn (the re-scope guard) — a natural checkpoint to let the user
 *  steer instead of the model taking on scope it wasn't asked for. */
function pauseReScope(session: Session, options: RespondOptions): string {
  return endTurnWith(
    session,
    options,
    "(I've finished the task list for what you asked. I have ideas for taking it " +
      "further, but I've stopped here so you can steer — rather than piling on new scope " +
      'on my own. Tell me which direction you want, or say "keep going" to continue.)',
  );
}

/** Lossless stop when the model is stuck polling a still-running background shell.
 *  The shell's completion is pushed to the model automatically, so there's nothing
 *  to do but wait — end the turn cleanly instead of looping "still running" checks.
 *  Deliberately worded as a status line to the user, not a "paused" apology. */
function pauseForBackgroundPoll(session: Session, options: RespondOptions): string {
  return endTurnWith(
    session,
    options,
    "It's still running in the background. I'll stop checking and let you know as soon " +
      "as it finishes — no need to keep watching.",
  );
}

/** Lossless stop when the model repeats the same failing step even AFTER being told it is
 *  looping (the breaker's second tier). By this point it has had the error, the repeat
 *  count, and its real working directory, and it still hasn't moved — so hand the wheel
 *  to the user rather than spend more steps on it. */
function pauseForRepeatedFailure(session: Session, options: RespondOptions, errorOutput: string): string {
  return endTurnWith(
    session,
    options,
    `I've hit the same failure several times in a row and I'm not making progress, so I've ` +
      `stopped rather than retry the same thing again. The error was:\n\n${firstErrorLine(errorOutput)}\n\n` +
      `Tell me how you'd like to proceed, or I can try a different approach.`,
  );
}

/** Record and return a clean, lossless pause reply (well-formed transcript) when a
 *  guard trips — step budget or a cost/time ceiling. Saying "continue" resumes. */
function pauseTask(session: Session, options: RespondOptions, reason: string): string {
  return endTurnWith(
    session,
    options,
    `(Paused — ${reason}. The task isn't finished, but nothing is lost: your progress, ` +
      `edits, and task list are saved. Say "continue" to pick up exactly where I left off.)`,
  );
}

/**
 * Plain-language reason a turn ended early, for the pause message. Kept here (not
 * in a driver) because it's user-facing copy: every provider maps its own
 * vocabulary onto the shared StopReason, and the wording is the same either way.
 */
export function stopReasonNote(stop: Exclude<StopReason, "end">): string {
  switch (stop) {
    case "truncated":
      return "the model hit its output limit mid-answer, so the reply above is incomplete";
    case "refused":
      return "the provider's safety filter declined this request";
    case "overflow":
      return "the conversation no longer fits the model's context window";
    case "overloaded":
      return "the provider's infrastructure cut the request off before it finished, so the reply above is incomplete";
  }
}

/** One streaming model call: forwards the model's reasoning/answer deltas to the
 *  UI as engine events, and returns the assembled turn (content + tool calls +
 *  usage) for the loop to record. */
function streamModel(request: ModelRequest, options: RespondOptions): Promise<StreamResult> {
  return activeDriver().streamTurn(request, {
    signal: options.signal,
    onEvent: (e) => {
      if (e.type === "reasoning") options.onEvent?.({ type: "reasoning", delta: e.delta });
      else if (e.type === "text") options.onEvent?.({ type: "text", delta: e.delta });
      // tool_start / tool_args deltas are not forwarded: the engine emits richer
      // tool events (with parsed args + result summary) around execution instead.
    },
  });
}

/** Report a turn's token usage to the UI, if the provider returned it. */
function emitUsage(result: StreamResult, options: RespondOptions): void {
  if (result.usage) {
    options.onEvent?.({ type: "usage", ...result.usage });
  }
}

/**
 * Run the compaction cascade if the transcript has grown enough: microcompact
 * (lossless) first, then autocompact (a summary) if still over the higher bar.
 */
/**
 * Refresh the maintained "state of this session" notes if the transcript has grown
 * enough since the last refresh. They live outside the transcript, so compaction never
 * erodes them — which is what lets a session run indefinitely without losing the thread,
 * and what a later `read_session` reads to answer "what did we do last time".
 *
 * Called at BOTH turn start (so this turn's context carries current notes) and turn end
 * (so the last turn of a session is never missing from them). One cheap call, token-gated
 * so it fires rarely and never twice for the same growth. Silent by design: this is
 * background machinery, not something the user watches. Degrade-safe — a failed update
 * keeps the last good notes.
 */
async function sweepSessionMemory(session: Session, options: RespondOptions): Promise<void> {
  const grown = shouldUpdateSessionMemory(
    estimateEntriesTokens(session.transcript),
    session.sessionMemoryTokens ?? 0,
    session.sessionMemoryInit ?? false,
  );
  if (!grown) return;
  await updateSessionMemory(session);
  await options.persist?.(); // durable: the notes sidecar is written by the persister
}

/**
 * How much of the context window is in use, in tokens.
 *
 * ONE definition, because two would be worse than none: the compaction thresholds fire
 * on this number and the bars shown to the user are drawn from it, so if the estimate
 * is off, the display is wrong in exactly the way the decision was — rather than
 * disagreeing with the machinery it is supposed to explain.
 *
 * Everything outside the transcript counts too, because this is about how full the
 * CONTEXT is, not how long the transcript is. Once a call has reported usage we know
 * that overhead exactly (system prompt + every tool schema + working set + relevance
 * map + todos + governor); until then, fall back to the one piece we could always
 * estimate. MCP schemas are inside the measured figure, so they are only added in the
 * fallback — counting both would double them.
 *
 * A measurement taken on a DIFFERENT model does not transfer: switching provider
 * changes the tool-schema serialisation and the prompt shape. Falling back is the safe
 * direction — it under-counts for one call, which fires the bars early rather than
 * late, and the next call re-measures.
 */
function contextUsed(session: Session): number {
  const measured = session.contextOverhead;
  const overhead =
    measured && measured.model === session.modelConfig.model
      ? measured.tokens
      : (session.toolContext.mcp?.estimatedTokens() ?? 0);
  return estimateEntriesTokens(session.transcript) + overhead;
}

async function maybeCompact(session: Session, options: RespondOptions): Promise<void> {
  const model = session.modelConfig.model;
  // Model-anchored bars (env still overrides), so the thresholds are right per model
  // instead of a fixed number — and a longer/stronger model automatically gets more room.
  const microBar = envInt("MINDWEAVE_MICROCOMPACT_TOKENS", microCompactThreshold(model));
  const autoBar = envInt("MINDWEAVE_AUTOCOMPACT_TOKENS", autoCompactThreshold(model));

  // MCP tool schemas are sent on every turn but live OUTSIDE the transcript, so the bars
  // could not see them: a 30K-token catalog meant the model was 30K deeper into its real
  // context than this arithmetic believed, and every threshold fired that much too late.
  // Counting it here restores the meaning of the bars — they are about how full the
  // context is, not how long the transcript is.
  // Everything outside the transcript counts too, because the bars are about how full
  // the CONTEXT is, not how long the transcript is. Once a call has reported usage we
  // know that overhead exactly (system prompt + every tool schema + the working set
  // block + relevance map + todos + governor); until then, fall back to the one piece
  // we could always estimate. MCP schemas are inside the measured figure, so they are
  // only added in the fallback — counting both would double them.
  //
  // A measurement taken on a DIFFERENT model does not transfer: switching provider
  // changes the tool-schema serialisation and the prompt shape. Falling back is the
  // safe direction — it under-counts for one call, which fires the bars early rather
  // than late, and the next call re-measures.
  const used = () => contextUsed(session);

  if (used() >= microBar) {
    // Assigned unconditionally, on purpose. Gating this on a hand-picked subset of the
    // counters meant a pass that only cleared edit INPUTS or only evicted IMAGES did the
    // work and then threw the result away, and every new kind of clearing had to
    // remember to add itself here or be silently discarded. `microcompact` already
    // returns a copy when it changed nothing, so taking the result always is both
    // correct and the shape that cannot rot.
    // `workingSetFull` is the set of files the <working_files> block is currently
    // carrying WHOLE. Their transcript copies are the redundant half of a double
    // representation, so this pass is allowed to clear them even inside the recent
    // window that is otherwise protected — the model still sees them, fresher, at the
    // boundary. Empty on the first step of a session, which is correct: nothing has
    // been superseded yet.
    session.transcript = microcompact(
      session.transcript,
      undefined,
      session.toolContext.workingSetFull,
    ).entries;
    // Silent by design — trimming stale context is background machinery.
  }
  // Circuit-breaker: once autocompact has failed MAX_COMPACT_FAILURES times this
  // session, stop trying (the transcript is likely irrecoverable) rather than burning
  // a doomed summarizer call every turn.
  if (used() >= autoBar && (session.compactFailures ?? 0) < MAX_COMPACT_FAILURES) {
    await autocompact(session, options);
  }
}

/**
 * Force a full summarizing compaction now (the `/compact` command), regardless
 * of size. Safe on a short transcript — it just summarizes what's there.
 */
export async function compactNow(session: Session, options: RespondOptions = {}): Promise<void> {
  await autocompact(session, options);
}

/**
 * Replace the old prefix of the transcript with a 9-section summary, keep the
 * last N turns verbatim, then re-read the working-set files so nothing the model
 * was mid-edit on is lost. The one model call here is small relative to
 * DeepSeek's 1M window (the transcript triggered at ~90K), so — unlike agents on
 * a ~200K model — there's no prompt-too-long risk to retry around.
 */
async function autocompact(session: Session, options: RespondOptions): Promise<void> {
  if (session.transcript.length === 0) return;
  // Measured BEFORE the summarizer runs, with the same arithmetic the thresholds use,
  // so the bar the user sees is the number the system actually acted on.
  const before = contextUsed(session);

  const fail = () => {
    // Keep the full transcript rather than lose it, and count the failure so the
    // circuit-breaker can stop retrying a doomed compaction. EVERY rejection counts,
    // not just a thrown error: a summarizer that keeps returning something unusable
    // burns a model call on every step forever, which is the exact runaway the
    // breaker exists to stop.
    session.compactFailures = (session.compactFailures ?? 0) + 1;
  };

  let summary: string;
  try {
    // Summaries don't need reasoning — use the chosen model with thinking off.
    const turn = await activeDriver().toolTurn({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `${formatTranscriptForSummary(session.transcript)}\n\n${SUMMARY_REQUEST}` }],
      model: { ...session.modelConfig, thinking: false },
    });
    // The reply is untrusted: a cut-off or all-scratchpad summary must not be allowed
    // to replace the conversation. See usableSummary.
    // Compaction is not free, and the user did not ask for it. Reporting its usage
    // is what keeps the meter honest: a turn that happened to trip the bar spends
    // a whole extra summarisation call, and leaving that out made the figure short
    // by exactly the work nobody could see.
    if (turn.usage) options.onEvent?.({ type: "usage", ...turn.usage });
    const usable = usableSummary(turn.content, turn.stop);
    if (!usable) return void fail();
    summary = usable;
  } catch {
    return void fail();
  }
  session.compactFailures = 0; // a clean compaction resets the breaker

  // No explicit post-summary re-read needed: the live working set (buildWorkingSet)
  // injects the current contents of the files being worked on in the volatile tail
  // every step, so nothing the model was mid-edit on is lost across the summary.
  session.transcript = spliceSummary(session.transcript, summary, KEEP_LAST_N);

  // Report it. Compaction is the one context operation worth showing: it REWRITES the
  // conversation, so a user who is not told will later wonder why the model forgot the
  // middle of it. Reported for the automatic pass as well as `/compact`.
  options.onCompaction?.({
    before,
    after: contextUsed(session),
    window: sharpContextWindow(session.modelConfig.model),
  });

  // A compaction rewrites the transcript, so any MINDWEAVE.md edit the model was
  // relying on having written is now summarized away — and the prompt cache is being
  // discarded for this request regardless. Both reasons point the same way: this is
  // the moment to pick the file back up, and it costs nothing extra here.
  await reloadProjectMemory(session).catch(() => {});
}

/**
 * Did this call write the project's MINDWEAVE.md?
 *
 * Matched on the path's basename rather than resolved against the session root: the
 * model may pass it relative, absolute, or through a workspace root, and the cost of a
 * false positive is one extra re-read at the next compaction, while the cost of a false
 * negative is a stale project memory carried into the next session.
 */
function touchesProjectMemory(name: string, args: Record<string, unknown>): boolean {
  if (name !== "edit" && name !== "write_file" && name !== "replace_symbol_body") return false;
  const path = typeof args.path === "string" ? args.path : "";
  return /(^|[\\/])MINDWEAVE\.md$/i.test(path.trim());
}

/** Parse a tool call's raw JSON arguments; malformed payload → {} so the tool
 *  returns its own clear error rather than crashing the loop. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
