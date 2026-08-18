/**
 * guard.ts — the pure decision logic for Sentinel mode (ask-before-acting).
 *
 * Sentinel gates every MUTATING tool call behind a human yes/no in the CLI. The
 * mechanics live in the engine's tool-execution choke point; this module holds only
 * the parts worth unit-testing: how a call is described to the user, the three
 * choices offered, and how the chosen answer maps to an action. Keeping it pure
 * means the gate's behavior is verified, not blind-shipped — and the engine stays
 * mode-agnostic (it acts on the decision, never on a mode name).
 */

/** The three answers a Sentinel prompt offers, in order. */
export const GUARD_OPTIONS = [
  "Yes, do it",
  "Yes, and stop asking this session",
  "No — let me tell you what to do",
] as const;

export type GuardDecision = "proceed" | "allow-all" | "refuse";

/**
 * Map the user's chosen option to an action. Anything unrecognized — including a
 * cancel/Esc (the overlay resolves those to a decline) — is treated as `refuse`, so
 * the gate fails safe: an unclear answer never runs the action.
 */
export function interpretGuardChoice(choice: string | undefined): GuardDecision {
  if (choice === GUARD_OPTIONS[0]) return "proceed";
  if (choice === GUARD_OPTIONS[1]) return "allow-all";
  return "refuse";
}

/** What the model is told when the user declines an action in Sentinel mode. */
export const GUARD_REFUSAL =
  "Stopped: the user declined this action in Sentinel mode. Do not retry it — briefly say what you " +
  "were about to do and wait for the user's direction on how to proceed.";

/** A short, human-readable description of a mutating call, for the approval prompt. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : undefined;
  switch (name) {
    case "edit":
    case "write_file":
    case "replace_symbol_body":
      return `${name} — ${path ?? "?"}`;
    case "run_command":
      return `run_command — ${clip(strArg(args.command), 80)}`;
    case "spawn_subagent":
      return `spawn_subagent — ${clip(strArg(args.task), 80)}`;
    default:
      // Anything else: the name, plus a path if the call carries one.
      return path ? `${name} — ${path}` : name;
  }
}

/** The question shown atop the Sentinel approval prompt. ONE line: it renders inside a
 *  height-bounded box, and what the call actually is goes in `guardDetail` instead. */
export function guardQuestion(): string {
  return "Sentinel — approve this action?";
}

/** What each kind of call is called in the permission block, in the user's terms
 *  rather than the tool's. Anything unlisted falls back to the tool name. */
const ACTION_LABEL: Record<string, string> = {
  run_command: "Shell execution",
  edit: "File edit",
  replace_symbol_body: "File edit",
  write_file: "File write",
  spawn_subagent: "Sub-agent spawn",
};

/**
 * The block printed above a Sentinel prompt: what is about to happen, spelled out.
 *
 * Rendered into the TRANSCRIPT (as approval `detail`), not into the prompt — the prompt
 * is height-bounded and this is the part that can run long. Reading it is the whole
 * point of the gate: a prompt that says only "approve this action?" is one the user
 * learns to answer without looking.
 *
 * Deliberately NOT a risk rating. The reference design shows a "Risk: High" line, and
 * there is nothing in Mindweave that knows which commands are dangerous — inventing a
 * severity here would be a guess presented as an assessment, and a wrong "Low" is worse
 * than no line at all. What IS shown is fact: the kind of action, and its exact target.
 */
export function guardDetail(name: string, args: Record<string, unknown>): string {
  const lines = [`Action: ${ACTION_LABEL[name] ?? name}`];
  const command = strArg(args.command);
  const path = strArg(args.path);
  const task = strArg(args.task);
  // The command is shown UNCLIPPED. It is the thing being agreed to, and a truncated
  // one hides the tail — which on a shell command is exactly where the damage lives.
  if (command) lines.push(`Command: $ ${command}`);
  if (path) lines.push(`File: ${path}`);
  if (task) lines.push(`Task: ${clip(task, 200)}`);
  lines.push(`Tool: ${name}`);
  return lines.join("\n");
}

function strArg(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
