/**
 * types.ts — the shape every tool shares.
 *
 * A tool is a small, self-contained capability the engine can invoke: read a
 * file, run a command, search, etc. The engine never hard-codes any specific
 * tool — it only knows this interface, so adding a tool is "drop a new file in
 * this folder and register it."
 *
 * Everything crossing the engine↔tool boundary is plain data (JSON-friendly),
 * which keeps the door open for the later thin-client / server-brain split:
 * the brain decides *which* tool to call, the client *executes* it locally.
 */

/** What a tool hands back after running. */
export interface ToolResult {
  /**
   * The text the model sees as the tool's result. This is the only field that
   * ever reaches the LLM — keep it the model's-eye view of what happened.
   */
  output: string;

  /** True if the call failed. The model sees the error and can adapt. */
  isError?: boolean;

  /**
   * Set by a tool whose `output` IS the whole current content of this absolute path.
   * A fact, recorded at the moment it is true, and the input to the presence
   * derivation (`memory/presence.ts`): while this result is in the transcript
   * unstubbed, the model can see that file. Never sent to the model.
   *
   * It is stored rather than re-derived from the call's arguments later because
   * arguments are relative and `cd` moves the working directory mid-session, so the
   * same recorded path can resolve to a different file than it did when read.
   */
  fullContentOf?: string;

  /**
   * A short, human one-liner for the live UI (e.g. "read src/app.ts (40
   * lines)"). Display-only — never sent to the model. Separating this from
   * `output` keeps the transcript clean without starving the model of detail.
   */
  summary?: string;

  /**
   * A multi-line rich block for the UI to show under the tool row — an edit's
   * +/- diff, a new file's preview, a command's output. Display-only, like
   * `summary`; never sent to the model. Lines prefixed `+ `/`- ` render as
   * added/removed; bare lines render plain. See detail.ts.
   */
  detail?: string;

  /**
   * Display-only: this failure is the agent's own business, not news for the user.
   *
   * Some failures are ROUTINE INTERNAL STEPS. An `old_string` that matched two places
   * is not a fault in the project, an outage, or anything the user can act on — it is
   * the model being told to aim more precisely, which it then does. Painting it as a
   * red error row makes ordinary self-correction look like something went wrong, and a
   * screen full of "could not edit because…" is noise the user has to learn to ignore.
   *
   * So a quiet result still reaches the MODEL in full (it needs the reason to fix its
   * aim) and is still recorded in the transcript, but the UI drops the row. This is the
   * same call already made for background machinery like compaction and verification,
   * which run silently rather than narrating themselves.
   *
   * Only for failures the model can resolve on its own, in the same turn, with no user
   * involvement. A refused permission, a missing file, a failed write, a command that
   * exited non-zero — those are real news and stay visible.
   */
  quiet?: boolean;

  /**
   * Images this call produced, for the model to actually LOOK at.
   *
   * Refs, never bytes — the same rule the transcript already follows: the engine
   * loads the payload once per turn and the caps live in one place.
   *
   * These do NOT ride on the tool result itself. An image inside a tool-result
   * message is accepted by Anthropic and rejected by OpenAI-compatible providers,
   * and most driver folders are OpenAI-shaped, so sending them that way would make
   * the feature work on one provider and 400 on the rest. The engine instead
   * surfaces them as a following user message — the identical path a user's `@file`
   * attachment takes, which every provider already accepts. It also gates them on
   * whether the running model can see an image at all, so a text-only model is told
   * where the file is rather than handed a message claiming a picture it can't read.
   */
  images?: import("../memory/images.js").ImageRef[];
}

/**
 * What we remember about a file the model has read (or written): enough to tell,
 * on a later read, whether it's unchanged since — so we can skip re-sending
 * identical content. `full` means the last read covered the whole file (a ranged
 * read doesn't, so it can't be deduped). Keyed by resolved absolute path.
 */
