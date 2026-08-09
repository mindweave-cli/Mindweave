/**
 * startupArgs.ts — the flags handled before the UI exists.
 *
 * `mindweave --version` used to ignore the flag, start the whole terminal UI, and
 * never exit. Piped or run without a TTY it then died on Ink's raw-mode error. That
 * is the first command anyone runs against a new CLI, and packaging tools run it
 * unattended, so hanging there is worse than it sounds.
 *
 * Parsing is a pure function returning what to print, so it is testable without
 * spawning a process, and `index.ts` keeps the one side effect: print and exit.
 *
 * Deliberately tiny. Mindweave takes no launch options — it roots at the current
 * directory and everything else is configured in `~/.mindweave/.env` or in-session.
 * Inventing flags here would create a second place to configure the same things.
 */
import { appVersion } from "./version.js";

export type Startup =
  /** Start normally. */
  | { kind: "run" }
  /** Print `text` and exit 0. */
  | { kind: "print"; text: string };

/** `mindweave --version` output: the bare version, which is what scripts parse. */
export function versionText(): string {
  const v = appVersion();
  return v ? `mindweave ${v}` : "mindweave (version unknown)";
}

/** `mindweave --help` output. */
export function helpText(): string {
  const v = appVersion();
  return [
    `Mindweave${v ? ` ${v}` : ""} — a terminal coding agent that works inside your repository.`,
    "",
    "Usage:",
    "  mindweave              start a session in the current directory",
    "  mindweave --help       show this and exit",
    "  mindweave --version    print the version and exit",
    "",
    "Setup:",
    "  Put your model API key in ~/.mindweave/.env, for example:",
    "    DEEPSEEK_API_KEY=your-key-here",
    "    ANTHROPIC_API_KEY=your-key-here",
    "  A project .env or an exported shell variable works too.",
    "",
    "Once running, type /help for the commands available in a session,",
    "and press shift+tab to change how much rein the agent has.",
    "",
    "Windows only for now. Docs and issues:",
    "  https://github.com/mindweave-cli/Mindweave",
  ].join("\n");
}

/**
 * Decide what a launch should do (pure).
 *
 * Only exact flags count. A stray argument is NOT an error: the session roots at the
 * current directory regardless, and refusing to start over an argument nobody
 * documented would be a worse failure than ignoring it.
 */
export function parseStartupArgs(argv: readonly string[]): Startup {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { kind: "print", text: helpText() };
    if (arg === "--version" || arg === "-v") return { kind: "print", text: versionText() };
  }
  return { kind: "run" };
}
