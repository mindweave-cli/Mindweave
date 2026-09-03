/**
 * guard.ts — the mechanical safety floor for the mutating tools.
 *
 * Two deterministic checks, no model judgment and no prompt rules (keeping the
 * "how to behave safely" decision out of the prompt is deliberate — the wall is
 * physical, the model is simply told why and adapts):
 *
 *  1. `protectedPathReason` — some files must never be read or written by the
 *     agent regardless of what it's asked: secrets (`.env`), keys (`.ssh`,
 *     `*.pem`, `id_rsa`), and the git internals (`.git/`) whose corruption would
 *     wreck the repo. This mirrors the deny-lists every serious coding agent
 *     ships; user-configurable rules can layer on later.
 *
 *  2. `catastrophicCommandReason` — a tiny, high-confidence blocklist of shell
 *     commands that are essentially never a legitimate coding action and are
 *     irreversible (wipe the disk, fork-bomb, reformat). This is NOT a sandbox
 *     or an injection parser — a single-user local tool doesn't need a heavyweight
 *     shell analyzer. It's a seatbelt against the few commands that turn a model
 *     mistake into a destroyed machine.
 *
 * Both return a human reason string when they fire, or `null` to allow. Fail
 * open by design: anything not explicitly matched is allowed.
 */

// Path segments / names that are off-limits. Matched against the POSIX-style
// path so it works the same on Windows and Unix.
const PROTECTED_PATTERNS: { test: RegExp; what: string }[] = [
  // Three spellings, because two of them were getting through. `.env` and `.env.local`
  // were covered; `prod.env`, `staging.env` and `production.env` were NOT, and a
  // per-environment file is one of the commonest places a real secret actually lives.
  // `.envrc` (direnv) was not covered either, and it routinely holds exported keys.
  //
  // The suffix form is anchored to the end of the BASENAME rather than matched loosely,
  // which is what keeps ordinary code out of the net: `src/environment.ts` and
  // `src/env.ts` must stay readable, and a floor that blocked those would be worked
  // around rather than obeyed.
  { test: /(^|\/)\.env(\.|$|\/)/i, what: "an environment/secrets file" },
  { test: /(^|\/)[^/]*\.env$/i, what: "an environment/secrets file" },
  { test: /(^|\/)\.envrc$/i, what: "an environment/secrets file" },
  { test: /(^|\/)\.git(\/|$)/i, what: "the git internals directory" },
  { test: /(^|\/)\.ssh(\/|$)/i, what: "an SSH key directory" },
  { test: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i, what: "a private SSH key" },
  { test: /\.pem$/i, what: "a private key file" },
  { test: /(^|\/)(secrets?|credentials)(\/|\.|$)/i, what: "a secrets/credentials file" },
];

/**
 * The example counterpart of an env file, which is the opposite of a secret.
 *
 * `.env.example` and its spellings are committed to repositories on purpose: they list
 * the variable NAMES a project needs, with the values left blank or filled with obvious
 * placeholders, and they are the file a newcomer is told to copy. Refusing them withholds
 * a project's own documentation about its configuration while protecting nothing —
 * anything a real key sits in (`.env`, `.env.local`, `.env.production`, `prod.env`) is
 * still matched by the patterns above.
 *
 * Anchored to the end of the name, so `.env.example.local` — a real file in some setups,
 * holding real values — is not exempted by starting the same way.
 */
const ENV_EXAMPLE = /(^|\/)\.?env\.(example|sample|template|defaults|dist)$/i;

/**
 * If `absPath` is a file the agent must never touch, return a short reason;
 * otherwise null. `absPath` may use either slash style.
 */
export function protectedPathReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  if (ENV_EXAMPLE.test(posix)) return null;
  for (const { test, what } of PROTECTED_PATTERNS) {
    if (test.test(posix)) return what;
  }
  return null;
}

