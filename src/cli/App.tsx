/**
 * App — the terminal UI shell (the "eyes and hands" of Mindweave).
 *
 * The transcript is a pure state machine (transcript.ts): a `committed` list
 * (append-only) and a live `tail` (the block currently streaming + any running
 * tool). A block drains from tail → committed the instant it and every earlier
 * block is done — that lets streamed text reveal WHOLE (tokens accumulate
 * silently; the block appears at once when it seals), never typewriter.
 *
 * Mindweave runs in the terminal's alternate screen (altScreen.ts) with a
 * pinned header, a pinned footer, and the full committed+tail history in a
 * flexGrow middle region that fills whatever space they don't use — there
 * is no real terminal scrollback to lean on inside alt-screen, so nothing
 * here is capped: the whole conversation stays in memory and only the
 * render is windowed (clipped to the newest content that fits).
 *
 * The UI owns the session for the whole conversation: it creates one on startup,
 * appends each user turn to its transcript, asks the dynamo (engine) for a reply,
 * and persists after every turn. It still knows nothing about any provider, prompts,
 * or compaction internals — it calls `respond()` / `compactNow()` and renders the
 * stream events they emit.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isAbsolute, resolve } from "node:path";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import { compactNow, respond } from "../dynamo/engine.js";
import { createSession, resumeSession, reloadProjectMemory } from "../memory/session.js";
import { saveSession, listSessions } from "../memory/store.js";
import { stopChassis } from "../alternator/lane.js";
import { loadSkillBody, substituteSkillArgs } from "../governor/skills.js";
import { appendForbidden, appendForbiddenCommand } from "../governor/write.js";
import { addRoot, removeRoot } from "../tools/workspace.js";
import { discoverRelatedRoots } from "../tools/workspaceDiscover.js";
import { rootLabel, rootsOf, relativize } from "../tools/paths.js";
import { APPROVAL_DISMISSED, APPROVAL_TEXT } from "../tools/approval.js";
import { KeySetup } from "./components/KeySetup.js";
import { setupView } from "./keySetup.js";
import { KeyManager } from "./components/KeyManager.js";
import { providerRows, keyRowsFor, nextSlotFor } from "./keyManager.js";
import { keysFor } from "./keyStore.js";
import { TrustGate } from "./components/TrustGate.js";
import { rootBreadth, breadthWarning, trustPersists, isTrusted, rememberTrust } from "./trust.js";
import { projectDir } from "../memory/store.js";
import { parseUndoArg, undoNotice } from "../tools/checkpoints.js";
import { DEFAULT_MODEL_CONFIG, thinkLevels, thinkLabel, modelLabel, modelsOfProvider, providerOf, usableFallback, needsKeySetup, withModel, saveModelConfig, refreshModels, type ModelConfig } from "../dynamo/model.js";
import { allProviders, manifestForModel, modelsOf } from "../drivers/registry.js";
import { accessRefusal } from "../drivers/providerError.js";
import { resolveAttachments, stripAttachments } from "./attachments.js";
import { completePath } from "./pathComplete.js";
import { formatHelp } from "./help.js";
import { hasApiKey, saveApiKey, removeApiKey, useApiKey, globalEnvPath, reloadConfig } from "./bootstrap.js";
import { versionLabel, appVersion } from "./version.js";
import { PromptInput } from "./components/PromptInput.js";
import { Picker } from "./components/Picker.js";
import { ApprovalBox } from "./components/ApprovalBox.js";
import { BlockView } from "./components/BlockView.js";
import { initialState, reduce, trimNarration, type Action, type Block, type TranscriptState } from "./transcript.js";
import { enableMouse, readWheel, stripMouse } from "./mouse.js";
import { chatLayout, reflowScroll } from "./chatAnchor.js";
import { virtualWindow } from "./virtualWindow.js";
import { perf, perfEnabled } from "./perfLog.js";
import { isGroupMember, groupSettled, planGroupReveal, resultQueued } from "./groupReveal.js";
import { drain as drainQueue, popAll as popAllQueued, visibleQueue } from "./messageQueue.js";
import { routeCommand, parseCommandLine, unknownCommandMessage } from "./commandRoute.js";
import { resolveChoice } from "./commandArgs.js";
import { toolDisplay, isGroupable, KIND_COLOR } from "./toolDisplay.js";
import { workingVerb } from "./workingVerb.js";
import { narrationPending, revealWait } from "./revealPace.js";
import { summarizeTask, formatTokens, type TaskUsage } from "../dynamo/pricing.js";
import { meterReset, meterDelta, meterTick, meterValue, type MeterState } from "../dynamo/liveMeter.js";
import type { Usage } from "../drivers/types.js";
import type { ShellInfo } from "../tools/backgroundShells.js";
import type { ConnectionStatus as McpStatus } from "../mcp/connection.js";
import { addServerToConfig, configPathFor, parseAddSpec, removeServerFromConfig, splitArgs } from "../mcp/configWrite.js";
import { mapPromptArguments, promptCommand, promptUsage } from "../mcp/prompts.js";
import type { Entry, Session, SessionMeta } from "../memory/types.js";
import { DEFAULT_MODE, modeById, modeFromFlags, nextMode, type ModeId } from "./modes.js";
import { ApprovalChannel } from "./approvalChannel.js";

const MINDWEAVE_DOCS_URL = "https://mindweave.dev";

/**
 * The provider whose key we're missing, and what to tell the user about it.
 *
 * `pending` is the switch this key would unlock. Its presence is also what makes the
 * prompt escapable: a first-run gate has nothing behind it, but a gate reached by
 * choosing a provider does — the session you were already in.
 */
/** What a model's provider needs before it can answer. Used to DECIDE, never to render:
 *  the screens that ask for a key are KeySetup and KeyManager. */
