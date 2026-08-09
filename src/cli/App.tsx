/**
 * App — the terminal UI shell (the "eyes and hands" of Mindweave).
 *
 * The transcript is a pure state machine (transcript.ts): a `committed` list
 * (append-only → Ink <Static> → terminal scrollback, printed once) and a live
 * `tail` (the block currently streaming + any running tool). A block drains from
 * tail → committed the instant it and every earlier block is done. That keeps the
 * live-rendered region TINY, which is what gives smooth scrolling, a pinned
 * prompt, and no redraw jank — and it lets streamed text reveal WHOLE (tokens
 * accumulate silently; the block appears at once when it seals), never typewriter.
 *
 * The UI owns the session for the whole conversation: it creates one on startup,
 * appends each user turn to its transcript, asks the dynamo (engine) for a reply,
 * and persists after every turn. It still knows nothing about any provider, prompts,
 * or compaction internals — it calls `respond()` / `compactNow()` and renders the
 * stream events they emit.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { isAbsolute, resolve } from "node:path";
import { Box, Static, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { compactNow, respond } from "../dynamo/engine.js";
import { createSession, resumeSession, reloadProjectMemory } from "../memory/session.js";
import { saveSession, listSessions } from "../memory/store.js";
import { stopChassis } from "../alternator/lane.js";
import { findSkill, loadSkillBody, substituteSkillArgs } from "../governor/skills.js";
import { appendForbidden, appendForbiddenCommand } from "../governor/write.js";
import { addRoot, removeRoot } from "../tools/workspace.js";
import { discoverRelatedRoots } from "../tools/workspaceDiscover.js";
import { rootLabel, rootsOf, relativize } from "../tools/paths.js";
import { APPROVAL_DISMISSED } from "../tools/approval.js";
import { parseUndoArg, undoNotice } from "../tools/checkpoints.js";
import { DEFAULT_MODEL_CONFIG, thinkLevels, thinkLabel, modelLabel, modelsOf, providerOf, usableFallback, withModel, saveModelConfig } from "../dynamo/model.js";
import { allProviders, manifestForModel } from "../drivers/registry.js";
import { resolveAttachments, stripAttachments } from "./attachments.js";
import { completePath } from "./pathComplete.js";
import { formatHelp } from "./help.js";
import { hasApiKey, saveApiKey, globalEnvPath } from "./bootstrap.js";
import { versionLabel } from "./version.js";
import { PromptInput } from "./components/PromptInput.js";
import { Picker } from "./components/Picker.js";
import { BlockView } from "./components/BlockView.js";
import { initialState, reduce, trimNarration, type Action, type Block, type TranscriptState } from "./transcript.js";
import { planToolReveal, TOOL_GRACE_MS } from "./reveal.js";
import { toolDisplay, isGroupable } from "./toolDisplay.js";
import { summarizeTask, formatTokens, type TaskUsage } from "../dynamo/pricing.js";
import type { Usage } from "../drivers/types.js";
import type { ShellInfo } from "../tools/backgroundShells.js";
import type { ConnectionStatus as McpStatus } from "../mcp/connection.js";
import { addServerToConfig, configPathFor, parseAddSpec, removeServerFromConfig, splitArgs } from "../mcp/configWrite.js";
import { mapPromptArguments, parsePromptCommand, promptCommand, promptUsage } from "../mcp/prompts.js";
import type { Entry, Session, SessionMeta } from "../memory/types.js";
import { DEFAULT_MODE, modeById, modeFromFlags, nextMode, type ModeId } from "./modes.js";

const MINDWEAVE_DOCS_URL = "https://mindweave.dev";

/**
 * The provider whose key we're missing, and what to tell the user about it.
 *
 * `pending` is the switch this key would unlock. Its presence is also what makes the
 * prompt escapable: a first-run gate has nothing behind it, but a gate reached by
 * choosing a provider does — the session you were already in.
 */
type KeyNeed = {
  envVar: string;
  label: string;
  keysUrl: string;
  pending?: { model: string; providerLabel: string };
};

/**
 * The key a model needs, or null if we already have it. Each provider declares
 * its own variable name and key page, so this stays correct as providers are
 * added — nothing here names a provider.
 */
function missingKeyFor(model: string): KeyNeed | null {
  const provider = manifestForModel(model);
  if (hasApiKey(provider.apiKeyEnv)) return null;
  return { envVar: provider.apiKeyEnv, label: provider.label, keysUrl: provider.keysUrl };
}

/**
 * An interactive overlay that temporarily takes over the keyboard (rendered as a
 * Picker below the transcript). `sessions` resumes a past chat; `model`/`think`
 * choose the model + reasoning; `approval` is the forbidden-path Yes/No/other
 * prompt, carrying the promise resolver the blocked tool is awaiting.
 */
type Overlay =
  | { kind: "sessions"; items: SessionMeta[] }
  | { kind: "resumeMode"; meta: SessionMeta }
  | { kind: "provider" }
  | { kind: "model" }
  | { kind: "think" }
  | { kind: "shells"; items: ShellInfo[] }
  | { kind: "mcp"; items: McpStatus[] }
  | { kind: "approval"; question: string; options: string[]; resolve: (choice: string) => void };

// After you pick a session in /continue, the three ways to resume it.
const RESUME_MODES = [
  { label: "Compact & continue", description: "summarize the old chat first so it won't eat your context, then pick up where you left off" },
  { label: "Continue as-is", description: "resume the full conversation unchanged" },
  { label: "Fresh start", description: "leave it and start a new empty session here instead" },
];