// Another coding agent's private working data: its saved sessions, its memory of
// past conversations, its rules and skills. A project that has been worked on by
// more than one tool carries several of these side by side.
//
// This is NOT the same thing as a secret, and it is deliberately a separate list.
// A secret must never be read at all. This data is simply not ours: it belongs to
// a different tool and a different set of conversations, and helping ourselves to
// it means presenting someone else's history as if it were our own, or inheriting
// stale decisions the user never made with us. So the rule is "ask first", not
// "never" — the user can always say yes.
//
// Deliberately absent from this list: our own directory. Our sessions and memory
// live under the user's home directory rather than in the project, but a project
// may still hold our own notes, and reading our own work is the entire point.
const AGENT_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /(^|\/)\.claude(\/|$)/i, what: "Claude Code" },
  { test: /(^|\/)CLAUDE\.md$/i, what: "Claude Code" },
  { test: /(^|\/)\.cursor(\/|$)/i, what: "Cursor" },
  { test: /(^|\/)\.cursorrules$/i, what: "Cursor" },
  { test: /(^|\/)\.aider[^/]*$/i, what: "Aider" },
  { test: /(^|\/)\.aider(\/|$)/i, what: "Aider" },
  { test: /(^|\/)\.continue(\/|$)/i, what: "Continue" },
  { test: /(^|\/)\.windsurf(\/|$)/i, what: "Windsurf" },
  { test: /(^|\/)\.codeium(\/|$)/i, what: "Codeium" },
  { test: /(^|\/)AGENTS\.md$/i, what: "another coding agent" },
];

/**
 * If `absPath` belongs to a DIFFERENT coding agent, return that tool's name;
 * otherwise null. Callers use this to ask the user before touching it, never to
 * refuse outright — see `requestAgentDataAccess`.
 */
export function foreignAgentReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  for (const { test, what } of AGENT_PATTERNS) {
    if (test.test(posix)) return what;
  }
  return null;
}

/** Directory names belonging to other coding agents, for skipping during a walk
 *  or search. Files that are not directories (CLAUDE.md, .cursorrules) are matched
 *  by `foreignAgentReason` instead. */
export const AGENT_DIRS: readonly string[] = [
  ".claude",
  ".cursor",
  ".aider",
  ".continue",
  ".windsurf",
  ".codeium",
];

/**
 * Glob patterns a CONTENT SEARCH must never look inside.
 *
 * Search is the quiet way past a per-file gate: `read_file` refuses to open
 * `.env`, but an unfiltered `grep -r "KEY" .` prints the matching lines anyway,
 * and the same trick would surface another agent's saved conversations without
 * ever opening a file. Secrets are excluded outright; another agent's data is
 * excluded because a search is a poor place to ask a question — the model can
 * still read those files deliberately, which is where the user gets asked.
 */
export const SEARCH_EXCLUDE_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  ".ssh",
  "*.pem",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "secrets",
  "secret",
  "credentials",
  ...AGENT_DIRS,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".aider*",
];

/** True if a search result from `absPath` must be withheld — a secret, or another
 *  coding agent's data. The counterpart to SEARCH_EXCLUDE_GLOBS for the built-in
 *  walker, which filters after walking rather than excluding at the source. */
export function excludedFromSearch(absPath: string): boolean {
  return protectedPathReason(absPath) !== null || foreignAgentReason(absPath) !== null;
}