type KeyNeed = {
  envVar: string;
  label: string;
  keysUrl: string;
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
  | {
      kind: "approval";
      question: string;
      options: string[];
      freeText?: { label: string; placeholder: string };
      resolve: (choice: string) => void;
    };

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
  // Apply several actions as ONE frame: everything but the last lands silently, so
  // the terminal never shows a block part-way through being assembled. Ink mounts a
  // legacy React root, which flushes each dispatch synchronously — so "one dispatch"
  // and "one frame" are the same thing, and a block that needs two actions to be
  // complete must batch them or it will be seen incomplete.
  const applyBatch = (actions: Action[]) => {
    for (let i = 0; i < actions.length; i++) {
      if (i === actions.length - 1) dispatch(actions[i]!);
      else applySilent(actions[i]!);
    }
  };

  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Interaction mode (Lightning / Architect), cycled with shift-tab. The ref
  // mirrors the state so the async streaming loop and session setup read the
  // latest without a stale closure; `planMode` on the toolContext is the single
  // flag the engine actually acts on (set by applyMode / attachApproval).
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);
  const modeRef = useRef<ModeId>(DEFAULT_MODE);
  // Picked once per session, rendered inside the input box (PromptInput's `tip` prop).
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  // How far the transcript is scrolled back, in LINES from the bottom. Alt-screen
  // has no terminal scrollback of its own (altScreen.ts), so this is ours to
  // implement; 0 means pinned to the newest.
  const [scrollUp, setScrollUp] = useState(0);
  // The transcript's real rendered height, from measureElement — never estimated.
  const contentRef = useRef<DOMElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  /** Reading position captured at a width change, pending the first measurement at the
   *  new width. Null except across that one frame. See the width-change block below. */
  const reflowFrom = useRef<{ scrolled: number; maxScroll: number } | null>(null);
  // Each block's real rendered height, so blocks off screen can be replaced by a
  // spacer of the exact same size instead of being laid out in full — see
  // `virtualWindow.ts` for why that is the whole performance story, and why exact
  // is the word that matters.
  //
  // Keyed by the BLOCK OBJECT, not its id, and that is load-bearing rather than
  // stylistic: the transcript reducer returns a NEW object whenever a block changes
  // (streaming text growing, `live` flipping at turn end) and the same object when it
  // does not. So a changed block simply has no cached height, is rendered in full, and
  // is re-measured — cache invalidation falls out of the data model instead of needing
  // a rule that could be forgotten for some future block type. Weak, so blocks dropped
  // past the scrollback cap do not pin their heights in memory forever.
  const blockHeights = useRef<WeakMap<Block, number>>(new WeakMap());
  // Nodes captured this render, waiting to be measured once Yoga has laid them out.
  const toMeasure = useRef<Map<Block, DOMElement>>(new Map());
  // Every height is only true for the width it was measured at, so a resize throws
  // the whole table away rather than scrolling against stale numbers.
  const heightsWidth = useRef(0);
  // Bumped when a measurement lands, purely to re-render so the new height can be
  // used. Never read.
  const [, bumpHeights] = useState(0);
  // Same idea, for the footer (status line / background bar / queued bar / input
  // box / command palette / tip). Its height genuinely changes — the command
  // palette alone is 5+ rows taller open than closed — and guessing it drifted
  // from reality exactly the way an unmeasured chat height once did: either
  // wasted space above the footer, or the footer's own bottom edge pushed past
  // the terminal, which corrupts the whole frame if that's the row that tips
  // outputHeight to stdout.rows. Measured, this can't drift.
  const footerRef = useRef<DOMElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // The chat viewport's REAL height. Yoga decides it now (flexGrow beside a
  // flexShrink:0 footer); this is read back purely so the scroll maths knows how
  // much of the content is on screen.
  const chatRef = useRef<DOMElement | null>(null);
  const [chatHeight, setChatHeight] = useState(0);
  // Bumped by PromptInput when its suggestion menu changes size. Its only job is
  // to re-render App so the footer measurement below re-runs: the menu is
  // PromptInput's own state, so App is not re-rendered by it and would otherwise
  // keep sizing the chat against a footer that no longer exists — leaving the
  // menu clipped off the bottom of the frame with nothing to correct it.
  const [, bumpFooter] = useState(0);
  const onMenuChange = useCallback(() => bumpFooter((t) => t + 1), []);
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
  // Read live by the status line each tick. A getter rather than state so a usage event
  // does not force a re-render of the whole transcript — the line already re-renders
  // once a second for its timer, which is often enough for a running count.
  // The live figure the status line reads each tick. Held in a ref, and advanced by the
  // pure reducers in dynamo/liveMeter.ts, so a streamed delta does not re-render the
  // transcript just to move a number: the status line re-renders on its own timer and
  // reads the current value there.
  const meter = useRef<MeterState>(meterReset());
  const liveTokens = useCallback(() => meterValue(meter.current), []);
  const advanceTokens = useCallback(() => {
    meter.current = meterTick(meter.current);
  }, []);
  // Aborts the in-flight turn when the user presses Esc (created fresh per turn).
  const abortRef = useRef<AbortController | null>(null);
  // Which provider's key we still need, or null once we have it. Not a bare
  // boolean: with more than one provider, the key we must ask for depends on the
  // model the user is about to run, and switching models can make a different key
  // become the missing one.
  // Only when NOTHING can run. Asking about the default provider alone turned a key for
  // any of the other twelve into a dead end: a prompt the user never chose, with no way
  // There is no separate "paste this one provider's key" screen any more. It asked for
  // whichever provider happened to be configured, could not be escaped, and reappeared
  // after setup had already taken a key. Both jobs belong to screens that do them
  // properly: KeySetup on a first run, KeyManager for everything after.
  const [setupOpen, setSetupOpen] = useState(() => needsKeySetup(DEFAULT_MODEL_CONFIG.model, hasApiKey));
  // Where we are working is the widest permission there is — every other guard is scoped
  // to the workspace — so it is confirmed once, before anything else. See trust.ts.
  const { exit } = useApp();
  const startCwd = useRef(process.cwd());
  const [trustBreadth] = useState(() => rootBreadth(startCwd.current));
  const [trustOpen, setTrustOpen] = useState(() => !isTrusted(projectDir(startCwd.current), rootBreadth(startCwd.current)));
  // Bumped when a key is saved, so the list re-reads and marks it.
  const [, setSetupTick] = useState(0);
  // Opened by /key rather than by a first run, so Esc is a way back rather than a way out.
  // /key opens the key MANAGER — the keys you have, and what you can do to them.
  // Distinct from the first-run setup screen, which only ever needs to get one key in.
  const [keysOpen, setKeysOpen] = useState(false);
  const [keysTick, setKeysTick] = useState(0);
  // A /provider switch held back because that provider had no key. Finished the moment
  // one is saved for it, so choosing a provider and adding its key is one flow rather
  // than two commands with a dead end in between.
  const pendingSwitch = useRef<{ model: string; apiKeyEnv: string; label: string } | null>(null);
  // The keyboard belongs to a setup screen while one is open.
  const needsKey = setupOpen || keysOpen;
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
  //
  // `detail` (a plan, a long command) is printed into the TRANSCRIPT rather than the
  // prompt. The prompt lives in the footer, which is not height-bounded: a long one
  // makes the whole frame taller than the terminal, and at that point Ink stops
  // erasing correctly and the screen tears (see the frameHeight comment below). The
  // transcript is the part of the UI already built to hold arbitrary length — it is
  // clipped and scrollable — so long context goes there and the prompt stays one line.
  // Approvals WAIT FOR EACH OTHER rather than replacing each other. The rules and the
  // reasons live in approvalChannel.ts, where they can be tested directly; this holds
  // one instance for the session and keeps the visible slot in sync with it.
  const approvals = useRef(new ApprovalChannel<Overlay>());
  const showNextApproval = useRef(() => {
    setOverlay((current) => current ?? approvals.current.current);
  });
  const askApproval = useRef((
    question: string,
    options: string[],
    detail?: string,
    detailTitle?: string,
    freeText?: { label: string; placeholder: string },
  ) => {
    const body = detail?.trim();
    if (body) {
      // Titled → a facts block on a rail, rendered verbatim (a command must not be
      // reinterpreted as markdown). Untitled → prose, because it is a document to read.
      dispatch(detailTitle ? { type: "notice", title: detailTitle, body } : { type: "say", text: body });
    }
    const answer = approvals.current.ask({
      kind: "approval",
      question,
      options,
      // Answered through the channel, never by calling this directly — that is what
      // keeps "exactly once" and the queue order in one place.
      resolve: () => {},
      ...(freeText ? { freeText } : {}),
    } as Overlay);
    showNextApproval.current();
    return answer;
  });
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
    // Every replayed row belongs to a turn that finished long ago, so settle the
    // verbs. Without this a resumed chat opens with "Updating(App.tsx)" over an edit
    // that completed in a previous session — present tense claiming work is in
    // flight when nothing is running at all.
    dispatch({ type: "endTurn" });
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
    s.toolContext.requestApproval = (q, o, detail, title) => askApproval.current(q, o, detail, title);
    s.toolContext.backgroundShells?.setOnChange(handleBgChange);
    // Servers connect in the background and can die or revive at any time; without this
    // the /mcp view would only ever show what was true when the last key was pressed.
    s.toolContext.mcp?.setOnChange(handleMcpChange);
    // A new/swapped session inherits the current mode's behavior.
    const m = modeById(modeRef.current);
    s.toolContext.planMode = m.readOnly;
    s.toolContext.guarded = m.guarded;
    s.toolContext.guardAllowed = undefined;
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
      // Entering Sentinel restores fresh vigilance — earlier grants are cleared.
      if (m.guarded) s.toolContext.guardAllowed = undefined;
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
  const { columns: width, rows } = useTerminalSize();
  // Read live at render time as well as from the polled state above: mid-resize
  // the state can lag the real terminal by a tick, and a frame one row too TALL
  // is the failure that corrupts the screen (see the layout comment below).
  const { stdout } = useStdout();

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
      // Nothing can run at all: open setup, which is the screen for exactly that.
      void need;
      setSetupOpen(true);
    });
  }, []);

  // When a background shell finishes and Mindweave is idle, react to it automatically.
  useEffect(() => {
    if (!ready || busy || needsKey || reactingRef.current) return;
    const mgr = session.current?.toolContext.backgroundShells;
    if (mgr && mgr.pendingCount() > 0) void reactToBackground();
  }, [bgTick, busy, ready, needsKey]);

  // When the turn ends, send what's queued — CONSECUTIVE plain messages together, as
  // one turn (see messageQueue.ts for why), a slash command on its own. Chains: each
  // send ends, this fires again, until the queue is empty.
  useEffect(() => {
    if (busy || !ready || needsKey || overlay) return;
    const next = drainQueue(queueRef.current);
    if (!next) return;
    queueRef.current = next.rest;
    setQueued(next.rest);
    void handleSubmit(next.send);
  }, [busy, ready, needsKey, overlay]);

  // ↑ or Esc takes the queue back into the input box, editable, and empties it. This
  // is the ONLY way to change your mind about something already queued, so it has to
  // work while Mindweave is still working — that is the whole moment it is for.
  //
  // Esc is the exception, and deliberately so: while a turn is running Esc means STOP,
  // and a keypress that both stopped the turn and silently emptied the queue would be
  // two decisions on one key. So mid-turn Esc is declined here and the interrupt
  // handler above has it alone. ↑ has no such conflict and always pops.
  const popQueue = useCallback(
    (input: string, cursor: number, via: "up" | "escape") => {
      if (via === "escape" && busy) return undefined;
      const popped = popAllQueued(queueRef.current, input, cursor);
      if (!popped) return undefined;
      queueRef.current = [];
      setQueued([]);
      return popped;
    },
    [busy],
  );

  // Start/stop a turn's timer (drives the persistent status line).
  function startTurn() {
    turnStart.current = Date.now();
    usageSamples.current = [];
    meter.current = meterReset();
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
        // Anything still waiting to be asked is answered as declined. A queued approval
        // has no overlay to press Esc on, so without this the tool holding it would wait
        // for the rest of the session on a question the user has already stopped.
        approvals.current.dismissWaiting(APPROVAL_DISMISSED);
        // Esc means STOP — including anything running in the background (a starting app,
        // a dev server). Aborting the turn alone left those alive, so the app still opened.
        const mgr = session.current?.toolContext.backgroundShells;
        for (const sh of mgr?.running() ?? []) mgr?.kill(sh.id, "user");
        flush.current = true; // drain the rest of the queue immediately
        // A held-but-unsettled group (see pump()) waits for the NEXT enqueued
        // action to notice anything changed — nothing schedules a timer while
        // holding any more. If this was the interrupt that ends the turn with
        // no further engine events coming, that held group would otherwise
        // never get released. Nudging pump() here costs nothing when there's
        // nothing held (it's a no-op on an empty queue) and closes that gap.
        pump();
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

  // Scrolling the transcript. The alternate screen keeps no scrollback of its
  // own, so without this there is no way to look at anything that has left the
  // viewport. Moves by blocks rather than lines: a block is the unit the
  // transcript is made of, so a step never lands halfway through a diff.
  // Scrolls by LINES. The clamp to the content's real height happens at render,
  // where that height is known, so this only has to refuse to go below zero.
  //
  // APPLIED IMMEDIATELY, and that is a decision, not an omission. (An earlier comment
  // here described an eased version and a `smoothScroll.ts` that no longer exists —
  // left behind when the easing was removed, and exactly the kind of stale claim that
  // sends the next reader looking for a file that is not there.)
  //
  // An eased version was built and shipped (200ms ease-in-out, copied from Gemini CLI's
  // ScrollableList) and it was WORSE, immediately and obviously: a mouse wheel sends
  // notches faster than 200ms apart, so every notch queued behind the last one and the
  // view visibly trailed the wheel. Easing suits a scroll the PROGRAM initiates — jump
  // to top, jump to a match — where the animation explains a movement the user did not
  // make. A wheel notch is a direct manipulation, and direct manipulation must be 1:1
  // with the input or it reads as lag, because it IS lag. Do not re-add it here.
  const scrollBy = useCallback((lines: number) => {
    setScrollUp((s) => Math.max(0, s + lines));
  }, []);

  useInput(
    (_input, key) => {
      // Shift+arrows as well as PageUp/PageDown: Windows consoles routinely eat
      // the paging keys before an app sees them, so there has to be a second way in.
      if (key.pageUp) scrollBy(PAGE_LINES);
      else if (key.pageDown) scrollBy(-PAGE_LINES);
      else if (key.upArrow && key.shift) scrollBy(1);
      else if (key.downArrow && key.shift) scrollBy(-1);
    },
    { isActive: ready && overlay === null },
  );

  // Measure the transcript's real rendered height after every render. Deliberately
  // has no dependency list: the height changes for reasons no dep could name — a
  // reply landing, a terminal resize re-wrapping every paragraph — and the guard
  // below means a render that changed nothing sets no state, so this settles
  // rather than looping.
  useEffect(() => {
    if (!contentRef.current) return;
    const { height } = measureElement(contentRef.current);
    setContentHeight((h) => (h === height ? h : height));
    // A resize re-wrapped the transcript and this is the first real height for the new
    // width, so the reading position recorded above can now be converted into a line
    // count that means the same thing. Cleared immediately: this must happen once per
    // resize, not on every measurement afterwards.
    const from = reflowFrom.current;
    if (from) {
      reflowFrom.current = null;
      const next = reflowScroll(from.scrolled, from.maxScroll, Math.max(0, height - chatRows));
      setScrollUp((s) => (s === next ? s : next));
    }
  });

  // Measure each block that was rendered without a known height yet, so the next
  // frame can replace it with an exact spacer when it scrolls out of view.
  //
  // No dependency list, for the same reason as the measurements around it: a block's
  // height changes for reasons no dep could name. It settles rather than looping
  // because a height is recorded once per block object and the re-render is only
  // requested when something was actually recorded.
  useEffect(() => {
    if (toMeasure.current.size === 0) return;
    let learned = false;
    for (const [block, node] of toMeasure.current) {
      if (blockHeights.current.has(block)) continue;
      const { height } = measureElement(node);
      // A height of 0 is not a measurement, it is a block that has not been laid out
      // yet. Recording it would collapse the block to nothing the moment it scrolled
      // off — the exact class of silent, permanent corruption this cache must not have.
      if (height > 0) {
        blockHeights.current.set(block, height);
        learned = true;
      }
    }
    toMeasure.current.clear();
    if (learned) bumpHeights((t) => t + 1);
  });

  // Same measurement, for the footer — see footerHeight above.
  useEffect(() => {
    if (!footerRef.current) return;
    const { height } = measureElement(footerRef.current);
    setFooterHeight((h) => (h === height ? h : height));
  });

  // And for the chat viewport. Unlike the footer's, this measurement is not part
  // of any layout decision — it only tells the scroll maths how many rows are
  // visible, so a one-frame lag here is invisible.
  useEffect(() => {
    if (!chatRef.current) return;
    const { height } = measureElement(chatRef.current);
    setChatHeight((h) => (h === height ? h : height));
  });

  // The wheel. Read straight off stdin rather than through useInput, because a
  // mouse report is not a keypress and Ink's key parser has no notion of one.
  useEffect(() => {
    if (!ready) return;
    const off = enableMouse();
    const stdin = process.stdin;
    const onData = (chunk: Buffer | string) => {
      for (const dir of readWheel(chunk.toString("utf8"))) {
        scrollBy(dir === "up" ? WHEEL_LINES : -WHEEL_LINES);
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      off();
    };
  }, [ready, scrollBy]);

  function endTurn() {
    if (turnStart.current != null) setLastMs(Date.now() - turnStart.current);
    // Settle every tool row this turn produced into its past-tense verb. The single
    // funnel for a turn ending (normal completion, error, interrupt), so no row is
    // left reading "Reading" once nothing is being read.
    dispatch({ type: "endTurn" });
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
  // row, a sentence, the answer) on a steady beat, so the turn reads as work being
  // done rather than as output being thrown at the screen. The beat and the reasons
  // for it live in revealPace.ts; every path below goes through it, with no
  // exceptions, because an exception IS a change of tempo and that is the one thing
  // the beat cannot survive.
  //
  // It is a MINIMUM since the last reveal, not an added delay: if the model already
  // spent that long between events, the next reveal is immediate. Silent text
  // accumulation and a tool RESOLVING in place are never paced — only the
  // APPEARANCE of a new block is.
  const revealQ = useRef<Action[]>([]);
  const lastRevealAt = useRef(0);
  const pumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamDone = useRef(false);
  const flush = useRef(false); // Esc → drain the rest with no pacing
  // Whether a "tools" group is currently visible (already revealed and still
  // open). Tracked at this layer — not read from transcript state — because the
  // decision it drives (does the NEXT grouped toolStart need to be held) has to
  // be made before that action is even dispatched.
  const groupOpen = useRef(false);

  // A new block appears (paced); a token (silent), a tool resolution (in place), a
  // discovery call folding into an ALREADY-OPEN group, or a sub-agent's nested
  // activity (folds into / resolves its rail in place) is not.
  //
  // Both kinds of tool start are paced AND held: pump() waits for the matching
  // toolEnd so the row arrives complete, then reveals the pair on the beat. (It used
  // to show instantly as a bare header and then patch in place; that was the
  // two-stage reveal the hold mechanism exists to remove.) Holding and pacing are
  // separate questions — one is about the block being whole, the other about when a
  // whole block is allowed on screen — and a standalone row used to answer only the
  // first, which is why a burst of edits landed together however calm the rest of
  // the turn was.
  const isPaced = (a: Action) => {
    if (a.type === "toolStart") return a.group ? !groupOpen.current : true;
    return (
      a.type !== "token" &&
      a.type !== "toolEnd" &&
      a.type !== "subToolStart" &&
      a.type !== "subToolEnd" &&
      a.type !== "subagentEnd"
    );
  };

  function enqueueReveal(a: Action) {
    revealQ.current.push(a);
    if (!pumpTimer.current) pump();
  }

  // Reveal the next block on the beat (a minimum since the last reveal, not an added
  // delay), then stamp the clock and carry on draining. Every paced path in pump()
  // goes through here, so the tempo is decided in exactly one place.
  function schedulePaced(reveal: () => void) {
    const wait = revealWait({ now: Date.now(), lastRevealAt: lastRevealAt.current, flush: flush.current });
    pumpTimer.current = setTimeout(() => {
      pumpTimer.current = null;
      reveal();
      lastRevealAt.current = Date.now();
      pump();
    }, wait);
  }

  function pump() {
    // Apply immediate actions at once: silent tokens, in-place resolves, and a
    // discovery call folding into a group that's already on screen.
    while (revealQ.current.length > 0 && !isPaced(revealQ.current[0]!)) {
      const a = revealQ.current.shift()!;
      if (a.type === "token") applySilent(a);
      else dispatch(a);
      // A group stays open once shown; anything that isn't part of it (a
      // standalone tool, narration, a sub-agent) closes it, mirroring exactly
      // what the transcript reducer's own closeToolGroup does on the same actions.
      if (a.type === "toolStart" && a.group) groupOpen.current = true;
      else if (a.type !== "toolEnd") groupOpen.current = false;
    }
    if (revealQ.current.length === 0) {
      if (streamDone.current) {
        streamDone.current = false;
        endTurn();
      }
      return;
    }
    const front = revealQ.current[0]!;

    // Narration waiting in front of a tool call gets the beat to itself. `toolStart`
    // seals the open assistant block as part of its own action, so without this the
    // sentence and the row it introduces reach the terminal in the SAME paint and
    // land as one clump — the pacer's blind spot, since nothing was ever queued for
    // the text. Sealing it first lets the sentence be read before the row appears
    // under it. Only when a block will actually result (see narrationPending): the
    // narration budget is one line per turn, and pausing for a sentence that seals
    // to nothing would be an empty beat, which is a stall rather than a rhythm.
    if (front.type === "toolStart" && narrationPending(stateRef.current)) {
      schedulePaced(() => {
        dispatch({ type: "sealNarration" });
        groupOpen.current = false;
      });
      return;
    }

    // A tool's opening call is HELD — not dispatched, not scheduled, nothing shown —
    // until its result is queued behind it, so the row never appears bare and then
    // sprouts a body a second later. Holding costs nothing that was worth having:
    // the header alone names a call whose result is the entire point of showing it,
    // and the footer's live timer is what says work is happening. There is no
    // time-based fallback (see groupReveal.ts): every later enqueueReveal re-enters
    // pump, which re-checks. Esc sets `flush`, and `streamDone` releases the hold
    // unconditionally — once the stream is over no further event can arrive, so a
    // call whose end never came (an abort mid-flight) must still be shown rather
    // than stranding the queue and the turn with it.
    //
    // Then the whole held burst reveals in ONE paint, on the beat. Painting per
    // action would show the block assembling itself (header, then a running row,
    // then the resolved row): Ink's root is a legacy React root, so every dispatch
    // flushes synchronously and each one is a frame the terminal actually shows.
    if (front.type === "toolStart") {
      const isNewGroup = front.group && !groupOpen.current;
      if (isNewGroup) {
        if (planGroupReveal(groupSettled(revealQ.current.slice(1)), flush.current) === "hold") return;
      } else if (!(resultQueued(front.toolId, revealQ.current) || flush.current || streamDone.current)) {
        return;
      }
      schedulePaced(() => {
        // Measured HERE, not when the beat was scheduled: the queue keeps growing
        // while we wait, and a group's burst can gain members in that window. A span
        // measured early would leave the stragglers behind to open a second group,
        // splitting one burst across two blocks.
        let take: number;
        if (isNewGroup) {
          take = 0;
          while (take < revealQ.current.length && isGroupMember(revealQ.current[take]!)) take++;
        } else {
          const end = revealQ.current.findIndex((x) => x.type === "toolEnd" && x.toolId === front.toolId);
          take = end === -1 ? 1 : end + 1;
        }
        applyBatch(revealQ.current.splice(0, take));
        // Resolved either way — the action that closes the block follows next.
        groupOpen.current = false;
      });
      return;
    }

    // Every remaining paced block (a sealed reply, a sub-agent start, notes) reveals
    // on the same beat.
    schedulePaced(() => {
      const a = revealQ.current.shift();
      if (a) {
        dispatch(a);
        if (a.type !== "toolEnd") groupOpen.current = a.type === "toolStart" && !!a.group;
      }
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
    // Pick up an edit the model made to MINDWEAVE.md, but only if one actually happened
    // — this is a no-op otherwise. Re-reading unconditionally used to look free and was
    // not: it rewrites the system prompt string, which discards the entire cached prefix
    // (base prompt, tool schemas, project snapshot) at 1.25x rewrite cost.
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
        // An AUTOMATIC compaction, mid-turn. Queued like everything else so it appears
        // in the order it happened, rather than jumping ahead of the rows around it.
        onCompaction: (report) => enqueueReveal({ type: "compaction", report }),
        onEvent: (e) => {
          if (e.type === "text") {
            meter.current = meterDelta(meter.current, e.delta.length);
            enqueueReveal({ type: "token", delta: e.delta });
          } else if (e.type === "reasoning") {
            // Not rendered, but it is generated text the provider bills as output, so
            // leaving it out would make the live figure undershoot on a thinking model.
            meter.current = meterDelta(meter.current, e.delta.length);
          } else if (e.type === "replyReset") {
            enqueueReveal({ type: "resetReply" });
          } else if (e.type === "tool" && e.phase === "start") {
            // The spawn call itself is rendered by its sub-agent block, not a raw row.
            if (e.name === "spawn_subagent") return;
            const d = toolDisplay(e.name, e.args);
            if (e.agent) {
              // A sub-agent's own tool call — fold it into that worker's nested rail.
              enqueueReveal({ type: "subToolStart", agentId: e.agent, toolId: e.id, name: d.name, arg: d.arg, action: d.kind });
            } else {
              enqueueReveal({ type: "toolStart", toolId: e.id, name: d.name, arg: d.arg, meta: d.meta, action: d.kind, group: isGroupable(e.name) });
            }
          } else if (e.type === "tool" && e.phase === "end") {
            if (e.name === "spawn_subagent") return;
            if (e.agent) {
              enqueueReveal({ type: "subToolEnd", agentId: e.agent, toolId: e.id, ok: !e.error, summary: e.summary });
            } else {
              enqueueReveal({
                type: "toolEnd",
                toolId: e.id,
                ok: !e.error,
                summary: e.summary,
                detail: e.detail,
                detailKind: e.detailKind,
                quiet: e.quiet,
                action: e.displayKind,
                name: e.displayName,
              });
            }
            // A lift (see approval.ts's liftForbidden) happens INSIDE the call that
            // just ended, with no ToolResult of its own to carry it — drained here,
            // right after the call it happened during, as its own governor block.
            const gov = session.current?.toolContext.governance;
            for (const notice of gov?.notices ?? []) {
              const govId = `governor-${crypto.randomUUID()}`;
              enqueueReveal({ type: "toolStart", toolId: govId, name: "Governor", action: "governor" });
              enqueueReveal({ type: "toolEnd", toolId: govId, ok: true, summary: notice });
            }
            if (gov) gov.notices = [];
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
              // The written slice, so cache writes are priced at the rate the provider
              // actually charges for them (1.25x base input on Anthropic) instead of
              // the plain input rate. Absent on providers that don't report it.
              ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
            });
            setTaskUsage(summarizeTask(usageSamples.current, s.modelConfig.model));
          }
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
      // An account-level refusal (key rejected, balance spent, rate limited) is a
      // STATE, not a crash: nothing is broken and the red error block would say the
      // opposite. It becomes the same calm notice the permission prompt uses, with
      // the provider's own sentence quoted inside it. Anything else — a malformed
      // request, a bug of ours — stays loud, which is the point of classifying
      // narrowly. See drivers/providerError.ts.
      const refusal = accessRefusal(error, providerOf(s.modelConfig.model).label, otherProviderHasKey(s.modelConfig.model));
      if (refusal) enqueueReveal({ type: "notice", title: refusal.title, body: refusal.body });
      else enqueueReveal({ type: "error", text: `⚠ ${errText(error)}` });
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
        await compactNow(resumed, {
          onActivity: (line, opts) => note(line, opts),
          onCompaction: (report) => dispatch({ type: "compaction", report }),
        });
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

  /**
   * Drop the current chat and start a clean session in the same project.
   *
   * `wipeScreen` is the difference between the two ways in. Reached through
   * `/continue`, the old conversation is still worth seeing — you went looking for
   * sessions, so the history above is context for the choice you just made. Reached
   * through `/clear`, you asked for it to be gone, and leaving it on screen while the
   * model can no longer see it is the worst of both: it reads as still being there.
   *
   * What SURVIVES is as deliberate as what goes. The project's rules, skills and
   * forbidden paths are properties of the folder, not of the conversation. Undo history
   * stays: clearing the conversation does not un-edit the files, and taking away the
   * only way to roll them back would leave the user worse off than before.
   *
   * Background shells do NOT survive, because they cannot. A shell belongs to its
   * session's tool context, and the new session builds its own — leaving the old ones
   * alive would hold ports and file handles that nothing can reach or stop any more.
   * So they are killed, and `/clear` SAYS how many, because silently stopping someone's
   * dev server is exactly the kind of surprise a one-word command should not spring.
   */
  async function startFresh(wipeScreen = false) {
    const s = session.current;
    if (!s) return;
    // Counted BEFORE the lanes stop — afterwards the manager is disposed and there is
    // nothing left to count.
    const killed = s.toolContext.backgroundShells?.running().length ?? 0;
    await stopCurrentLanes();
    const fresh = await createSession(s.cwd);
    attachApproval(fresh);
    session.current = fresh;
    if (wipeScreen) {
      // The chips are keyed per conversation; a stale one would expand into a message
      // the new session never saw.
      pasteStore.current.clear();
      setScrollUp(0);
      dispatch({ type: "clear" });
    }
    note(
      killed > 0
        ? `— started a fresh session (stopped ${killed} background command${killed === 1 ? "" : "s"}) —`
        : "— started a fresh session —",
    );
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
    const choice = s ? modelsOfProvider(s.modelConfig.model)[index] : undefined;
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
    const target = modelsOf(provider)[0];
    if (!target) return;

    // Do NOT move onto — let alone SAVE — a provider we can't run. Persisting first is
    // what turned a wrong pick into a project that reopened straight into the key
    // prompt on every launch, with no way back from inside the app. Ask for the key,
    // and apply the switch only once it exists.
    if (missingKeyFor(target.id)) {
      // Open the manager rather than a prompt of its own, and finish the switch as soon
      // as a key for THIS provider is saved.
      pendingSwitch.current = { model: target.id, apiKeyEnv: manifestForModel(target.id).apiKeyEnv, label: provider.label };
      note(`${provider.label} has no key yet — add one and the switch will finish.`);
      setKeysOpen(true);
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
    } else if (o.kind === "approval") {
      approvals.current.answer(o.options[index] ?? o.options[0]!);
      showNextApproval.current();
    }
  }
  /** A typed answer, carried back with a marker so the caller can tell it from a choice. */
  function onOverlaySubmitText(text: string) {
    const o = overlay;
    setOverlay(null);
    if (o?.kind === "approval") {
      approvals.current.answer(APPROVAL_TEXT + text);
      showNextApproval.current();
    }
  }
  function onOverlayCancel() {
    const o = overlay;
    setOverlay(null);
    // Esc = declined to answer. NOT "chose option 2" — see APPROVAL_DISMISSED.
    if (o?.kind === "approval") {
      approvals.current.answer(APPROVAL_DISMISSED);
      showNextApproval.current();
    }
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
    // WHICH command this is is decided in commandRoute.ts, where it can be tested —
    // the eighteen branches below are the bodies, not the decision. The catalog is the
    // same BASE_COMMANDS list `/help` and the input's autocomplete render from, so the
    // three cannot disagree about what exists.
    const route = routeCommand(raw, {
      builtins: BASE_COMMANDS.map((c) => c.name),
      skills: s.governance.skills ?? [],
    });
    // `route` decides WHICH branch runs; these two are what the branches say back to
    // the user. They come from the same parse, so a message can never name a different
    // command from the one that ran.
    const { name, arg } = parseCommandLine(raw);

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

    // /clear — a fresh conversation without leaving the folder. Until now the only
    // way to start over was to quit and relaunch, or to go through /continue and pick
    // its third option, which is not somewhere anyone looks for "start over".
    if (name === "/clear") {
      await startFresh(true);
      return;
    }

    // /init — have the model write MINDWEAVE.md. The file is read into the cached
    // prefix of every single turn (see memory/session.ts), and nothing in Mindweave
    // ever created it: a new user had to know both that it mattered and what belonged
    // in it. Model work, not a template — what is worth always knowing about a project
    // is a judgement about THAT project.
    if (name === "/init") {
      await runDirective(
        `Write this project's MINDWEAVE.md, at the workspace root. It is read into your ` +
          `context at the start of every turn, so it must be SHORT and consist only of ` +
          `things worth knowing every single time: how to build, test and run this ` +
          `project (exact commands); the shape of the codebase and where things live; ` +
          `conventions a newcomer would otherwise get wrong; and anything surprising. ` +
          `Do not restate what is obvious from reading a file, do not summarize the ` +
          `README, and do not pad it. Look at the project first — read the manifest, the ` +
          `scripts, and enough of the source to be accurate. If MINDWEAVE.md already ` +
          `exists, IMPROVE it in place rather than replacing it, and say what you ` +
          `changed. Finish by confirming in one line what you wrote and why.`,
        "writing MINDWEAVE.md…",
      );
      return;
    }

    if (name === "/compact") {
      startTurn();
      try {
        // No "compacting…" line and no "Context compacted." afterwards: the report
        // block below says both, with the numbers, and in one settled piece rather
        // than three rows arriving separately around it.
        await compactNow(s, {
          onActivity: (line, opts) => note(line, opts),
          onCompaction: (report) => dispatch({ type: "compaction", report }),
          // `/compact focus on the auth work` — the person compacting usually knows
          // which thread they are about to keep working on. Additive: it ranks detail
          // inside the summary, it never narrows what the summary must cover.
          ...(arg ? { compactFocus: arg } : {}),
        });
        await saveSession(s);
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

      // One structured tool-shaped block (● Undo … ⎿ branch) instead of a stack of
      // separate note/say text lines — same restored/conflict/failed/skipped facts,
      // rendered the same way an edit's diff or a command's output is.
      if (restored.length > 0) {
        // The files on disk are back to their pre-turn state; drop them from the read
        // ledger so the model must re-read before it can edit them again.
        for (const p of restored) s.toolContext.reads.delete(p);
      }
      const detailLines: string[] = [];
      const summaryBits: string[] = [];
      if (restored.length > 0) {
        const from = results.length === 1 ? `"${results[0]!.label}"` : `${results.length} turns`;
        detailLines.push(`Reverted ${restored.length} file${restored.length === 1 ? "" : "s"} from ${from}:`);
        detailLines.push(...restored.map((p) => `  ↩ ${rel(p)}`));
        summaryBits.push(`${restored.length} restored`);
      }
      if (conflicts.length > 0) {
        detailLines.push(`Left alone — changed since I wrote ${conflicts.length === 1 ? "it" : "them"}:`);
        detailLines.push(...conflicts.map((p) => `  • ${rel(p)}`));
        summaryBits.push(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`);
      }
      if (failed.length > 0) {
        const retry = results.some((r) => r.retryable)
          ? " — /undo again to retry"
          : " — giving up; they're still in their edited state";
        detailLines.push(`Couldn't write ${failed.length === 1 ? "this file" : "these files"}${retry}:`);
        detailLines.push(...failed.map((p) => `  ! ${rel(p)}`));
        summaryBits.push(`${failed.length} failed`);
      }
      if (skipped.length > 0) {
        detailLines.push(`Never checkpointed (too large) — still in their edited state:`);
        detailLines.push(...skipped.map((p) => `  · ${rel(p)}`));
        summaryBits.push(`${skipped.length} skipped`);
      }
      if (results.some((r) => r.ranShell)) {
        detailLines.push("Shell commands also ran — those changes aren't covered by /undo.");
      }
      const undoToolId = `undo-${crypto.randomUUID()}`;
      dispatch({
        type: "toolStart",
        toolId: undoToolId,
        name: "Undo",
        arg: results.length === 1 ? results[0]!.label : `${results.length} turns`,
        action: "checkpoint",
      });
      dispatch({
        type: "toolEnd",
        toolId: undoToolId,
        ok: failed.length === 0,
        summary: summaryBits.join(" · "),
        detail: detailLines.join("\n"),
      });

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
    if (route.kind === "mcp-config") {
      await mcpConfigCommand(route.arg);
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

    // Both pickers refresh discovered providers first, so a model pulled since the
    // session started appears without a restart. Awaited rather than fired off: the
    // picker renders from the list, and opening on a stale one that then changes
    // under the cursor is the exact "two-stage reveal" the UI work removed.
    if (name === "/provider") {
      await refreshModels();
      setOverlay({ kind: "provider" });
      return;
    }
    // The same screen the first run uses, reopened. A key that is wrong — a typo, or one
    // pasted for a different provider — was previously only fixable by finding
    // ~/.mindweave/.env and editing it by hand: eighteen commands and not one of them
    // could replace a key, which is the commonest way a first run dies.
    if (name === "/key") {
      setKeysOpen(true);
      return;
    }

    // Both take the choice inline as well as through the picker. Typing the name and
    // getting the picker anyway — which is what happened before, because the argument
    // was dropped without a word — reads as the app not having heard you.
    if (name === "/model") {
      await refreshModels();
      if (arg) {
        const picked = resolveChoice(arg, modelsOfProvider(s.modelConfig.model), "model");
        if (picked.kind === "error") return say(picked.message);
        await applyModel(picked.index);
        return;
      }
      setOverlay({ kind: "model" });
      return;
    }

    if (name === "/think") {
      if (arg) {
        const picked = resolveChoice(arg, thinkLevels(s.modelConfig.model), "reasoning level");
        if (picked.kind === "error") return say(picked.message);
        await applyThink(picked.index);
        return;
      }
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
    if (route.kind === "skill") {
      const skill = route.skill;
      const rest = route.arg;
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
    if (route.kind === "prompt") {
      const promptRef = { server: route.server, name: route.prompt };
      const prompt = s.toolContext.mcp?.findPrompt(promptRef.server, promptRef.name);
      if (!prompt) {
        say(`No MCP prompt ${name}. Run /mcp to see which servers are connected.`);
        return;
      }
      const rest = route.arg;
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


    say(unknownCommandMessage(name));

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
  // Asked BEFORE anything else, including the key prompt: agreeing to hand over a key is
  // a smaller decision than agreeing to what the agent may touch, and the second one is
  // the reason the first matters.
  if (trustOpen) {
    return (
      <TrustGate
        rows={rows}
        cwd={startCwd.current}
        breadth={trustBreadth}
        warning={breadthWarning(trustBreadth, startCwd.current)}
        persists={trustPersists(trustBreadth)}
        version={versionLabel()}
        docsUrl={MINDWEAVE_DOCS_URL}
        onTrust={() => {
          rememberTrust(projectDir(startCwd.current), trustBreadth);
          setTrustOpen(false);
        }}
        onQuit={() => exit()}
      />
    );
  }

  // FIRST RUN: nothing can run yet, so offer every provider rather than one. The user
  // adds as many keys as they like and continues when they are ready. See KeySetup.
  if (setupOpen) {
    return (
      <KeySetup
        rows={rows}
        view={setupView(hasApiKey)}
        version={versionLabel()}
        envPath={globalEnvPath()}
        docsUrl={MINDWEAVE_DOCS_URL}
        onSaveKey={(row, key) => {
          saveApiKey(row.envVar, key);
          // Re-read so the list marks it immediately and Continue lights up.
          reloadConfig(session.current?.cwd ?? process.cwd());
          setSetupTick((n) => n + 1);
        }}
        onContinue={() => {
          setSetupOpen(false);
          const s = session.current;
          if (!s) return;
          if (!missingKeyFor(s.modelConfig.model)) {
            note("you're all set. ask me anything.");
            return;
          }
          const fallback = usableFallback(s.modelConfig.model, hasApiKey);
          if (fallback) void switchTo(fallback, providerOf(fallback).label);
          else note("you're all set. ask me anything.");
        }}
      />
    );
  }


  // Record the sent text in history (no consecutive dupes). While busy, queue it
  // (the input stays live); the turn-end effect sends it next. Otherwise handle now.
  function onSend(text: string) {
    // Sending snaps back to the newest: your own message arriving off-screen,
    // above where you are scrolled to, reads as the app having ignored you.
    setScrollUp(0);
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
    // /key sits where the prompt sits, like every other thing that asks something. It
    // used to replace the whole screen for a list of three keys, which is the wrong
    // weight for changing a setting and leaves nothing to come back to.
    if (keysOpen) {
      return (
        <KeyManager
          key={keysTick}
          providers={providerRows()}
          keysOf={(p) => keyRowsFor(p)}
          nextSlot={(p) => nextSlotFor(p)}
          width={width}
          reveal={(row) => keysFor(row.apiKeyEnv).find((k) => k.slot === row.slot)?.value ?? ""}
          onActivate={(row) => {
            useApiKey(row.apiKeyEnv, row.slot);
            note(`${row.label} key ${row.slot} ${row.hint} is now the active one.`);
            setKeysTick((n) => n + 1);
          }}
          onSave={(provider, slot, key) => {
            saveApiKey(provider.apiKeyEnv, key, slot);
            setKeysTick((n) => n + 1);
            const held = pendingSwitch.current;
            if (held && held.apiKeyEnv === provider.apiKeyEnv) {
              pendingSwitch.current = null;
              setKeysOpen(false);
              void switchTo(held.model, held.label);
            }
          }}
          onRemove={(row) => {
            removeApiKey(row.apiKeyEnv, row.slot);
            note(`removed ${row.label} key ${row.slot} ${row.hint}.`);
            setKeysTick((n) => n + 1);
          }}
          onClose={() => setKeysOpen(false)}
        />
      );
    }
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
        const n = modelsOf(p).length;
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
      const models = modelsOfProvider(id);
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
    // approval — a plan, a Sentinel action, a forbidden-path lift. Bordered rather than
    // listed: it interrupts the user's work and the answer commits them to something,
    // so it should read as a stop, not as more output.
    return (
      <ApprovalBox
        question={overlay.question}
        options={overlay.options}
        width={width}
        onSelect={onOverlaySelect}
        onCancel={onOverlayCancel}
        {...(overlay.freeText ? { freeText: overlay.freeText } : {})}
        onSubmitText={onOverlaySubmitText}
      />
    );
  }
  const overlayView = buildOverlayView();

  // Alt-screen owns every row, so the app decides for itself what is on screen.
  //
  // Two hard constraints, both found by measuring Ink rather than reasoning about it:
  //
  //  1. The frame must be STRICTLY SHORTER than the terminal. At `outputHeight >=
  //     stdout.rows`, Ink abandons its normal erase-and-redraw and writes
  //     `clearTerminal + output` instead (ink.js), which never updates
  //     log-update's `previousLineCount`. The next ordinary frame then erases the
  //     wrong number of lines, so old text stays behind and new text lands on top
  //     of it — the overlapping, half-drawn screen with the header scrolled away.
  //  2. Yoga cannot clip a chat. Children default to `flexShrink: 1` so an
  //     overfull column COMPRESSES (rows silently dropped from the middle), and
  //     with `flexShrink: 0` every layout clips the END of the axis — which is
  //     the newest message.
  //
  // So the transcript renders in FULL inside a clipped viewport, and a negative
  // top margin slides it — the same mechanism a scrollable pane uses anywhere
  // else. `measureElement` reports the rendered height, so the scroll maths runs
  // on what the terminal actually drew rather than a guess about it.
  //
  // An earlier cut estimated each block's height and rendered only the ones that
  // fit. It scrolled a whole block per step, which meant a long block jumped the
  // view past everything inside it, and any drift between the estimate and the
  // real render made content shift around. Measuring removes the estimate, and
  // scrolling by LINES removes the jumping.
  const committed = stateRef.current.committed;
  const tail = stateRef.current.tail;
  const allBlocks: Block[] = [...committed, ...tail];

  // Never render a frame as tall as the terminal (constraint 1). `stdout.rows`
  // is read live as well as from state, because during a resize the polled
  // state can briefly lag the real terminal, and being one row too TALL is the
  // failure mode that corrupts the screen.
  const liveRows = stdout?.rows ?? rows;
  const frameHeight = Math.max(3, Math.min(rows, liveRows) - 1);
  // The chat's HEIGHT is no longer computed here — Yoga is given the job instead
  // (the viewport below is flexGrow:1 beside a flexShrink:0 footer), and this
  // measurement is now only read for the SCROLL maths.
  //
  // It used to be `frameHeight - BANNER_ROWS - footerHeight`, and that arithmetic
  // could not be right at the moment it mattered most. `footerHeight` is measured
  // from the PREVIOUS render, so on the frame where the input box grows a line —
  // exactly when a message wraps — the chat was still sized against the old,
  // shorter footer. Total content then exceeded the frame by one row and the
  // excess clipped from the bottom, which is where the tip line lives. REPRODUCED
  // with a bare Ink render: at 3 wrapped input lines with a stale footerHeight,
  // the tip vanishes; with the flex layout it survives 1, 3, 6 and 11 lines.
  //
  // Yoga computes both in a single pass, so there is no frame where the two
  // disagree. `chatRows` is measured from the viewport itself; a lag there costs
  // nothing, because it only clamps how far the user may scroll.
  const chatRows = Math.max(1, chatHeight || frameHeight - BANNER_ROWS - footerHeight);
  // How many command-palette rows the footer could safely grow by. Reserves a
  // conservative fixed cost for what's always there (status line, the bordered
  // input box, the tip line) and a floor of MIN_CHAT_ROWS so the chat is never
  // fully eclipsed by an open menu; MENU_CHROME_ROWS is the palette's own
  // border/title/hint. What's left becomes item rows, floored at a usable
  // minimum and capped so a huge terminal doesn't show an ungainly wall.
  const menuBudget = frameHeight - BANNER_ROWS - MIN_CHAT_ROWS - FOOTER_BASE_ROWS - MENU_CHROME_ROWS;
  const maxMenuItems = Math.max(3, Math.min(12, menuBudget));
  const runningShells = session.current?.toolContext.backgroundShells?.running() ?? [];
  // Where the transcript sits in the viewport, and how far it can travel. Extracted
  // to `chatAnchor.ts` so the rule is unit-tested rather than eyeballed — see there
  // for why a short transcript now rests ON the input box instead of stranding
  // itself at the top of the screen, and why that cannot disturb a scrolled frame.
  const { marginTop: chatOffset, restsOnFooter } = chatLayout(contentHeight, chatRows, scrollUp);
  // Only the blocks that can still be reached are worth laying out. Yoga lays
  // out every child on every render — including one caused by a keystroke — so
  // an unbounded transcript makes typing slower the longer you have been
  // talking. This is generous enough to scroll through comfortably.
  const rendered = allBlocks.length > SCROLLBACK_BLOCKS ? allBlocks.slice(-SCROLLBACK_BLOCKS) : allBlocks;
  const offset = allBlocks.length - rendered.length;

  // Which of those actually reach Yoga. Everything else becomes a spacer of exactly
  // the height it would have occupied, so `contentHeight` — and therefore `chatOffset`
  // above, and the whole scroll mechanism — is bit-for-bit what it was when every
  // block was laid out in full. See `virtualWindow.ts`.
  if (heightsWidth.current !== width) {
    // Every recorded height was measured at a different width and is now a lie. Throw
    // the table away; the frame below renders in full and re-measures.
    blockHeights.current = new WeakMap();
    heightsWidth.current = width;
    // Remember WHERE the reader was, as a proportion of the scrollable range, before
    // the re-wrap changes what a line means. `scrollUp` is a line count, and a line is
    // not the same distance at a different width, so a scrolled reader is otherwise
    // carried off by a resize they did not intend as navigation. Applied once the new
    // height has actually been measured — see the effect that consumes this.
    reflowFrom.current = { scrolled: scrollUp, maxScroll: Math.max(0, contentHeight - chatRows) };
  }
  // Only a MEASURED prefix can be virtualized: a block whose height is unknown cannot
  // be replaced by a spacer, because there is no honest number to give the spacer.
  // Unmeasured blocks are always the newest ones (the reducer appends, and a changed
  // block is a new object), which are also the ones on screen when pinned to the
  // bottom — so in practice this prefix is everything but the last block or two.
  let known = 0;
  const knownHeights: number[] = [];
  while (known < rendered.length) {
    const h = blockHeights.current.get(rendered[known]!);
    if (h === undefined) break;
    knownHeights.push(h);
    known++;
  }
  const win = virtualWindow(knownHeights, -chatOffset, chatRows);
  if (perfEnabled()) {
    // The single fact that says whether the virtualization is doing anything at all:
    // `drew` should be a small constant while `blocks` grows. If they track each
    // other, heights are not being measured and every block is still being laid out.
    const drew = win.end - win.start + (rendered.length - known);
    perf(
      `frame blocks=${rendered.length} known=${known} drew=${drew} ` +
        `rows=${chatRows} shift=${-chatOffset} content=${contentHeight}`,
    );
  }
  // Rows between the end of the window and the first unmeasured block. Rendering the
  // unmeasured tail is not optional — it is how those blocks get measured at all.
  const padMiddle = win.padBottom;

  return (
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      {/* flexShrink:0 on the banner and the chat wrapper below (NOT on anything
          inside the chat viewport itself — that's untouched) protects against a
          real, confirmed failure mode: for one frame right when the command
          palette opens/resizes, chatRows is still computed from the PREVIOUS
          footerHeight (measurement lags a render), so the frame's total content
          can transiently exceed frameHeight. Without flexShrink:0 here, Yoga's
          default (shrink to fit) silently compresses the banner or drops the
          header text outright — verified with a bare Ink render. With it, the
          excess instead clips cleanly from the BOTTOM of the frame (the tail of
          the command palette), which is the harmless direction to lose content
          in, and only for the one frame until the real footerHeight lands. */}
      <Box flexShrink={0}>
        <Banner width={width} mode={mode} modelConfig={session.current?.modelConfig} busy={busy} />
      </Box>

      {/* flexGrow:1 + minHeight:1, NOT a computed height: the footer takes what it
          needs and the chat takes the rest, decided in one Yoga pass. This is what
          stops the tip line being clipped on the frame where the input box grows. */}
      <Box ref={chatRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {/* A short conversation rests ON the footer instead of floating at the top
            of the screen. This is a flex SPACER rather than a computed margin on
            purpose: Yoga sizes it from the leftover space in the same pass that lays
            the frame out, where a margin would have to be derived from `chatRows`,
            which lags a frame and is unknown entirely on the first render. A render
            probe rejected the margin version — it left a gap on a settled frame and
            pushed the whole transcript past the clip edge on the first one.

            It shrinks to nothing the moment the transcript overflows, so the
            scrolling path below is untouched. */}
        {restsOnFooter ? <Box flexGrow={1} flexShrink={1} /> : null}
        <Box flexDirection="column" flexShrink={0} marginTop={chatOffset}>
          {/* The ref sits on a box with NO margin of its own, so the measured
              height is the content's alone and cannot drift as it scrolls. */}
          <Box ref={contentRef} flexDirection="column" flexShrink={0}>
            {/* Blocks scrolled off the top, as one box of exactly their height. */}
            {win.padTop > 0 ? <Box flexShrink={0} height={win.padTop} /> : null}
            {rendered.slice(win.start, win.end).map((b, i) => {
              const idx = win.start + i;
              return (
                // flexShrink:0 is load-bearing — without it Yoga compresses an
                // overfull column and silently drops rows out of the middle.
                <Box
                  key={b.id}
                  ref={(node: DOMElement | null) => {
                    if (node && !blockHeights.current.has(b)) toMeasure.current.set(b, node);
                  }}
                  flexShrink={0}
                  flexDirection="column"
                >
                  <BlockView block={b} columns={width} tightTop={isTight(allBlocks, offset + idx)} />
                </Box>
              );
            })}
            {/* Measured blocks between the window and the unmeasured tail. */}
            {padMiddle > 0 ? <Box flexShrink={0} height={padMiddle} /> : null}
            {/* The unmeasured tail. Rendered in full because there is no honest
                spacer height for a block nobody has measured yet — and rendering it
                is what produces the measurement. */}
            {rendered.slice(known).map((b, i) => {
              const idx = known + i;
              return (
                <Box
                  key={b.id}
                  ref={(node: DOMElement | null) => {
                    if (node && !blockHeights.current.has(b)) toMeasure.current.set(b, node);
                  }}
                  flexShrink={0}
                  flexDirection="column"
                >
                  <BlockView block={b} columns={width} tightTop={isTight(allBlocks, offset + idx)} />
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>

      {/* Everything below is what footerHeight (above) measures — one Box, so a
          single measurement covers the status line, the input box, and whatever
          the command palette currently costs, whether that's open or closed. */}
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        {/* One blank row between the conversation and the footer, ALWAYS.
            It lives here rather than as a margin on the status line, because the
            status line is not always rendered — a session that has not run a turn
            has nothing to report — and the gap was disappearing with it, leaving the
            last line of a reply touching the input box. A single spacer inside the
            measured footer keeps it unconditional and keeps `footerHeight` honest,
            which a margin (laid outside the box) would not. */}
        <Box flexShrink={0}><Text> </Text></Box>
        {/* Every direct child here gets its own flexShrink:0 too — same reason
            as the banner/chat wrapper above: a footer that's itself allowed to
            compress can eat its own border lines and merge rows together
            (confirmed with a bare Ink render) instead of the clean bottom-clip
            flexShrink:0 actually gives. */}
        {/* Persistent status line: spinner + timer while working,
            "✻ Cooked for 1m 23s · N tokens" once finished. */}
        <Box flexShrink={0}>
          <StatusLine busy={busy} startedAt={turnStart.current} lastMs={lastMs} usage={taskUsage} received={liveTokens} advance={advanceTokens} />
        </Box>

        {/* Messages queued while busy — sent in order when the turn ends. */}
        <Box flexShrink={0}>
          <QueuedBar queued={queued} />
        </Box>

        <Box flexShrink={0} flexDirection="column">
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
              maxMenuRows={maxMenuItems}
              onMenuChange={onMenuChange}
              onQueuePop={popQueue}
            />
          ) : (
            <Box paddingX={1}>
              <Text dimColor>starting…</Text>
            </Box>
          )}
        </Box>

        {/* Below the input: the reference (NEWUI.txt) shows a "[BG] N running:
            $ cmd1 • $ cmd2" line in exactly this spot while anything is
            backgrounded, with the tip explicitly absent until it's done — not
            a separate line above the input, and not shown alongside the tip. */}
        {overlayView ? null : runningShells.length > 0 ? (
          <Box flexShrink={0}>
            <BackgroundBar shells={runningShells} />
          </Box>
        ) : (
          <Box flexShrink={0}>
            <Text dimColor>{"  tip: "}{tip}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// The banner's own rows: the title line, the rule under it, and its bottom
// margin. Subtracted from the frame so the chat gets exactly what's left —
// see the layout comment at the render site.
const BANNER_ROWS = 3;
/** Always keep at least this much chat visible, even with the command palette open. */
const MIN_CHAT_ROWS = 3;
/** Conservative fixed footer cost besides the palette: the blank spacer row, the
 *  status line, the bordered input box, and the tip line. */
const FOOTER_BASE_ROWS = 7;
/** The palette's own chrome: title, the "Tab completes" hint, top+bottom border. */
const MENU_CHROME_ROWS = 4;

/** Whether a block hugs the one above it — consecutive tool rows have no blank
 *  line between them. Takes the FULL list, not the rendered slice, so the first
 *  visible block still spaces correctly against the one scrolled off above it. */
function isTight(all: readonly Block[], i: number): boolean {
  const block = all[i];
  const prev = i > 0 ? all[i - 1] : undefined;
  return !!block && block.kind === "tool" && !!prev && prev.kind === "tool";
}

/** Lines PageUp/PageDown move per press. */
const PAGE_LINES = 10;
/** Lines one wheel notch moves. Three is the usual terminal step, and a flick
 *  sends several reports, so it accumulates into a natural glide. */
const WHEEL_LINES = 3;
/** How much of the transcript stays scrollable. Every rendered block is laid out
 *  on every render, so this bounds what typing costs in a long conversation. */
const SCROLLBACK_BLOCKS = 150;

/**
 * The loom shuttle that runs beside the name while a turn is working.
 *
 * SMOOTHNESS COMES FROM HALF CELLS, not from a faster timer. Box drawing gives four
 * states for a horizontal run — light `─`, heavy on the left half `╾`, heavy on the
 * right half `╼`, heavy across `━` — so a shuttle can be positioned to half a column.
 * On a six-column track that is twelve stops instead of six, and the difference between
 * gliding and hopping is exactly that. Cycling four glyphs in one cell, which is where
 * this started, reads as a flicker rather than as travel.
 *
 * It ping-pongs rather than looping, because a shuttle on a real loom returns. A wrap
 * back to the left edge would read as a jump every cycle.
 *
 * THE STATE IS LOCAL, and that is the part that matters for cost. Held in App it would
 * re-render the entire transcript fourteen times a second for six cells; here nothing
 * above it re-renders at all, and the framebuffer's per-cell diff means the terminal
 * only ever receives the columns that actually changed.
 *
 * Idle runs no timer at all. The track sits still, which is also the honest signal:
 * motion here means work is happening, so it must not move when none is.
 */
const SHUTTLE_CELLS = 6;
/** How wide the shuttle itself is, in half cells. Two is one full column. */
const SHUTTLE_SPAN = 2;
/** One step per frame. ~14fps of travel, far below the render cap, and slow enough to
 *  read as a deliberate pass rather than a twitch. */
const SHUTTLE_MS = 70;

function Shuttle({ busy }: { busy: boolean }) {
  const stops = SHUTTLE_CELLS * 2 - SHUTTLE_SPAN + 1;
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setStep((n) => (n + 1) % (stops * 2 - 2)), SHUTTLE_MS);
    return () => clearInterval(id);
  }, [busy, stops]);

  if (!busy) return <Text dimColor>{"─".repeat(SHUTTLE_CELLS)}</Text>;

  // Fold the counter back on itself so the shuttle returns instead of wrapping.
  const pos = step < stops ? step : stops * 2 - 2 - step;
  let track = "";
  for (let cell = 0; cell < SHUTTLE_CELLS; cell++) {
    const left = cell * 2 >= pos && cell * 2 < pos + SHUTTLE_SPAN;
    const right = cell * 2 + 1 >= pos && cell * 2 + 1 < pos + SHUTTLE_SPAN;
    track += left && right ? "━" : left ? "╾" : right ? "╼" : "─";
  }
  return <Text color="yellow">{track}</Text>;
}

export function Banner({ width, mode, modelConfig, busy }: { width: number; mode: ModeId; modelConfig?: ModelConfig; busy: boolean }) {
  const m = modeById(mode);
  const left = `Mindweave${appVersion() ? ` v${appVersion()}` : ""}`;
  // Three separate facts, so three separate colours. As one run they read as a single
  // undifferentiated status string and the eye has to parse the pipes to find the part
  // it wants. The mode keeps its own colour because that colour IS the mode's identity
  // (it is the same one the mode uses everywhere else); the model gets the teal of the
  // "reaching outside the machine" family; and the effort level is plain white, the
  // brightest thing in the row, because it is what changes most often.
  const modeText = `${m.name.toUpperCase()} MODE ON`;
  const modelText = modelConfig ? modelLabel(modelConfig.model) : "";
  const effortText = modelConfig ? thinkLabel(modelConfig).toUpperCase() : "";
  const right = modelConfig ? `${modeText} | ${modelText} | ${effortText}` : modeText;
  // The title row gets a 1-col inset (same idea as the box's own paddingX),
  // but the rule spans the FULL width, edge to edge — same as the box's
  // border below it, so the two anchor the screen the same way instead of
  // the header floating in from the sides while the box touches both edges.
  const innerWidth = Math.max(1, width - 2);
  const gap = Math.max(1, innerWidth - left.length - 1 - SHUTTLE_CELLS - right.length);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingX={1}>
        <Text bold color="yellow">{left}</Text>
        <Text>{" "}</Text>
        <Shuttle busy={busy} />
        <Text>{" ".repeat(gap)}</Text>
        <Text dimColor color={m.color}>{modeText}</Text>
        {modelConfig ? (
          <>
            <Text dimColor>{" | "}</Text>
            <Text color={KIND_COLOR.websearch}>{modelText}</Text>
            <Text dimColor>{" | "}</Text>
            <Text>{effortText}</Text>
          </>
        ) : null}
      </Box>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}

/**
 * Terminal size that updates on resize — DEBOUNCED. A drag-resize fires a flood
 * of resize events; re-rendering on each one makes a slow host (legacy cmd.exe)
 * leave stale copies of the live region in the scrollback. Updating only once the
 * resize settles (~150ms) collapses that to a single clean re-layout.
 *
 * Rows matter now in a way they didn't before alt-screen: the outer frame
 * is height-bound to this value (the middle chat region flexGrows to fill
 * whatever the header/footer don't use), so a stale row count leaves dead
 * space at the bottom instead of the frame reaching the terminal's actual edge.
 */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;

    const read = () => setSize((prev) => {
      const next = { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
      return next.columns === prev.columns && next.rows === prev.rows ? prev : next;
    });

    // The 'resize' event is NOT reliable on native Windows consoles — Node has a
    // long-standing open issue (nodejs/node#13197): unlike Unix's SIGWINCH, Windows
    // has no real signal for it, so the event can simply never fire. Relying on it
    // alone means a wrong initial read (see below) can stick forever until the user
    // happens to trigger whatever DOES make it fire. So this polls too — cheap (two
    // integer reads, ~4x/sec) and it's the standard workaround for that exact gap,
    // not a hack: it's what a resize event is supposed to give us, gotten a
    // different way when the event can't be trusted to arrive at all.
    let debounce: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(debounce);
      debounce = setTimeout(read, 150);
    };
    stdout.on("resize", onResize);
    const poll = setInterval(read, 250);

    // The size read at THIS exact instant can be stale too: entering alt-screen
    // (a raw escape code written before Ink even mounts, see altScreen.ts) makes
    // the terminal reconfigure its buffer, and querying dimensions mid-reconfigure
    // can return the wrong ones. One re-read shortly after mount, once that's
    // settled, catches a wrong FIRST render that the poll above would otherwise
    // take up to 250ms to correct.
    const settle = setTimeout(read, 60);

    return () => {
      clearTimeout(debounce);
      clearTimeout(settle);
      clearInterval(poll);
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

// The built-in slash commands offered by the input's autocomplete. Project skills
// are appended at render time from the live session.
const BASE_COMMANDS = [
  { name: "/help", description: "show this list" },
  { name: "/init", description: "write MINDWEAVE.md — what the agent should always know about this project" },
  { name: "/provider", description: "choose which provider serves this project" },
  { name: "/key", description: "add or replace an API key" },
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
  { name: "/clear", description: "start a fresh conversation in this project" },
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
  received,
  advance,
}: {
  busy: boolean;
  startedAt: number | null;
  lastMs: number | null;
  /** The task's measured summary. Non-null as soon as the first call reports, but only
   *  rendered once the turn settles: while busy the line shows the live figure, which
   *  includes the in-flight call this one cannot yet see. */
  usage: TaskUsage | null;
  /** Output tokens received so far this turn, estimated from the streamed characters and
   *  eased toward the real total. Deliberately NOT the turn's billed cost: input does not arrive over
   *  time, so putting it here makes the counter leap and then freeze. The receipt below
   *  carries the cost. Read through a getter, fresh every frame. See dynamo/liveMeter.ts. */
  received: () => number;
  /** Advances the eased counter one frame. Called on the render clock, and separate from
   *  reading the value so the easing lives with the state, not in the view. */
  advance: () => void;
}) {
  // The render clock while busy: it advances the elapsed timer AND steps the eased token
  // counter one frame. 50ms, which is what makes the number read as counting rather than
  // as jumping — at 1Hz it moved once a second in whatever lump had arrived, which is a
  // stutter, not an animation. Nothing else re-renders with it: the tick is this
  // component's own state and the figure is read through a getter, so the cost is one
  // small subtree per frame.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      advance();
      tick((t) => t + 1);
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [busy, advance]);

  let label = null;
  if (busy && startedAt != null) {
    // `< Scampering… < 45s · ↓ 1.8k tokens >` — the reference shape. The angle brackets
    // are what make it read as a live gauge rather than a sentence, and the verb is
    // held for the whole turn (see workingVerb) so the line does not flicker between
    // words while the seconds tick.
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const got = received();
    label = (
      <Text>
        {" "}
        {workingVerb(startedAt)}…{"  "}
        <Text dimColor>{"< "}{fmtElapsed(secs)}{got > 0 ? ` · ↓ ${formatTokens(got)} tokens` : ""}{" >"}</Text>
      </Text>
    );
  } else if (lastMs != null) {
    // Settled receipt: elapsed time and the turn's real token cost, shown at once,
    // no count-up.
    //
    // `billedTokens`, NOT `totalTokens`. The prompt is re-sent every tool round, so
    // a per-call total counts the same text once per step and the figure grows with
    // tool use rather than with work — a five-step turn over a 30K context read
    // ~150K. Misses plus output counts each token exactly once.
    // A `~` when the provider never reported what it served from cache, so the number
    // is inferred rather than measured (Gemini's OpenAI-compatible endpoint is the
    // case that forced this — see TaskUsage.estimated). Showing an inferred figure
    // with the same authority as a measured one is what made a normal turn look like
    // a runaway one.
    const meter = usage ? ` · ${usage.estimated ? "~" : ""}${formatTokens(usage.billedTokens)} tokens` : "";
    label = <Text bold> Worked for {fmtElapsed(Math.round(lastMs / 1000))}{meter}</Text>;
  }

  // A fresh session that has never run a turn has nothing to report — no dot,
  // no line at all, rather than a marker floating with nothing beside it.
  if (!busy && label === null) return null;

  const dot = busy ? <Text color="cyan">●</Text> : <Text dimColor>●</Text>;

  // No marginTop: the footer owns the gap above itself now, so that it survives this
  // component rendering nothing at all. Two would read as a hole.
  return (
    <Box marginBottom={0}>
      {dot}
      {label}
    </Box>
  );
}

/** The working line's render clock. See StatusLine's tick. */
const LIVE_TICK_MS = 50;

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
/** `[BG] 2 running: $ npm run dev (3000) • $ docker compose up` — every running
 *  command, not just the first or a bare count, each with the port it announced.
 *  The port comes from the process's own startup line (see detectPort), so it is
 *  shown only when the server actually said where it is listening. */
function BackgroundBar({ shells }: { shells: ShellInfo[] }) {
  if (shells.length === 0) return null;
  const cmds = shells.map((s) => `$ ${clipCmd(s.command)}${s.port ? ` (${s.port})` : ""}`).join(" • ");
  return (
    <Box>
      <Text color="yellow">{"[BG] "}</Text>
      <Text dimColor wrap="truncate-end">{`${shells.length} running: ${cmds}`}</Text>
    </Box>
  );
}

// One short, useful line rendered inside the input box (see PromptInput's
// `tip` prop) — picked once per session, not rewritten every render. The
// mode/model/thinking readout already lives in the header, so this slot is
// free for the shift-tab hint (nothing else states it anymore) and a few of
// the less-obvious commands.
const TIPS = [
  "shift+tab cycles Lightning / Architect / Sentinel",
  "/help lists every command",
  "/model switches which model answers, /think sets its reasoning level",
  "@ mentions a file to attach it",
  "esc interrupts a running turn",
  "/undo restores the last checkpoint",
];

/**
 * Messages typed while Mindweave is working, waiting to be sent when the turn ends.
 *
 * Bounded on purpose. This sits in the footer, and the footer is not height-limited:
 * past the terminal height Ink stops erasing correctly and the whole frame tears
 * rather than clipping (the same hazard the approval prompt is written around). So
 * only the first few show, and the rest are counted.
 *
 * The last line says how to take them back. Without it the queue is a one-way door
 * you cannot see the handle on — ↑ is not a thing anyone guesses, and the cost of not
 * guessing it is a message you no longer wanted being sent anyway.
 */
function QueuedBar({ queued }: { queued: string[] }) {
  if (queued.length === 0) return null;
  const { rows, hidden } = visibleQueue(queued);
  return (
    <Box flexDirection="column">
      {rows.map((q, i) => (
        <Text key={i} dimColor wrap="truncate-end">{"⏎ queued: "}{q}</Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>{`  …and ${hidden} more`}</Text>
      ) : null}
      <Text dimColor>{`  ↑ to edit ${queued.length === 1 ? "it" : "them"}`}</Text>
    </Box>
  );
}

/**
 * Whether some OTHER installed provider has a key, so `/provider` is worth
 * suggesting. With a single key configured there is nothing to switch to, and
 * offering the command is just noise on a screen the user is already unhappy with.
 */
function otherProviderHasKey(currentModel: string): boolean {
  const current = manifestForModel(currentModel).id;
  return allProviders().some((p) => p.id !== current && hasApiKey(p.apiKeyEnv));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