export interface ReadRecord {
  mtimeMs: number;
  size: number;
  full: boolean;
  /** Monotonic recency stamp — the working set keeps the most-recently-touched files. */
  touchedAt?: number;
  /** Line spans (1-based, inclusive) the model recently read/edited in this file —
   *  used to localize a large file in the working set to just its focused regions. */
  focus?: { start: number; end: number }[];
}

/** One item on the session task list (see todo_write). */
export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  /** Imperative form: "Run the tests". */
  content: string;
  /** Present-continuous form shown while active: "Running the tests". */
  activeForm: string;
  status: TodoStatus;
}

/**
 * The mutable, per-session state tools share. One `ToolContext` object lives for
 * the whole chat session (the CLI owns it) and is handed to every tool call, so
 * state survives across turns:
 *
 *  - `cwd` is the SHELL working directory. `run_command` updates it when a command
 *    changes directory (`cd src`), so the next command in the SAME turn runs where
 *    the model left off; each new turn resets it to the project root (session.cwd).
 *    File tools do NOT follow it — they resolve relative paths against the fixed
 *    session anchor (the primary root; see paths.ts `anchorOf`), so a `cd` into a
 *    subdirectory before a build can never make a later edit/read miss its file.
 *  - `reads` is the read ledger: every file the model has read or written this
 *    session, with its state at that moment. It does double duty — `edit_file` /
 *    `write_file` refuse to touch a path that isn't in here (so "editing a file
 *    you never looked at" is impossible), and `read_file` uses the recorded
 *    state to skip re-sending a file that hasn't changed since the last read.
 *
 * It is a plain object so a tool can mutate it in place (`ctx.cwd = …`,
 * `ctx.reads.set(…)`) and the change is visible to every later call. Like
 * everything else crossing the engine↔tool line, it holds only plain data, so
 * the later client/server split stays clean.
 */