export function App() {
  // The transcript state machine lives in a ref and is advanced by the reducer as
  // the stream arrives; `render` forces a paint. A ref (not useState) so the async
  // streaming loop always reads/writes the latest state without stale closures.
  const stateRef = useRef<TranscriptState>(initialState());
  const [, render] = useReducer((n: number) => n + 1, 0);
  const dispatch = (action: Action) => {
    stateRef.current = reduce(stateRef.current, action);
    render();
  };
  // Apply WITHOUT a repaint — for streamed text tokens: they accumulate silently
  // (the assistant block shows nothing until it seals, by design — whole-block
  // reveal, never typewriter), so painting per token is pure churn (the thing that
  // made the old version glitch). The next real event (tool/seal) paints and picks
  // up the accumulated text.
  const applySilent = (action: Action) => {
    stateRef.current = reduce(stateRef.current, action);
  };

  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Interaction mode (Lightning / Architect), cycled with shift-tab. The ref
  // mirrors the state so the async streaming loop and session setup read the
  // latest without a stale closure; `planMode` on the toolContext is the single
  // flag the engine actually acts on (set by applyMode / attachApproval).
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);
  const modeRef = useRef<ModeId>(DEFAULT_MODE);
  // Turn timing for the status line: when the current turn started, how long the
  // last one took, the token count, and which whimsical verb-pair this turn uses.
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [taskUsage, setTaskUsage] = useState<TaskUsage | null>(null);
  const turnStart = useRef<number | null>(null);
  // Token accounting for the status line. A task (one turn) may span several model
  // calls; we keep each call's REAL usage and fold it into a meaningful summary
  // (context size + cache-aware cost), not a raw sum of re-sent context — that sum
  // counted the cached prefix once per step and made every task look like ~700K.
  // Nothing is shown while working: mid-stream counts aren't reliable, and a
  // provider may not report usage until the turn ends.
  const usageSamples = useRef<Usage[]>([]);
  // Aborts the in-flight turn when the user presses Esc (created fresh per turn).
  const abortRef = useRef<AbortController | null>(null);
  // Which provider's key we still need, or null once we have it. Not a bare
  // boolean: with more than one provider, the key we must ask for depends on the
  // model the user is about to run, and switching models can make a different key
  // become the missing one.
  const [keyNeed, setKeyNeed] = useState<KeyNeed | null>(() => missingKeyFor(DEFAULT_MODEL_CONFIG.model));
  const needsKey = keyNeed !== null;
  // The key the user is typing on the welcome screen.
  const [keyInput, setKeyInput] = useState("");
  // Sent-message history, oldest-first — walked with ↑/↓ in the input.
  const [history, setHistory] = useState<string[]>([]);
  // Messages typed while Mindweave is working — queued, then sent in order when the
  // turn ends; the input stays live while busy.
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  // An interactive overlay (session picker, model/think chooser, or an approval
  // prompt). When set, it owns the keyboard and the input box is hidden.
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  // The approval channel handed to tools: a forbidden-path tool calls this to ask
  // the user Yes/No/other, and we render it as an overlay that resolves the promise.
  // A ref so the function injected into a session's tool context always reaches the
  // current setOverlay (and survives session swaps on /continue).
  const askApproval = useRef((question: string, options: string[]) =>
    new Promise<string>((resolve) => setOverlay({ kind: "approval", question, options, resolve })),
  );
  // Bumped whenever a background shell starts/finishes, to re-render the indicator.
  const [bgTick, setBgTick] = useState(0);
  // Guards the idle auto-react so a flurry of changes can't kick overlapping turns.
  const reactingRef = useRef(false);

  // ── Transcript helpers ──────────────────────────────────────────────────────
  // A dim meta line (a tool-less note / command header); `error` flags it red,
  // `context` sets it off as housekeeping (compaction / context trimming).
  const note = (text: string, opts?: { error?: boolean; context?: boolean }) =>
    dispatch(
      opts?.context ? { type: "context", text } : opts?.error ? { type: "error", text } : { type: "note", text },
    );
  // A spoken block: a ⚠-prefixed line is an error, everything else is markdown.
  const say = (text: string) => dispatch(text.startsWith("⚠") ? { type: "error", text } : { type: "say", text });
  // Alias kept so the command handlers below read unchanged.
  const addTool = note;

  // Rebuild the visible transcript from a (resumed) session by replaying it through
  // the SAME reducer actions the live stream uses — so a resumed chat shows the
  // exact rows it did before: user/assistant prose, every `● Tool(arg)` with its
  // `⎿` result/diff, the consolidated discovery groups, and a marker where context
  // was summarized. The tool display fields (summary/detail/isError) were stored on
  // each tool entry at run time, so nothing about a row is lost across a resume.
  function showResumed(transcript: Entry[]) {
    for (const e of transcript) {
      if (e.role === "user") {
        // Engine nudges ride as `user` messages so the model reads them as instruction,
        // but they are ours, not the person's. Replaying one draws it as a `>` prompt
        // the user never typed — seen live as "> That was 3 sentences between tool
        // calls…" sitting in their own chat history.
        if (!e.synthetic) dispatch({ type: "user", text: stripAttachments(e.content) });
      } else if (e.role === "summary") {
        dispatch({ type: "note", text: "— resumed; earlier context summarized —" });
      } else if (e.role === "assistant") {
        // Narration came before the tools in the live turn, so seal it first, then
        // re-announce each tool call exactly as streamRespond does.
        // Same cut as the live path: prose that precedes tool calls is narration,
        // and a resumed chat must not print the essays the live one trimmed away.
        if (e.content.trim()) {
          const intermediate = (e.toolCalls?.length ?? 0) > 0;
          dispatch({ type: "say", text: intermediate ? trimNarration(e.content) : e.content });
        }
        for (const call of e.toolCalls ?? []) {
          const d = toolDisplay(call.name, parseToolArgs(call.arguments));
          dispatch({ type: "toolStart", toolId: call.id, name: d.name, arg: d.arg, action: d.kind, group: isGroupable(call.name) });
        }
      } else {
        // A tool result resolves its row/group item, mirroring the live toolEnd.
        dispatch({
          type: "toolEnd",
          toolId: e.toolCallId,
          ok: e.isError === undefined ? !e.content.startsWith("Error:") : !e.isError,
          summary: e.summary,
          detail: e.detail,
        });
      }
    }
    // Close any discovery group left open at the end so it commits to scrollback.
    dispatch({ type: "sealNarration" });
  }

  // Parse a stored tool call's raw JSON arguments for display; malformed → {}.
  function parseToolArgs(raw: string): Record<string, unknown> {
    try {
      const p = raw ? JSON.parse(raw) : {};
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // Called by the background-shell manager on any change: refresh the UI and surface
  // a one-line note for each shell that just finished.
  function handleBgChange() {
    setBgTick((t) => t + 1);
    const mgr = session.current?.toolContext.backgroundShells;
    for (const { info: sh, kind } of mgr?.takeUiEvents() ?? []) {
      if (kind === "ready") {
        addTool(`shell #${sh.id} (${clipCmd(sh.command)}) is up`);
        continue;
      }
      const verb =
        sh.status === "killed"
          ? sh.stoppedBy === "user"
            ? "stopped by you"
            : "killed"
          : `finished — exit ${sh.exitCode}`;
      addTool(`shell #${sh.id} (${clipCmd(sh.command)}) ${verb}`, { error: sh.status !== "killed" && sh.exitCode !== 0 });
    }
  }

  // A server's state moved. Repaint, and surface anything the pool needs the user to
  // know exactly once — chiefly a tool blocked because its description changed, which
  // would otherwise show up only as a silently shorter tool list.
  function handleMcpChange() {
    setBgTick((t) => t + 1);
    for (const notice of session.current?.toolContext.mcp?.takeNotices() ?? []) note(notice);
  }

  function attachApproval(s: Session) {
    s.toolContext.requestApproval = (q, o) => askApproval.current(q, o);
    s.toolContext.backgroundShells?.setOnChange(handleBgChange);
    // Servers connect in the background and can die or revive at any time; without this
    // the /mcp view would only ever show what was true when the last key was pressed.
    s.toolContext.mcp?.setOnChange(handleMcpChange);
    // A new/swapped session inherits the current mode's behavior.
    const m = modeById(modeRef.current);
    s.toolContext.planMode = m.readOnly;
    s.toolContext.guarded = m.guarded;
    s.toolContext.guardAllowAll = false;
    // exit_plan moves these flags mid-turn when a plan is approved, and the engine
    // moves them back when the turn ends. The indicator has to follow, or it would
    // claim the session is still planning while it is carrying the plan out. Modes
    // stay a client concept: the flags are read back and named here, never there.
    s.toolContext.onModeChange = () => {
      const id = modeFromFlags(s.toolContext);
      // Both, like applyMode does: the ref is what a session swap reads back, so
      // updating only the rendered state would restore the pre-approval mode later.
      modeRef.current = id;
      setMode(id);
    };
  }

  // Switch interaction mode (shift-tab). Updates the indicator and the flags the
  // engine reads (planMode / guarded) so the next turn respects it immediately.
  function applyMode(id: ModeId) {
    modeRef.current = id;
    setMode(id);
    const m = modeById(id);
    const s = session.current;
    if (s) {
      s.toolContext.planMode = m.readOnly;
      s.toolContext.guarded = m.guarded;
      // Entering Sentinel restores fresh vigilance — a prior "allow all" is cleared.
      if (m.guarded) s.toolContext.guardAllowAll = false;
    }
    // No scrollback line on a mode switch — the ModeBar under the chat already shows
    // the current mode and updates in place, so cycling doesn't flood the transcript.
  }

  // Large pastes are shown as `[Pasted text #N +M lines]` chips; the real content
  // is stashed here (keyed by chip) and restored into the model message on send.
  const pasteStore = useRef(new Map<string, string>());
  const pasteSeq = useRef(0);
  function registerPaste(content: string): string {
    const lines = content.split("\n").length;
    // Multi-line pastes read best as "+M lines"; a long single-line paste as "+K chars".
    const size = lines > 1 ? `+${lines} lines` : `+${content.length} chars`;
    const chip = `[Pasted text #${++pasteSeq.current} ${size}]`;
    pasteStore.current.set(chip, content);
    return chip;
  }
  function expandPastes(text: string): string {
    let out = text;
    for (const [chip, content] of pasteStore.current) {
      if (out.includes(chip)) out = out.split(chip).join(content);
    }
    return out;
  }

  // File-path completion for the input's `@mention` picker (primary root).
  const pathComplete = useRef((prefix: string) => {
    const s = session.current;
    return s ? completePath(s.cwd, prefix) : Promise.resolve<string[]>([]);
  });

  // Live terminal width — drives message wrapping (Static items capture it at
  // commit time; the live input reflows on resize for free).
  const width = useTerminalWidth();

  // One session for the whole conversation (a ref so it survives re-renders).
  const session = useRef<Session | null>(null);

  useEffect(() => {
    createSession().then((s) => {
      attachApproval(s);
      session.current = s;
      setReady(true);
      // The project may have a model saved from a different provider than the
      // default, so re-check against what we're actually about to run.
      const cur = session.current;
      if (!cur) return;
      const need = missingKeyFor(cur.modelConfig.model);
      if (!need) return;
      // A saved config can outlive the key that made it usable. Rather than open
      // straight into an inescapable prompt, fall back to a provider we can actually
      // run and say so — the user can always pick again with /provider.
      const fallback = usableFallback(cur.modelConfig.model, hasApiKey);
      if (fallback) {
        void switchTo(fallback, providerOf(fallback).label).then(() =>
          note(`no ${need.label} key yet — using ${providerOf(fallback).label} instead. /provider to change.`),
        );
        return;
      }
      setKeyNeed(need);
    });
  }, []);

  // When a background shell finishes and Mindweave is idle, react to it automatically.
  useEffect(() => {
    if (!ready || busy || needsKey || reactingRef.current) return;
    const mgr = session.current?.toolContext.backgroundShells;
    if (mgr && mgr.pendingCount() > 0) void reactToBackground();
  }, [bgTick, busy, ready, needsKey]);

  // When the turn ends, send the next queued message (chains through the queue).
  useEffect(() => {
    if (busy || !ready || needsKey || overlay) return;
    if (queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    setQueued([...queueRef.current]);
    void handleSubmit(next);
  }, [busy, ready, needsKey, overlay]);

  // First-run key setup, done entirely in the terminal: the user pastes their key
  // on the welcome screen. We save it to ~/.mindweave/.env (so it persists for every
  // future launch, in every project) and start chatting right away — no restart,
  // never asked again. The key lives only on this machine; it's sent only to the
  // user's own requests to their chosen provider, never to us.
  function handleKeySubmit(value: string) {
    const key = value.trim();
    if (!key) return;
    if (!keyNeed) return;
    saveApiKey(keyNeed.envVar, key);
    setKeyInput("");
    const pending = keyNeed.pending;
    setKeyNeed(null);
    // The switch was held back until the key existed — complete it now.
    if (pending) void switchTo(pending.model, pending.providerLabel);
    else note("key saved on this machine — you're all set. ask me anything.");
  }

  // Esc out of a key prompt we arrived at by CHOOSING a provider: nothing was changed
  // or saved, so abandoning it simply leaves the session as it was. The first-run gate
  // stays blocking — there is no session behind it to return to.
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      setKeyInput("");
      setKeyNeed(null);
      const s = session.current;
      if (s) note(`stayed on ${providerOf(s.modelConfig.model).label} · ${modelLabel(s.modelConfig.model)}`);
    },
    { isActive: keyNeed?.pending !== undefined },
  );

  // Start/stop a turn's timer (drives the persistent status line).
  function startTurn() {
    turnStart.current = Date.now();
    usageSamples.current = [];
    setTaskUsage(null); // clear the previous task's summary while this one runs
    abortRef.current = new AbortController();
    setBusy(true);
  }

  // Esc interrupts the current turn: it aborts the model call AND kills a running
  // command — run_command listens to this same signal (see runShell), so a hung
  // command (e.g. an installer waiting on a GUI) can no longer freeze the agent.
  // Only while working AND no overlay is open (an open Picker owns Esc for its own
  // cancel). The input ignores Esc, so typing-while-busy is safe.
  useInput(
    (_input, key) => {
      if (key.escape) {
        abortRef.current?.abort();
        // Esc means STOP — including anything running in the background (a starting app,
        // a dev server). Aborting the turn alone left those alive, so the app still opened.
        const mgr = session.current?.toolContext.backgroundShells;
        for (const sh of mgr?.running() ?? []) mgr?.kill(sh.id, "user");
        flush.current = true; // drain the rest of the queue immediately
        note("stopped.");
      }
    },
    { isActive: busy && overlay === null },
  );

  // shift-tab cycles the interaction mode (Lightning ⇄ Architect). Active whenever
  // the input owns the keyboard (no overlay); takes effect from the next turn.
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) applyMode(nextMode(modeRef.current));
    },
    { isActive: ready && overlay === null },
  );
  function endTurn() {
    if (turnStart.current != null) setLastMs(Date.now() - turnStart.current);
    setBusy(false);
  }

  /**
   * `/mcp add <name> <command|url> [args…]` and `/mcp remove <name>`.
   *
   * Shares its parser and writer with the `add_mcp_server` tool, so a config the command
   * accepts is exactly one the tool would, and vice versa. Connects immediately on add:
   * writing the file and telling the user to restart would defeat the point.
   */
  async function mcpConfigCommand(arg: string) {
    const cur = session.current;
    if (!cur) return;
    const argv = splitArgs(arg);
    const verb = argv.shift();

    if (verb === "remove" || verb === "rm") {
      const target = argv[0];
      if (!target) return say("Usage: /mcp remove <name>");
      const root = cur.cwd;
      const gone =
        (await removeServerFromConfig(configPathFor("project", root), target)) ||
        (await removeServerFromConfig(configPathFor("global", root), target));
      say(
        gone
          ? `Removed '${target}' from the config. It stays connected until this session ends.`
          : `No server called '${target}' is configured.`,
      );
      return;
    }

    const parsed = parseAddSpec(argv);
    if (!parsed.ok) return say(parsed.error);

    const path = configPathFor(parsed.spec.scope, cur.cwd);
    try {
      const written = await addServerToConfig(path, parsed.spec);
      note(`${written.replaced ? "replaced" : "added"} '${parsed.spec.name}' in ${path} — connecting…`);
      const status = await cur.toolContext.mcp?.addServer(parsed.spec.config);
      if (status?.state === "connected") {
        say(`${parsed.spec.name}: connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (protocol ${status.version}).`);
      } else if (status) {
        // Say what went wrong HERE rather than leaving it to be discovered in /mcp: a
        // typo'd command is the most likely outcome of typing this by hand.
        say(`${parsed.spec.name}: ${status.state}${status.error ? ` — ${status.error}` : ""}. It's saved; fix the config and /mcp to retry.`);
      }
    } catch (e) {
      say(`Couldn't write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // What Enter does on a /mcp row: review blocked tools if there are any, otherwise
  // reconnect. Blocked tools take priority because that is the state the user cannot
  // otherwise resolve — reconnecting will not clear a quarantine.
  async function mcpAction(name: string) {
    const mgr = session.current?.toolContext.mcp;
    if (mgr && mgr.blockedCountFor(name) > 0) {
      const allowed = await mgr.reviewQuarantine((q, options) => askApproval.current(q, options));
      note(allowed ? `${name}: blocked tools allowed for this project.` : `${name}: tools stay blocked.`);
      return;
    }
    await reconnectMcp(name);
  }

  // Reconnect one MCP server by name, reporting the outcome in the chat rather than
  // silently. A server that stays down is the thing a user most needs told about.
  async function reconnectMcp(name: string) {
    const mcp = session.current?.toolContext.mcp;
    if (!mcp) return;
    note(`reconnecting ${name}…`);
    const status = await mcp.reconnect(name);
    if (!status) return;
    if (status.state === "connected") {
      note(`${name} connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`);
    } else {
      note(`${name} is ${status.state}${status.error ? ` — ${status.error}` : ""}`);
    }
  }

  // Stop every root's background lane and any running shells from the current
  // session (before a swap).
  async function stopCurrentLanes() {
    const old = session.current?.toolContext;
    if (!old) return;
    old.backgroundShells?.dispose();
    // MCP servers are child processes we own. Left running across a session swap they
    // leak: each new session starts its own pool, and the old one keeps holding ports,
    // locks and file handles with nothing able to reach it.
    await old.mcp?.dispose();
    for (const ch of old.chassisByRoot?.values() ?? (old.chassis ? [old.chassis] : [])) {
      await stopChassis(ch);
    }
  }

  // ── Reveal pacing ───────────────────────────────────────────────────────────
  // The engine fires a turn's tool events in a burst, so rows would otherwise flash
  // up all at once. We queue the transcript actions and release a NEW block (a tool
  // row, the answer) only every ~700ms so the turn reads calmly. It's a MINIMUM
  // gap, not an added delay: if the model already spent that long between events,
  // the next reveal is immediate. Silent text accumulation and a tool RESOLVING in
  // place are never paced — only the APPEARANCE of a new block is.
  const REVEAL_GAP_MS = 700;
  const revealQ = useRef<Action[]>([]);
  const lastRevealAt = useRef(0);
  const pumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamDone = useRef(false);
  const flush = useRef(false); // Esc → drain the rest with no pacing
  // The standalone tool row we're briefly holding so it can appear already-resolved
  // (header + output at once) instead of header-then-expand, and since when.
  const holdId = useRef<string | null>(null);
  const holdSince = useRef(0);

  // A new block appears (paced); a token (silent), a tool resolution (in place), a
  // grouped discovery call (folds into the live group), or a sub-agent's nested
  // activity (folds into / resolves its rail in place) is not. Only a sub-agent's
  // START is paced — it's a new block, like any other tool row.
  const isPaced = (a: Action) =>
    a.type !== "token" &&
    a.type !== "toolEnd" &&
    a.type !== "subToolStart" &&
    a.type !== "subToolEnd" &&
    a.type !== "subagentEnd" &&
    !(a.type === "toolStart" && a.group);

  function enqueueReveal(a: Action) {
    revealQ.current.push(a);
    // If we're holding a tool for its result and it just arrived, stop waiting out the
    // grace window and reveal the row (resolved) right away.
    if (a.type === "toolEnd" && holdId.current === a.toolId && pumpTimer.current) {
      clearTimeout(pumpTimer.current);
      pumpTimer.current = null;
    }
    if (!pumpTimer.current) pump();
  }

  // Reveal the next block after the calm gap (a minimum, not an added delay).
  function schedulePaced(reveal: () => void) {
    const wait = flush.current ? 0 : Math.max(0, REVEAL_GAP_MS - (Date.now() - lastRevealAt.current));
    pumpTimer.current = setTimeout(() => {
      pumpTimer.current = null;
      reveal();
    }, wait);
  }

  function pump() {
    // Apply immediate actions at once: silent tokens, and in-place resolves (a tool
    // end that lands on an already-revealed running row, a grouped/rail item).
    while (revealQ.current.length > 0 && !isPaced(revealQ.current[0]!)) {
      const a = revealQ.current.shift()!;
      if (a.type === "token") applySilent(a);
      else dispatch(a);
    }
    if (revealQ.current.length === 0) {
      if (streamDone.current) {
        streamDone.current = false;
        endTurn();
      }
      return;
    }
    const front = revealQ.current[0]!;

    // A standalone tool row: prefer to reveal it ALREADY RESOLVED (header + output in
    // one step). Hold it briefly; if its result lands within the grace window the row
    // appears complete, never header-then-expand. Only a genuinely slow tool (still
    // running after the grace) falls back to a running header that fills in on its end.
    if (front.type === "toolStart" && !front.group) {
      const hasEnd = revealQ.current.some((a) => a.type === "toolEnd" && a.toolId === front.toolId);
      const fresh = holdId.current !== front.toolId;
      const heldMs = fresh ? 0 : Date.now() - holdSince.current;
      const plan = planToolReveal(hasEnd, heldMs, TOOL_GRACE_MS, flush.current);
      if (plan === "hold") {
        if (fresh) {
          holdId.current = front.toolId;
          holdSince.current = Date.now();
        }
        // Wait out the grace, then re-check; the end arriving (enqueueReveal) also wakes us.
        pumpTimer.current = setTimeout(() => {
          pumpTimer.current = null;
          pump();
        }, TOOL_GRACE_MS);
        return;
      }
      holdId.current = null;
      schedulePaced(() => {
        const start = revealQ.current.shift();
        if (start) dispatch(start);
        // "resolved" → also pull its end forward so the row lands complete at once.
        if (plan === "resolved" && start && start.type === "toolStart") {
          const ei = revealQ.current.findIndex((a) => a.type === "toolEnd" && a.toolId === start.toolId);
          if (ei >= 0) dispatch(revealQ.current.splice(ei, 1)[0]!);
        }
        lastRevealAt.current = Date.now();
        pump();
      });
      return;
    }

    // Every other paced block (narration, a sub-agent start, notes): reveal after the gap.
    schedulePaced(() => {
      const a = revealQ.current.shift();
      if (a) {
        dispatch(a);
        lastRevealAt.current = Date.now();
      }
      pump();
    });
  }

  /**
   * Run one streaming turn against the session. Engine events are QUEUED onto the
   * transcript through the pacer above: text tokens accumulate silently (whole-block
   * reveal), each tool bookends a `toolStart`/`toolEnd`, and the reply seals on
   * completion. busy stays true until every paced reveal has been shown.
   */
  async function streamRespond(s: Session) {
    startTurn();
    // Pick up any edits the model made to MINDWEAVE.md since last turn (it maintains it),
    // so the project memory in the prompt is never stale.
    await reloadProjectMemory(s).catch(() => {});
    revealQ.current = [];
    lastRevealAt.current = 0; // first reveal of the turn is immediate
    streamDone.current = false;
    flush.current = false;
    try {
      await respond(s, {
        onActivity: (line, opts) =>
          enqueueReveal(
            opts?.context ? { type: "context", text: line } : opts?.error ? { type: "error", text: line } : { type: "note", text: line },
          ),
        onEvent: (e) => {
          if (e.type === "text") {
            enqueueReveal({ type: "token", delta: e.delta });
          } else if (e.type === "tool" && e.phase === "start") {
            // The spawn call itself is rendered by its sub-agent block, not a raw row.
            if (e.name === "spawn_subagent") return;
            const d = toolDisplay(e.name, e.args);
            if (e.agent) {
              // A sub-agent's own tool call — fold it into that worker's nested rail.
              enqueueReveal({ type: "subToolStart", agentId: e.agent, toolId: e.id, name: d.name, arg: d.arg, action: d.kind });
            } else {
              enqueueReveal({ type: "toolStart", toolId: e.id, name: d.name, arg: d.arg, action: d.kind, group: isGroupable(e.name) });
            }
          } else if (e.type === "tool" && e.phase === "end") {
            if (e.name === "spawn_subagent") return;
            if (e.agent) {
              enqueueReveal({ type: "subToolEnd", agentId: e.agent, toolId: e.id, ok: !e.error, summary: e.summary });
            } else {
              enqueueReveal({ type: "toolEnd", toolId: e.id, ok: !e.error, summary: e.summary, detail: e.detail, quiet: e.quiet });
            }
          } else if (e.type === "subagent" && e.phase === "start") {
            enqueueReveal({ type: "subagentStart", agentId: e.id, task: e.task, readOnly: e.readOnly });
          } else if (e.type === "subagent" && e.phase === "end") {
            enqueueReveal({ type: "subagentEnd", agentId: e.id, ok: !e.error, summary: e.summary });
          } else if (e.type === "usage") {
            // Keep each call's real usage; fold into the context+cost summary shown
            // once the turn ends. The model id drives cache-aware pricing.
            usageSamples.current.push({
              promptTokens: e.promptTokens,
              completionTokens: e.completionTokens,
              totalTokens: e.totalTokens,
              cacheHitTokens: e.cacheHitTokens,
              cacheMissTokens: e.cacheMissTokens,
            });
            setTaskUsage(summarizeTask(usageSamples.current, s.modelConfig.model));
          }
          // `reasoning` deltas are ignored: not shown and not counted.
        },
        signal: abortRef.current?.signal,
        // Persist after every step so a hard crash / PC shutdown mid-turn loses at
        // most the current in-flight step — not the whole turn. (The finally below
        // still saves on clean/aborted exits.)
        persist: () => saveSession(s),
      });
      enqueueReveal({ type: "finishReply" });
    } catch (error) {
      enqueueReveal({ type: "finishReply" });
      enqueueReveal({ type: "error", text: `⚠ ${errText(error)}` });
    } finally {
      await saveSession(s);
      streamDone.current = true;
      if (!pumpTimer.current) pump(); // ensure we drain to endTurn even if idle now
    }
  }

  // When a background shell finishes while Mindweave is idle, kick a turn so the model
  // reports the result (and proposes a fix on failure). respond() drains the
  // completion event; the guard stops overlapping reactions.
  async function reactToBackground() {
    const s = session.current;
    if (!s) return;
    reactingRef.current = true;
    try {
      await streamRespond(s);
    } finally {
      reactingRef.current = false;
    }
  }

  // Resume a chosen past session: swap it in, restart its background lane, and
  // append its transcript to the visible stream. `compactFirst` summarizes the old
  // conversation BEFORE showing it, so continuing doesn't eat the context window.
  async function resumePicked(meta: SessionMeta, compactFirst: boolean) {
    const s = session.current;
    if (!s) return;
    const resumed = await resumeSession(s.cwd, meta.id);
    if (!resumed) {
      say("Couldn't load that session.");
      return;
    }
    await stopCurrentLanes();
    attachApproval(resumed);
    session.current = resumed;

    if (compactFirst) {
      startTurn();
      note("compacting the old conversation so it fits…");
      try {
        await compactNow(resumed, { onActivity: (line, opts) => note(line, opts) });
        await saveSession(resumed);
      } catch (error) {
        say(`⚠ ${errText(error)}`);
      } finally {
        endTurn();
      }
    }

    note(`— continuing${compactFirst ? " (compacted)" : ""}: ${sessionTitle(meta)} —`);
    showResumed(resumed.transcript);
  }

  // Drop the current chat and start a clean session in the same project.
  async function startFresh() {
    const s = session.current;
    if (!s) return;
    await stopCurrentLanes();
    const fresh = await createSession(s.cwd);
    attachApproval(fresh);
    session.current = fresh;
    note("— started a fresh session —");
  }

  // Apply the resume-mode pick for a chosen session: compact & continue / as-is / fresh.
  async function applyResume(meta: SessionMeta, mode: number) {
    if (mode === 2) return startFresh();
    return resumePicked(meta, mode === 0);
  }

  // Apply a /model pick: switch model (clamping reasoning to a valid level), persist
  // the choice for this project, and confirm.
  async function applyModel(index: number) {
    const s = session.current;
    // Index into the SAME list the picker rendered — the current provider's models,
    // not every model everywhere. Indexing the global list here would silently select
    // a different model than the one on screen, and would type-check perfectly.
    const choice = s ? modelsOf(s.modelConfig.model)[index] : undefined;
    if (!s || !choice) return;
    s.modelConfig = withModel(s.modelConfig, choice.id);
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`model → ${modelLabel(s.modelConfig.model)} · ${thinkLabel(s.modelConfig)}`);
  }

  /**
   * Apply a /provider pick: move to that provider's first model, since a provider is
   * only reachable through one of its models. Staying put when the pick is the
   * provider already in use matters — otherwise re-selecting it would quietly reset a
   * model the user chose deliberately.
   */
  async function applyProvider(index: number) {
    const s = session.current;
    const provider = allProviders()[index];
    if (!s || !provider) return;
    if (providerOf(s.modelConfig.model).id === provider.id) {
      note(`already on ${provider.label} · ${modelLabel(s.modelConfig.model)}`);
      return;
    }
    const target = provider.models[0];
    if (!target) return;

    // Do NOT move onto — let alone SAVE — a provider we can't run. Persisting first is
    // what turned a wrong pick into a project that reopened straight into the key
    // prompt on every launch, with no way back from inside the app. Ask for the key,
    // and apply the switch only once it exists.
    const need = missingKeyFor(target.id);
    if (need) {
      setKeyNeed({ ...need, pending: { model: target.id, providerLabel: provider.label } });
      return;
    }
    await switchTo(target.id, provider.label);
  }

  /** Move to a model and persist it. Only ever called once its key is known to exist. */
  async function switchTo(model: string, providerLabel: string) {
    const s = session.current;
    if (!s) return;
    s.modelConfig = withModel(s.modelConfig, model);
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`provider → ${providerLabel} · model → ${modelLabel(s.modelConfig.model)} · ${thinkLabel(s.modelConfig)}`);
  }

  // Apply a /think pick for the current model: set thinking + effort, persist, confirm.
  async function applyThink(index: number) {
    const s = session.current;
    if (!s) return;
    const level = thinkLevels(s.modelConfig.model)[index];
    if (!level) return;
    s.modelConfig = { ...s.modelConfig, thinking: level.thinking, effort: level.effort };
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`reasoning → ${modelLabel(s.modelConfig.model)} · ${level.label}`);
  }

  // Route a Picker selection/cancel back to whatever opened the overlay. Picking a
  // session opens the second step — the three resume choices.
  function onOverlaySelect(index: number) {
    const o = overlay;
    if (!o) return;
    if (o.kind === "sessions") {
      setOverlay({ kind: "resumeMode", meta: o.items[index]! });
      return;
    }
    setOverlay(null);
    if (o.kind === "resumeMode") void applyResume(o.meta, index);
    else if (o.kind === "provider") void applyProvider(index);
    else if (o.kind === "model") void applyModel(index);
    else if (o.kind === "think") void applyThink(index);
    else if (o.kind === "shells") {
      const sh = o.items[index];
      if (sh && sh.status === "running" && session.current?.toolContext.backgroundShells?.kill(sh.id, "user")) {
        note(`stopped shell #${sh.id} (${clipCmd(sh.command)})`);
      }
    } else if (o.kind === "mcp") {
      const server = o.items[index];
      if (server && server.state !== "disabled") void mcpAction(server.name);
    } else if (o.kind === "approval") o.resolve(o.options[index] ?? o.options[0]!);
  }
  function onOverlayCancel() {
    const o = overlay;
    setOverlay(null);
    // Esc = declined to answer. NOT "chose option 2" — see APPROVAL_DISMISSED.
    if (o?.kind === "approval") o.resolve(APPROVAL_DISMISSED);
  }

  // Hand a free-text directive to the model with an instruction wrapper, as its own
  // turn — used by the manual /rules and /skills commands (the model does the
  // "rewrite it well and save it" work via remember_rule / create_skill).
  async function runDirective(instruction: string, activity: string) {
    const s = session.current;
    if (!s) return;
    note(activity);
    s.transcript.push({ role: "user", content: instruction });
    await streamRespond(s);
  }

  async function handleCommand(raw: string) {
    const s = session.current;
    if (!s) return;
    const firstTok = raw.trim().split(/\s+/)[0];
    const name = firstTok.toLowerCase();
    const arg = raw.trim().slice(firstTok.length).trim(); // anything after the command word

    // /help — every command, rendered from the same list the input's autocomplete
    // offers, so the two can never disagree about what exists.
    if (name === "/help") {
      const skills = s.governance.skills ?? [];
      const mcpPrompts = s.toolContext.mcp?.promptCatalog() ?? [];
      say(
        formatHelp([
          { title: "Commands", commands: BASE_COMMANDS },
          {
            title: "Project skills",
            commands: skills.map((k) => ({ name: `/${k.name}`, description: k.description || "project skill" })),
          },
          {
            title: "MCP prompts",
            commands: mcpPrompts.map((p) => ({
              name: promptCommand(p),
              description: p.description || `prompt from ${p.server}`,
            })),
          },
        ]),
      );
      return;
    }

    if (name === "/compact") {
      startTurn();
      note("compacting the conversation…");
      try {
        await compactNow(s, { onActivity: (line, opts) => note(line, opts) });
        await saveSession(s);
        say("Context compacted.");
      } catch (error) {
        say(`⚠ ${errText(error)}`);
      } finally {
        endTurn();
      }
      return;
    }

    if (name === "/context") {
      const text = s.projectContext || "No project context was captured for this directory.";
      note("project context (what Mindweave sees at startup):");
      say(text);
      return;
    }

    // /undo — roll back file changes. Bare undoes the last turn; `list` shows what's
    // available; a number goes back that many turns, newest first.
    if (name === "/undo") {
      const cp = s.toolContext.checkpoints;
      const command = parseUndoArg(arg);
      if (command.kind === "error") {
        say(command.message);
        return;
      }
      if (!cp || !cp.hasUndo()) {
        // A resumed session genuinely has no history to undo, which is NOT the same
        // as nothing having happened — say which.
        say(
          cp?.wasResumed()
            ? "Nothing to undo here — undo history isn't carried across restarts. Changes from the earlier run are still on disk."
            : "Nothing to undo — no file changes have been made yet this session.",
        );
        return;
      }

      if (command.kind === "list") {
        const rows = cp.list().map((c, i) => {
          const bits = [`${c.files} file${c.files === 1 ? "" : "s"}`];
          if (c.skipped > 0) bits.push(`${c.skipped} too large`);
          if (c.ranShell) bits.push("ran shell");
          return `  ${i + 1}. ${c.label} — ${bits.join(", ")} · ${timeAgo(c.at)}`;
        });
        note(`${rows.length} turn${rows.length === 1 ? "" : "s"} you can roll back (newest first):`);
        say(`${rows.join("\n")}\n\n  /undo ${rows.length > 1 ? "2" : "1"} rolls back that many, newest first.`);
        return;
      }

      const results = await cp.undoMany(command.count);
      const rel = (p: string) => relativize(s.toolContext, p);
      const uniq = (xs: string[]) => [...new Set(xs)];
      const restored = uniq(results.flatMap((r) => r.restored));
      const conflicts = uniq(results.flatMap((r) => r.conflicts));
      const failed = uniq(results.flatMap((r) => r.failed));
      const skipped = uniq(results.flatMap((r) => r.skipped));

      if (restored.length + conflicts.length + failed.length + skipped.length === 0) {
        say("Nothing was rolled back.");
        return;
      }

      if (restored.length > 0) {
        // The files on disk are back to their pre-turn state; drop them from the read
        // ledger so the model must re-read before it can edit them again.
        for (const p of restored) s.toolContext.reads.delete(p);
        const from = results.length === 1 ? `“${results[0]!.label}”` : `${results.length} turns`;
        note(`reverted ${restored.length} file${restored.length === 1 ? "" : "s"} from ${from}:`);
        say(restored.map((p) => `  ↩ ${rel(p)}`).join("\n"));
      }
      if (conflicts.length > 0) {
        // Changed since we wrote them. Rolling back would have destroyed that work.
        note(`left alone — changed since I wrote ${conflicts.length === 1 ? "it" : "them"}:`);
        say(conflicts.map((p) => `  • ${rel(p)}`).join("\n"));
      }
      if (failed.length > 0) {
        const retry = results.some((r) => r.retryable)
          ? " — /undo again to retry"
          : " — giving up; they're still in their edited state";
        note(`couldn't write ${failed.length === 1 ? "this file" : "these files"}${retry}:`);
        say(failed.map((p) => `  ! ${rel(p)}`).join("\n"));
      }
      if (skipped.length > 0) {
        note(`never checkpointed (too large) — still in their edited state:`);
        say(skipped.map((p) => `  · ${rel(p)}`).join("\n"));
      }
      if (results.some((r) => r.ranShell)) {
        say("Shell commands also ran — those changes aren't covered by /undo.");
      }

      // Tell the MODEL too. Without this the transcript still claims the edits are in
      // place, and the next turn reasons about code that is no longer on disk.
      s.transcript.push({ role: "user", content: undoNotice(results, rel) });
      await saveSession(s);
      return;
    }

    // /shells — view background shells; selecting a running one stops it.
    if (name === "/shells") {
      const shells = s.toolContext.backgroundShells?.list() ?? [];
      if (shells.length === 0) {
        say("No background shells running. Long commands move here automatically after they pass their timeout.");
        return;
      }
      setOverlay({ kind: "shells", items: shells });
      return;
    }

    // /mcp add … — write a server to mcp.json and connect it now.
    if (name === "/mcp" && /^(add|remove|rm)/.test(arg)) {
      await mcpConfigCommand(arg);
      return;
    }

    // /mcp — server health; selecting one reconnects it.
    if (name === "/mcp") {
      const mcp = s.toolContext.mcp;
      if (!mcp?.hasServers()) {
        say(
          "No MCP servers configured. Add them in .mindweave/mcp.json (this project) or " +
            "~/.mindweave/mcp.json (everywhere), then /mcp to check they came up.",
        );
        return;
      }
      setOverlay({ kind: "mcp", items: mcp.statuses() });
      return;
    }

    if (name === "/continue") {
      const sessions = (await listSessions(s.cwd)).filter((m) => m.id !== s.id);
      if (sessions.length === 0) {
        say("No other sessions to continue here yet.");
        return;
      }
      setOverlay({ kind: "sessions", items: sessions });
      return;
    }

    if (name === "/provider") {
      setOverlay({ kind: "provider" });
      return;
    }

    if (name === "/model") {
      setOverlay({ kind: "model" });
      return;
    }

    if (name === "/think") {
      setOverlay({ kind: "think" });
      return;
    }

    // /include — add one or more folders to the workspace (backend + frontend, …).
    if (name === "/include") {
      if (!arg) {
        const roots = rootsOf(s.toolContext);
        const lines = roots.map((r, i) => `• ${rootLabel(roots, r)}${i === 0 ? "  (primary)" : ""}  →  ${r}`);
        note("workspace roots (add more with /include <path>):");
        say(lines.join("\n"));
        return;
      }
      for (const p of parsePaths(arg)) {
        const abs = isAbsolute(p) ? resolve(p) : resolve(s.cwd, p);
        const result = await addRoot(s.toolContext, abs);
        if (result.error) note(`couldn't add ${p}: ${result.error}`, { error: true });
        else if (result.already) note(`'${result.label}' is already in the workspace.`);
        else note(`included '${result.label}' → ${abs}`);
      }
      await saveSession(s);
      return;
    }

    // /link — discover and pull in the rest of the project (monorepo members or
    // sibling repos) in one shot, so the model works across the whole thing.
    if (name === "/link") {
      note("looking for related project folders…");
      const roots = rootsOf(s.toolContext);
      const related = await discoverRelatedRoots(roots[0]!, roots);
      if (related.length === 0) {
        say("No related folders found (no monorepo config or sibling projects beside this one).");
        return;
      }
      const added: string[] = [];
      for (const r of related) {
        const res = await addRoot(s.toolContext, resolve(r.path));
        if (res.label && !res.already) added.push(`${res.label} (${r.reason})`);
      }
      if (added.length === 0) say("Those folders are already in the workspace.");
      else {
        note(`linked ${added.length} folder${added.length === 1 ? "" : "s"} — the model now works across all of them:`);
        say(added.map((a) => `• ${a}`).join("\n"));
        await saveSession(s);
      }
      return;
    }

    // /exclude — drop an added root (by label or path); the primary stays.
    if (name === "/exclude") {
      if (!arg) {
        say("Usage: /exclude <label or path> — removes an added folder (the primary root stays).");
        return;
      }
      const result = removeRoot(s.toolContext, arg.trim());
      if (result.error) say(result.error);
      else {
        note(`excluded '${result.removed}' from the workspace.`);
        await saveSession(s);
      }
      return;
    }

    // /rules — list standing rules, or (with text) have the model formalize a new one.
    if (name === "/rules") {
      if (!arg) {
        const rules = s.governance.rules;
        if (rules.length === 0) {
          say('No rules yet. Add one with /rules <directive> (e.g. "/rules always use pnpm").');
          return;
        }
        const lines = rules.map((r) => {
          const scope = r.globs && r.globs.length > 0 ? `  [scoped: ${r.globs.join(", ")}]` : "";
          return `• ${r.body}${scope}`;
        });
        note("standing rules for this project:");
        say(lines.join("\n"));
        return;
      }
      await runDirective(
        `The user wants this saved as a standing rule for this project. Rewrite it as a clear, ` +
          `imperative, self-contained rule and save it with remember_rule (add globs only if it ` +
          `clearly applies to specific files). Then confirm in one line. Directive: "${arg}"`,
        "saving a rule…",
      );
      return;
    }

    // /forbidden — list forbidden paths, or (with a path) forbid one outright.
    if (name === "/forbidden") {
      if (!arg) {
        const patterns = s.governance.forbidden.patterns;
        if (patterns.length === 0) {
          say('Nothing is forbidden yet. Protect a path with /forbidden <path> (e.g. "/forbidden src/legacy/**").');
          return;
        }
        note("forbidden paths (I won't touch these without your okay):");
        say(patterns.map((p) => `• ${p}`).join("\n"));
        return;
      }
      const result = await appendForbidden(s.governance.forbidden.root, arg);
      if (!result.pattern) {
        say("That path was empty after normalization — nothing forbidden.");
        return;
      }
      if (result.added) {
        s.governance.forbidden = {
          ...s.governance.forbidden,
          patterns: [...s.governance.forbidden.patterns, result.pattern],
        };
        note(`forbade '${result.pattern}' — I won't touch it without asking.`);
      } else {
        say(`'${result.pattern}' was already forbidden.`);
      }
      return;
    }

    // /forbid-command — list forbidden commands, or (with an argument) forbid one.
    if (name === "/forbid-command") {
      if (!arg) {
        const commands = s.governance.forbidden.commands ?? [];
        if (commands.length === 0) {
          say('No commands are forbidden yet. Block one with /forbid-command <command> (e.g. "/forbid-command tauri dev").');
          return;
        }
        note("forbidden commands (I won't run these, or anything containing them, without your okay):");
        say(commands.map((c) => `• ${c}`).join("\n"));
        return;
      }
      const result = await appendForbiddenCommand(s.governance.forbidden.root, arg);
      if (!result.pattern) {
        say("That command was empty — nothing forbidden.");
        return;
      }
      if (result.added) {
        s.governance.forbidden = {
          ...s.governance.forbidden,
          commands: [...(s.governance.forbidden.commands ?? []), result.pattern],
        };
        note(`forbade the command '${result.pattern}' — I won't run it without asking.`);
      } else {
        say(`'${result.pattern}' was already forbidden.`);
      }
      return;
    }

    // /skills — list the project's skills, or (with text) have the model author one.
    if (name === "/skills") {
      if (arg) {
        await runDirective(
          `The user wants a new reusable skill for this project: "${arg}". Design it and save it ` +
            `with create_skill — a short invocation name, a one-line description, and the procedure ` +
            `as a clear markdown checklist (use $ARGUMENTS/$1 if it should take input). Then confirm.`,
          "creating a skill…",
        );
        return;
      }
      const skills = s.governance.skills;
      if (skills.length === 0) {
        say('No skills yet. Make one with /skills <description> (e.g. "/skills our release flow").');
        return;
      }
      const lines = skills.map((sk) => {
        const hint = sk.argumentHint ? ` ${sk.argumentHint}` : "";
        const desc = sk.description ? ` — ${sk.description}` : "";
        const scope = sk.globs && sk.globs.length > 0 ? `  [scoped: ${sk.globs.join(", ")}]` : "";
        return `/${sk.name}${hint}${desc}${scope}`;
      });
      note("project skills (run with /name or let me pick one):");
      say(lines.join("\n"));
      return;
    }

    // A project skill invoked as /name — load its steps and run them as a turn.
    const skill = findSkill(s.governance.skills, name);
    if (skill) {
      const rest = raw.trim().slice(raw.trim().split(/\s+/)[0].length).trim();
      const body = await loadSkillBody(skill);
      if (!body) {
        say(`Skill ${skill.name} has no readable SKILL.md.`);
        return;
      }
      note(`running skill ${skill.name}…`);
      const text = `Run the "${skill.name}" skill. Follow these steps:\n\n${substituteSkillArgs(body, rest)}`;
      s.transcript.push({ role: "user", content: text });
      await streamRespond(s);
      return;
    }

    // A server prompt invoked as /server:name — render it and run it, exactly like a
    // skill. Checked after skills so a project's own command always wins over a
    // third-party server's.
    const promptRef = parsePromptCommand(name);
    if (promptRef) {
      const prompt = s.toolContext.mcp?.findPrompt(promptRef.server, promptRef.name);
      if (!prompt) {
        say(`No MCP prompt ${name}. Run /mcp to see which servers are connected.`);
        return;
      }
      const rest = raw.trim().slice(name.length).trim();
      const { values, missing } = mapPromptArguments(prompt, rest ? rest.split(/\s+/) : []);
      if (missing.length > 0) {
        say(`${name} needs ${missing.join(", ")}.\n${promptUsage(prompt)}`);
        return;
      }
      note(`running ${name}…`);
      const rendered = await s.toolContext.mcp!.renderPrompt(promptRef.server, promptRef.name, values);
      if (rendered.error) {
        say(`${name} failed: ${rendered.error}`);
        return;
      }
      s.transcript.push({ role: "user", content: rendered.text });
      await streamRespond(s);
      return;
    }

    say(
      `Unknown command ${name}. Try /model, /think, /rules, /skills, /forbidden, /link, /include, /exclude, /shells, /mcp, /context, /undo, /compact or /continue.`,
    );
  }

  async function handleSubmit(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || busy || !ready) return;

    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed);
      return;
    }

    const s = session.current;
    if (!s) return;

    // The chat shows the typed line — `@mentions` stay visible, a dragged/dropped
    // file path collapses to just its name — never the file dump. The model gets
    // the full content via resolved <attached_file> blocks, and each attachment
    // leaves one compact activity note (counts only).
    // Whether an attached image is sent or merely named depends on the running model,
    // and that is a fact we ask the driver for — never a provider name in this file.
    const manifest = manifestForModel(s.modelConfig.model);
    const canSeeImages = manifest.acceptsImages?.(s.modelConfig.model) ?? false;
    const { modelText, displayText, notes, images } = await resolveAttachments(trimmed, s.cwd, canSeeImages);
    dispatch({ type: "user", text: displayText });
    for (const n of notes) note(n);
    // Restore any collapsed pastes into the model's copy only (the chat keeps chips).
    s.transcript.push({
      role: "user",
      content: expandPastes(modelText),
      ...(images.length > 0 ? { images } : {}),
    });
    await streamRespond(s);
  }

  // Key setup screen. Shown on first run, and again if the user switches to a
  // provider they haven't given a key for yet.
  if (keyNeed) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="yellow">Mindweave</Text>
          <Text dimColor>{versionLabel()}</Text>
        </Box>
        <Text>
          {keyNeed.pending
            ? `${keyNeed.label} needs a key before it can answer. Nothing has changed yet.`
            : "Welcome to Mindweave — your terminal coding agent. Let's set you up, one time only."}
        </Text>
        <Box marginTop={1}>
          <Text>Paste your {keyNeed.label} API key to start chatting:</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold color="cyan">{"  key › "}</Text>
          <TextInput
            value={keyInput}
            onChange={setKeyInput}
            onSubmit={handleKeySubmit}
            placeholder="sk-…  (paste, then press Enter)"
            mask="•"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Don't have one? Get a key at {keyNeed.keysUrl}</Text>
          <Text dimColor>Learn more: {MINDWEAVE_DOCS_URL}</Text>
          {keyNeed.pending ? <Text dimColor>Esc — stay where you are and change nothing.</Text> : null}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Your key is saved only on this machine ({globalEnvPath()}) and is sent only to
            {" "}{keyNeed.label} on your own requests — never to us. You won't be asked again.
          </Text>
        </Box>
      </Box>
    );
  }

  // Record the sent text in history (no consecutive dupes). While busy, queue it
  // (the input stays live); the turn-end effect sends it next. Otherwise handle now.
  function onSend(text: string) {
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    if (busy) {
      queueRef.current.push(text);
      setQueued([...queueRef.current]);
      return;
    }
    void handleSubmit(text);
  }

  // Autocomplete entries: the built-in slash commands, this project's skills, and any
  // prompts the connected MCP servers offer (all read from the live session, so a freshly
  // created skill — or a server that just finished connecting — shows up next render).
  const skills = session.current?.governance.skills ?? [];
  const mcpPrompts = session.current?.toolContext.mcp?.promptCatalog() ?? [];
  const completions = [
    ...BASE_COMMANDS,
    ...skills.map((s) => ({ name: `/${s.name}`, description: s.description || "project skill" })),
    ...mcpPrompts.map((p) => ({ name: promptCommand(p), description: p.description || `prompt from ${p.server}` })),
  ];

  // While an overlay is open it replaces the input and owns the keyboard.
  function buildOverlayView() {
    if (!overlay) return null;
    const cur = session.current;
    if (overlay.kind === "sessions") {
      const items = overlay.items.map((m) => ({
        label: sessionTitle(m),
        description: `${timeAgo(m.updatedAt)} · ${m.entryCount} msg${m.entryCount === 1 ? "" : "s"}`,
      }));
      return (
        <Picker title="Continue which session?" items={items} width={width} onSelect={onOverlaySelect} onCancel={onOverlayCancel} />
      );
    }
    if (overlay.kind === "resumeMode") {
      return (
        <Picker
          title={`Continue “${sessionTitle(overlay.meta)}” — how?`}
          items={RESUME_MODES}
          width={width}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "shells") {
      const items = overlay.items.map((sh) => ({
        label: `#${sh.id} ${clipCmd(sh.command)}`,
        description: sh.status === "running" ? `running ${shellElapsed(sh)} — Enter to stop` : sh.status === "killed" ? "killed" : `exited ${sh.exitCode}`,
      }));
      return (
        <Picker title="Background shells" items={items} width={width} onSelect={onOverlaySelect} onCancel={onOverlayCancel} />
      );
    }
    if (overlay.kind === "mcp") {
      const mgr = cur?.toolContext.mcp;
      const items = overlay.items.map((srv) => ({
        label: mcpLabel(srv),
        description: mcpDetail(srv, mgr?.blockedCountFor(srv.name) ?? 0),
      }));
      return <Picker title="MCP servers" items={items} width={width} onSelect={onOverlaySelect} onCancel={onOverlayCancel} />;
    }
    if (overlay.kind === "provider") {
      const active = providerOf(cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model).id;
      const providers = allProviders();
      const items = providers.map((p) => {
        const n = p.models.length;
        const models = `${n} model${n === 1 ? "" : "s"}`;
        // Say up front which ones you can actually run — finding out at the next
        // request is the worse place to learn it.
        const key = hasApiKey(p.apiKeyEnv) ? "key set" : `needs ${p.apiKeyEnv}`;
        return { label: p.label + (p.id === active ? "  ✓" : ""), description: `${models} · ${key}` };
      });
      return (
        <Picker
          title="Choose a provider"
          items={items}
          width={width}
          initialIndex={Math.max(0, providers.findIndex((p) => p.id === active))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "model") {
      const id = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;
      // Only the current provider's models. Switching provider is /provider's job.
      const models = modelsOf(id);
      const items = models.map((m) => ({ label: m.label + (m.id === id ? "  ✓" : ""), description: m.description }));
      return (
        <Picker
          title={`Choose a ${providerOf(id).label} model`}
          items={items}
          width={width}
          initialIndex={Math.max(0, models.findIndex((m) => m.id === id))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "think") {
      const model = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;
      const levels = thinkLevels(model);
      const curLabel = cur ? thinkLabel(cur.modelConfig) : "";
      const items = levels.map((l) => ({ label: l.label + (l.label === curLabel ? "  ✓" : ""), description: l.description }));
      return (
        <Picker
          title={`Reasoning for ${modelLabel(model)}`}
          items={items}
          width={width}
          initialIndex={Math.max(0, levels.findIndex((l) => l.label === curLabel))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    // approval — the forbidden-lift Yes/No/other prompt
    return (
      <Picker
        title={overlay.question}
        items={overlay.options.map((o) => ({ label: o }))}
        width={width}
        onSelect={onOverlaySelect}
        onCancel={onOverlayCancel}
      />
    );
  }
  const overlayView = buildOverlayView();

  // Committed blocks → <Static> (scrollback), with the banner pinned first.
  const committed = stateRef.current.committed;
  const tail = stateRef.current.tail;
  const items: StaticItem[] = [BANNER_ITEM, ...committed];

  return (
    <Box flexDirection="column">
      {/* Committed history → terminal scrollback (printed once, scrollable up). */}
      <Static items={items}>
        {(item, index) => {
          if (item === BANNER_ITEM) return <Banner key="banner" />;
          const prev = index > 1 ? (items[index - 1] as Block) : undefined;
          const tight = item.kind === "tool" && !!prev && typeof prev !== "string" && prev.kind === "tool";
          return <BlockView key={item.id} block={item} columns={width} tightTop={tight} />;
        }}
      </Static>

      {/* Live tail: the streaming block + any still-running tool. Stays tiny. */}
      {tail.map((b, i) => {
        const prev = i > 0 ? tail[i - 1] : committed[committed.length - 1];
        const tight = b.kind === "tool" && !!prev && prev.kind === "tool";
        return <BlockView key={b.id} block={b} columns={width} tightTop={tight} />;
      })}

      {/* Persistent status line: spinner + timer while working,
          "✻ Cooked for 1m 23s · N tokens" once finished. */}
      <StatusLine busy={busy} startedAt={turnStart.current} lastMs={lastMs} usage={taskUsage} />

      {/* Live count of background shells, just under the chat. */}
      <BackgroundBar shells={session.current?.toolContext.backgroundShells?.running() ?? []} />

      {/* Messages queued while busy — sent in order when the turn ends. */}
      <QueuedBar queued={queued} />

      {overlayView ? (
        overlayView
      ) : ready ? (
        <PromptInput
          onSubmit={onSend}
          disabled={false}
          placeholder={busy ? "type to queue a message…" : "say something…"}
          width={width}
          history={history}
          completions={completions}
          pathComplete={pathComplete.current}
          onLargePaste={registerPaste}
        />
      ) : (
        <Box paddingX={1}>
          <Text dimColor>starting…</Text>
        </Box>
      )}

      {/* Interaction mode (Lightning / Architect / Sentinel) — sits BELOW the input,
          a mode line below the input. shift-tab cycles it. Hidden while an overlay
          owns the screen. */}
      {overlayView ? null : <ModeBar mode={mode} />}
    </Box>
  );
}

// "banner" is a sentinel <Static> item (the one-time header) so it scrolls with
// the transcript and prints exactly once, like any other committed block.
const BANNER_ITEM = "__banner__" as const;
type StaticItem = typeof BANNER_ITEM | Block;

function Banner() {
  return (
    <Box marginBottom={1}>
      <Text bold color="yellow">Mindweave</Text>
      <Text dimColor>{versionLabel()}</Text>
    </Box>
  );
}

/**
 * Terminal width that updates on resize — DEBOUNCED. A drag-resize fires a flood
 * of resize events; re-rendering on each one makes a slow host (legacy cmd.exe)
 * leave stale copies of the live region in the scrollback. Updating only once the
 * resize settles (~150ms) collapses that to a single clean re-layout.
 */
function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setCols(stdout.columns ?? 80), 150);
    };
    stdout.on("resize", onResize);
    return () => {
      clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return cols;
}

// The built-in slash commands offered by the input's autocomplete. Project skills
// are appended at render time from the live session.
const BASE_COMMANDS = [
  { name: "/help", description: "show this list" },
  { name: "/provider", description: "choose which provider serves this project" },
  { name: "/model", description: "choose which model answers, from the current provider" },
  { name: "/think", description: "set the reasoning level for the model" },
  { name: "/rules", description: "list rules, or add one: /rules <directive>" },
  { name: "/skills", description: "list skills, or make one: /skills <description>" },
  { name: "/forbidden", description: "list protected paths, or add: /forbidden <path>" },
  { name: "/forbid-command", description: "list forbidden commands, or add: /forbid-command <command>" },
  { name: "/link", description: "pull in the rest of the project (monorepo / sibling repos)" },
  { name: "/include", description: "add a folder to the workspace: /include <path>" },
  { name: "/exclude", description: "remove an added folder: /exclude <label>" },
  { name: "/shells", description: "view or stop background commands (tests, servers)" },
  { name: "/mcp", description: "view MCP servers; /mcp add <name> <command|url> to connect one" },
  { name: "/context", description: "show what Mindweave sees about this project" },
  { name: "/undo", description: "roll back file changes: /undo, /undo list, /undo <n>" },
  { name: "/compact", description: "summarize the conversation to free up context" },
  { name: "/continue", description: "pick a past session to resume" },
];

/** Split a /include argument into paths: quoted segments (spaces) or bare tokens. */
function parsePaths(arg: string): string[] {
  const out: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** A short, human title for a session row: its opening prompt, or a fallback. */
function sessionTitle(meta: SessionMeta): string {
  const t = (meta.firstPrompt || meta.lastPrompt || "").trim();
  if (!t) return "(untitled session)";
  return t.length <= 60 ? t : t.slice(0, 59) + "…";
}

/** Coarse relative time for the session picker: "just now", "2 hours ago", … */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The persistent status line above the input — a dot that is ALWAYS present.
 *   - idle: the dot sits dim, after a turn showing "● Worked for 1m 23s · N tokens".
 *   - working: a steady dot beside a live "Working… (12s)" timer that ticks each
 *     second, until the turn finishes.
 * Sits just ABOVE the input box, hugging it (no blank line below), with one blank
 * line above separating it from the conversation, where the
 * receipt belongs to the prompt area, not glued to the last reply.
 */
function StatusLine({
  busy,
  startedAt,
  lastMs,
  usage,
}: {
  busy: boolean;
  startedAt: number | null;
  lastMs: number | null;
  /** The task's summary, known only once the turn ends. Null while working — no
   *  number is reliable mid-stream. */
  usage: TaskUsage | null;
}) {
  // A once-a-second tick, only while busy, so the elapsed timer advances. No
  // animation — the changing seconds are the only motion, which keeps it calm.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const dot = busy ? <Text color="cyan">●</Text> : <Text dimColor>●</Text>;

  let label = null;
  if (busy && startedAt != null) {
    // Working: timer only. No numbers — none would be accurate yet.
    label = <Text> Working… ({fmtElapsed(Math.floor((Date.now() - startedAt) / 1000))})</Text>;
  } else if (lastMs != null) {
    // Settled receipt: elapsed time and the task's real token total, dim so it recedes
    // once the answer is on screen but stays present. Shown at once, no count-up.
    const meter = usage ? ` · ${formatTokens(usage.totalTokens)} tokens` : "";
    label = <Text bold> Worked for {fmtElapsed(Math.round(lastMs / 1000))}{meter}</Text>;
  }

  return (
    <Box marginTop={1} marginBottom={0}>
      {dot}
      {label}
    </Box>
  );
}

function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Truncate a command for one-line display. */
function clipCmd(command: string, max = 44): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function shellElapsed(sh: ShellInfo): string {
  return fmtElapsed(Math.floor((Date.now() - sh.startedAt) / 1000));
}

/** One MCP server's headline row: name plus a state marker readable at a glance. */
export function mcpLabel(server: McpStatus): string {
  const marker =
    server.state === "connected" ? "●" : server.state === "pending" ? "◐" : server.state === "disabled" ? "○" : "✗";
  return `${marker} ${server.name}`;
}

/** The dim detail column: what this server is doing, and what Enter would do to it. */
export function mcpDetail(server: McpStatus, blocked = 0): string {
  // A blocked tool is the one state the user must act on, so it outranks everything
  // else in the row — including a healthy connection.
  if (blocked > 0) {
    return `${blocked} tool${blocked === 1 ? "" : "s"} BLOCKED (description changed) — Enter to review`;
  }
  switch (server.state) {
    case "connected": {
      // Prompts are counted separately because they are the user's to invoke, not the
      // model's: a server offering only prompts would otherwise read as "0 tools" and
      // look broken.
      const counts = [
        `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`,
        ...(server.promptCount ? [`${server.promptCount} prompt${server.promptCount === 1 ? "" : "s"}`] : []),
        ...(server.offersResources ? ["resources"] : []),
      ];
      const tools = counts.join(", ");
      // The negotiated revision is worth surfacing: "legacy" is why a server may be
      // missing capabilities, and it is otherwise invisible.
      const proto = server.version ? ` · ${server.version}${server.legacy ? " (legacy)" : ""}` : "";
      return `${tools}${proto} — Enter to reconnect`;
    }
    case "pending":
      return "connecting…";
    case "needs-auth":
      return "needs authentication — Enter to retry";
    case "disabled":
      return "disabled in mcp.json";
    default:
      return `${server.error ?? "failed"} — Enter to retry`;
  }
}

/**
 * The under-the-chat indicator for background shells: one running shell shows its
 * command + elapsed; several collapse to a count. It self-ticks once a second while
 * anything runs (so the timer moves), and renders nothing when idle.
 */
function BackgroundBar({ shells }: { shells: ShellInfo[] }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (shells.length === 0) return;
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [shells.length]);

  if (shells.length === 0) return null;
  const head = shells[0]!;
  const label =
    shells.length === 1
      ? `shell #${head.id} running — ${clipCmd(head.command)} (${shellElapsed(head)})`
      : `${shells.length} shells running`;
  return (
    <Box>
      <Text color="yellow">▶ </Text>
      <Text dimColor wrap="truncate-end">{label}</Text>
    </Box>
  );
}

/**
 * The under-the-chat mode indicator: the current mode's icon + name (colored),
 * its one-line descriptor, and the shift-tab hint. Always visible so the mode
 * reads at a glance — the point of an always-on indicator. Cycled with shift-tab.
 */
function ModeBar({ mode }: { mode: ModeId }) {
  const m = modeById(mode);
  return (
    <Box>
      <Text color={m.color} bold>{"⏵⏵ "}{m.name}</Text>
      <Text dimColor> · {m.descriptor}</Text>
      <Text dimColor>{"  (shift+tab to cycle)"}</Text>
    </Box>
  );
}

/** Messages typed while Mindweave is working, waiting to be sent when the turn ends. */
function QueuedBar({ queued }: { queued: string[] }) {
  if (queued.length === 0) return null;
  return (
    <Box flexDirection="column">
      {queued.map((q, i) => (
        <Text key={i} dimColor wrap="truncate-end">{"⏎ queued: "}{q}</Text>
      ))}
    </Box>
  );
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