// Paths a shell command must not PRINT the contents of.
const COMMAND_SENSITIVE: { needle: RegExp; what: string }[] = [
  // The lookahead is the same exemption `ENV_EXAMPLE` makes for a path: printing
  // `.env.example` is reading a project's own template, and a command that names it
  // alongside ordinary files was being refused whole.
  { needle: /(^|[\s"'`/\\=<])\.env\b(?!\.(example|sample|template|defaults|dist)\b)/i, what: "an environment/secrets file" },
  { needle: /(^|[\s"'`/\\=<])\.ssh\b/i, what: "an SSH key directory" },
  { needle: /\bid_(rsa|ed25519|ecdsa|dsa)\b/i, what: "a private SSH key" },
  { needle: /\.pem\b/i, what: "a private key file" },
  { needle: /(^|[\s"'`/\\=<])\.claude\b/i, what: "Claude Code's data" },
  { needle: /(^|[\s"'`/\\=<])\.cursor(rules)?\b/i, what: "Cursor's data" },
  { needle: /(^|[\s"'`/\\=<])\.aider/i, what: "Aider's data" },
  { needle: /(^|[\s"'`/\\=<])\.continue\b/i, what: "Continue's data" },
  { needle: /(^|[\s"'`/\\=<])\.windsurf\b/i, what: "Windsurf's data" },
  { needle: /(^|[\s"'`/\\=<])\.codeium\b/i, what: "Codeium's data" },
];

// Commands whose OUTPUT is the contents of a file. This is the thing that matters:
// the harm is a secret being printed into the model's context (and from there into
// a saved transcript, and into the next request to a provider). Copying, moving,
// listing, or testing for a file does none of that, so none of them belong here.
//
// Matched in COMMAND POSITION only — start of the command, or after a pipe,
// semicolon, `&&`, or a subshell opener. Without that anchor, ordinary words like
// `type` in `npm run typecheck` or a `--head` flag would trip it.
//
// PowerShell shares this list: `cat`, `type`, and `gc` are all aliases for
// Get-Content there, so the same names cover both shells.
const CONTENT_READERS =
  /(^|[|;&]|&&|\$\(|\bthen\b|\bdo\b)\s*(sudo\s+)?(cat|type|more|less|head|tail|strings|xxd|od|base64|gc|Get-Content|sls|Select-String|findstr|grep|rg|ack|awk|sed|nl|tac|Format-Hex)\b/i;

// `< file` feeds a file's contents in, which can print it just as directly.
const INPUT_REDIRECT = /<\s*[^\s|;&]+/;

/**
 * If `command` would PRINT the contents of a secret or another agent's data,
 * return what it is reaching for; otherwise null.
 *
 * Two conditions, both required: the command reads file content, AND it names one
 * of the sensitive paths. That pairing is what keeps this useful rather than
 * merely irritating: `Test-Path .env` (does it exist?), `ls .claude`, and
 * `cp .env.example .env` all pass, while `cat .env` and `Get-Content .env` do not.
 *
 * This is deliberately not adversarial defense. A model set on evading a string
 * check can always do so, and no amount of pattern-matching a shell fixes that.
 * It is here to stop the accidental `cat .env` that would drop live credentials
 * into the transcript, which is a mistake rather than an attack. The caller points
 * the model at `read_file`, which asks the user properly.
 */
export function sensitiveCommandReason(command: string): string | null {
  const reads = CONTENT_READERS.test(command) || INPUT_REDIRECT.test(command);
  if (!reads) return null;
  for (const { needle, what } of COMMAND_SENSITIVE) {
    if (needle.test(command)) return what;
  }
  return null;
}

// Irreversible, essentially-never-legitimate commands. Patterns are intentionally
// narrow (high precision) so they don't get in the way of real work — the goal is
// to catch the catastrophic mistake, not to police the shell.
const CATASTROPHIC_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\s|$)/i, what: "recursively deleting the filesystem root or home directory" },
  // Real disk-format commands only. `\bformat\b` matched the word anywhere, so every
  // benign PowerShell display cmdlet — `Format-Table`, `Format-List`, `Format-Hex` — and
  // even `git log --format=…` was refused as "reformatting a disk", blocking ordinary
  // work. Now it catches `mkfs`, the CMD `format <drive>:` / `format /switch`, and the
  // PowerShell cmdlets that actually erase a volume (`Format-Volume`, `Format-Disk`).
  { test: /\bmkfs\b|\bformat\s+(?:[a-z]:|\/)|\bformat-(?:volume|disk)\b/i, what: "reformatting a disk" },
  { test: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, what: "overwriting a raw disk device" },
  { test: />\s*\/dev\/(sd|nvme|disk|hd)/i, what: "writing to a raw disk device" },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: "a fork bomb" },
  { test: /\bRemove-Item\b[^\n]*\b-Recurse\b[^\n]*(\\|\/|\$env:|~)(\s|$)/i, what: "recursively deleting a drive root or home directory" },
];

/**
 * If `command` is an irreversible, catastrophic action, return a short reason;
 * otherwise null.
 */
export function catastrophicCommandReason(command: string): string | null {
  for (const { test, what } of CATASTROPHIC_PATTERNS) {
    if (test.test(command)) return what;
  }
  return null;
}