export interface ToolContext {
  /** Working directory; `run_command` may change it (cd persistence). */
  cwd: string;
  /**
   * The session's roots, primary first (`/include` adds more — e.g. a backend and a
   * frontend). When more than one is present, file tools express every path as
   * `label/relative` so the two never collide, and search spans them all. Absent or
   * single-element means the ordinary single-root session; the primary root is the
   * fixed session root (cwd may move within it via `cd`).
   */
  roots?: string[];
  /**
   * The live session's id. Used by the session tools to exclude the CURRENT session
   * from "your past sessions" — listing the conversation you are already in as
   * history is confusing and, on resume, circular.
   */
  sessionId?: string;
  /** Read ledger: resolved absolute path → its state when last read/written. */
  reads: Map<string, ReadRecord>;
  /**
   * The code-intelligence handle the `alternator` lane builds and keeps fresh.
   * Optional — absent (or not-ready) means the chassis tools degrade and the
   * model falls back to grep/read. Holding only the query interface here keeps
   * the engine filesystem-pure (the lane does the I/O).
   */
  chassis?: import("../alternator/chassis/types.js").Chassis;
  /**
   * One chassis per session root (built by the alternator), so the code-map tools
   * stay precise in a multi-root workspace: a path query hits the root that owns
   * the file, a name query merges across all. `chassis` above is the PRIMARY root's
   * entry (used for the engine's tiny auto-map). Absent → single-chassis behavior
   * via `chassis`. Keyed by absolute root path.
   */
  chassisByRoot?: Map<string, import("../alternator/chassis/types.js").Chassis>;
  /**
   * The session task list (the model's own plan), maintained by todo_write and
   * injected into the system prompt each turn so the model always sees it. Lives
   * here — separate from the transcript — so the plan survives compaction. Starts
   * empty; cleared automatically when every item is completed.
   */
  todos: TodoItem[];
  /**
   * The per-project governor (plain data): standing rules, the skill catalog, and
   * the forbidden deny-list. This is the SAME object as `session.governance` — the
   * engine renders the prompt from it while the tools read it (forbidden checks,
   * use_skill) and mutate it (remember_rule / forbid), so a rule or forbidden path
   * added mid-session takes effect immediately. Absent only in bare test contexts.
   */
  governance?: import("../governor/types.js").Governance;
  /**
   * Ask the human a yes/no/other question and wait for the answer — the client's
   * approval channel (injected by the CLI, like `chassis`; absent in tests and on a
   * future server). A forbidden-path tool uses it to offer a one-time lift instead
   * of a hard refusal: it returns the chosen option string verbatim. Client-side
   * only (it prompts where the human is), so it never crosses the engine↔brain wire.
   */
  requestApproval?: (question: string, options: string[]) => Promise<string>;
  /**
   * Other coding tools whose data the user has allowed this session, by name
   * ("Claude Code", "Cursor", …). Another agent's sessions/memory/rules are not
   * ours to read, so the tools ask first; a yes lands here so the user is asked
   * once per tool rather than once per file. Session-only and never persisted.
   */
  agentDataAllowed?: Set<string>;
  /**
   * Long-running commands that outlive a turn. run_command hands a process here on
   * timeout (or `run_in_background`); the shell tools read/kill/list through it, and
   * the engine drains its completion events. Client-side (holds live process
   * handles), like `chassis`; absent in bare test contexts (run_command then falls
   * back to killing on timeout).
   */
  backgroundShells?: import("./backgroundShells.js").BackgroundShells;
  /**
   * The per-turn undo net. Mutating tools hand a file's original bytes here before
   * changing it; the engine seals them into a checkpoint at turn end and `/undo`
   * restores the last one. Client-side (holds file bytes), like backgroundShells;
   * absent in bare contexts, where edits simply aren't checkpointed.
   */
  checkpoints?: import("./checkpoints.js").Checkpoints;
  /**
   * Read-only turn (the "Architect" plan mode in the CLI): the model researches
   * and presents a plan but changes nothing. The engine reads this flag alone —
   * it never sees the mode's name — and withholds mutating tools from the request
   * and refuses one if the model calls it anyway. A CLIENT concept set by the UI
   * when the mode switches; absent/false means the ordinary auto-accept turn.
   */
  planMode?: boolean;
  /**
   * Ask-before-acting (the "Sentinel" mode in the CLI). When set, the engine pauses
   * before every MUTATING tool call and asks the human via `requestApproval`. Like
   * `planMode`, the engine reads the flag alone, never the mode's name. Set by the UI
   * on mode switch; absent/false is the ordinary auto-accept turn.
   */
  guarded?: boolean;
  /**
   * Session-lived latch for Sentinel's "yes, and stop asking" answer: once the user
   * allows all, the gate stops prompting for the rest of the session (until they
   * switch back into Sentinel, which resets it). Mutated in place by the engine.
   */
  guardAllowAll?: boolean;
  /**
   * How deep in a sub-agent chain this context is (0 = the main agent, 1 = a
   * sub-agent it spawned). `spawn_subagent` refuses once at the cap, so sub-agents
   * can't recurse without bound.
   */
  subagentDepth?: number;
  /**
   * Withhold mutating tools for this turn WITHOUT the plan-mode framing — used to
   * make a research/inventory sub-agent read-only. Like `planMode` it filters the
   * schema and the engine refuses a mutating call anyway, but it adds no "present a
   * plan" instruction (a sub-agent acts, it just can't write).
   */
  readOnlyTools?: boolean;
  /**
   * Spawn a scoped child session for a sub-agent (injected by the engine, which owns
   * the parent Session the tool never sees). Returns a ready child to run through the
   * engine; absent in bare contexts (sub-agents then unavailable).
   */
  forkChild?: (task: string, opts?: { readOnly?: boolean }) => import("../memory/types.js").Session;
  /**
   * Forward a model call's token usage to the live meter (injected by the engine from
   * its options). Lets a sub-agent's usage count toward the same total instead of
   * being invisible. Fields mirror the usage event.
   */
  reportUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  }) => void;
  /**
   * The turn's abort signal (injected by the engine from its options), so a spawned
   * sub-agent stops too when the user presses Esc.
   */
  abortSignal?: AbortSignal;
  /**
   * Forward a raw live engine event to the UI stream (injected by the engine from its
   * options.onEvent). spawn_subagent uses this to surface a child's nested activity —
   * its lifecycle plus each of its tool calls, tagged with the sub-agent id — so a
   * delegated task isn't a black box. Absent in non-interactive contexts (the child
   * then runs muted, exactly as before).
   */
  emitEvent?: (event: import("../dynamo/engine.js").EngineEvent) => void;
  /**
   * Files whose CURRENT full content is in this turn's working-set block (the volatile
   * tail). Set by the engine each turn. read_file short-circuits a read of one of these
   * — the model already has it, fresh — instead of re-sending it.
   */
  workingSetFull?: Set<string>;
  /** Line ranges the working-set block actually PUT ON SCREEN this turn, per file.
   *  Derived from what was rendered (never from the read ledger), so a tool can prove
   *  the model is already looking at a span instead of assuming it. */
  workingSetSpans?: Map<string, { start: number; end: number }[]>;
  /**
   * Files whose WHOLE content is still present in the TRANSCRIPT — a full read whose
   * result microcompaction has not cleared to a stub. Derived by the engine each turn
   * (see `memory/presence.ts`), never stored on the ledger: "the model can see this"
   * is a property of the bytes being sent, and a stored copy of it goes stale the
   * moment the transcript is compacted. Absent means "don't assume presence", which
   * costs a re-read and can never cost a lie.
   */
  transcriptFull?: Set<string>;
  /**
   * The pool of connected MCP servers, when the session has any. Their tools are merged
   * into the model's tool list and dispatched through the same path as built-ins, so
   * nothing else in the codebase needs to know MCP exists. Absent in tests and in any
   * context that never attached a pool.
   */
  mcp?: import("../mcp/manager.js").McpManager;

  /**
   * Tell the UI its mode flags moved underneath it.
   *
   * Modes stay a CLIENT concept: nothing here knows the word "Architect". A tool
   * changes `planMode`/`guarded` and calls this; the client reads those flags back
   * and works out which mode that is. Absent outside the interactive CLI, where
   * there is no indicator to keep honest.
   */
  onModeChange?: () => void;

  /**
   * Planning was left to carry out an approved plan, and should be returned to when
   * the turn ends.
   *
   * Approval buys ONE turn of doing, not a permanent change of mode. Without this
   * the session would quietly sit in Lightning afterwards, having been put there by
   * a tool call rather than by the user, and the next request would run unplanned.
   */
  planResume?: boolean;
}

export interface Tool {
  /** The name the model calls (e.g. "read_file"). Must be unique. */
  name: string;

  /** One or two sentences telling the model what the tool does and when. */
  description: string;

  /**
   * JSON Schema for the arguments object — exactly what goes in the OpenAI
   * `function.parameters` field. Hand-written (no schema library) to keep the
   * engine dependency-free.
   */
  parameters: Record<string, unknown>;

  /**
   * Read-only tools change nothing on disk and are safe to run in parallel
   * with each other. Mutating tools (write/edit/run) must run alone, in order.
   */
  readOnly: boolean;

  /**
   * Offered ONLY while planning, and hidden everywhere else.
   *
   * The inverse of how the plan filter usually works: every other tool is a thing
   * the model may do that planning takes away, while this is a thing that exists
   * solely because planning is happening. Advertising it in an ordinary turn would
   * invite the model to call something with nothing to end.
   */
  planOnly?: boolean;

  /**
   * May THIS call run in parallel with the others in the same batch? Optional and
   * per-ARGUMENTS — separate from `readOnly`. When omitted the
   * engine treats a `readOnly` tool as concurrency-safe and a mutating one as not.
   * Override when safety depends on the args: a read-only sub-agent is safe to fan
   * out, but the same tool doing edits must run alone. Returning false forces the
   * call into the serial lane; true lets it join the parallel lane.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;

  /**
   * Do the work. `args` is the parsed arguments object from the model; `ctx` is
   * the shared per-session state (cwd + read ledger).
   */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A tool advertised to the provider, in OpenAI function-calling shape. This is
 * what goes in the request's `tools[]` array. Built from `Tool` by the
 * registry; the provider client passes it through untouched.
 */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
