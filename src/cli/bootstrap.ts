/**
 * bootstrap.ts — make `mindweave` runnable from any directory.
 *
 * The whole point of a global command is that you `cd` into ANY project, type
 * `mindweave`, and it works — including the API key. A random project won't carry
 * Mindweave's `.env`, so the key has to live somewhere global. We layer config the
 * way every CLI does, lowest priority first:
 *
 *   1. ~/.mindweave/.env   — the global store (write your key here once).
 *   2. <project>/.env  — per-project overrides (optional).
 *   3. real shell env  — always wins (export a provider's key for a one-off).
 *
 * We parse `.env` ourselves (a tiny, dependency-free reader) so we control that
 * precedence exactly: a value is only applied if the variable isn't already set,
 * and we load project before global — so shell > project > global falls out
 * naturally. On first run we also drop a commented template at ~/.mindweave/.env so
 * the user has an obvious place to paste their key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../memory/store.js";
import { allProviders } from "../drivers/registry.js";

/**
 * The global Mindweave config directory (~/.mindweave).
 *
 * The SAME directory the state lives in, and now the same function that resolves it.
 * They were computed separately and only one honoured `MINDWEAVE_STATE_DIR`, so a test
 * run — or anyone relocating Mindweave's files — moved the sessions and left the config
 * behind in the real home. The suite creates this template, which meant a clean machine
 * got a config file written into `~/.mindweave` by `npm test`: exactly the pollution
 * scripts/testState.mjs exists to prevent, still open on the config side.
 */
export function globalConfigDir(): string {
  return stateRoot();
}

/** The global env file (~/.mindweave/.env) — where the API key lives. */
export function globalEnvPath(): string {
  return join(globalConfigDir(), ".env");
}

/**
 * Load configuration into process.env. Call once, before anything reads a key.
 * Order matters: project first, then global, each set-if-absent, so already-set
 * shell variables win and a project `.env` overrides the global one.
 */
export function loadConfig(cwd: string = process.cwd()): void {
  ensureGlobalTemplate();
  reloadConfig(cwd);
}

/**
 * Re-read the env files into process.env without recreating the template. Used to
 * pick up a key the user just pasted while Mindweave is already running — once a real
 * key appears we adopt it with no restart. (Empty values are ignored, so the
 * blank key lines in the fresh template never count as "set".)
 */
export function reloadConfig(cwd: string = process.cwd()): void {
  applyEnvFile(join(cwd, ".env"));
  applyEnvFile(globalEnvPath());
}

/**
 * True once the named provider's key is available from any source.
 *
 * The variable name is a parameter rather than a constant because which key is
 * needed depends on which model the user is about to run — each provider declares
 * its own in its manifest. This module stays a plain config utility and never
 * imports the driver registry.
 */
export function hasApiKey(envVar: string): boolean {
  return Boolean(process.env[envVar]);
}

/**
 * Persist a key the user typed in the terminal: write it into ~/.mindweave/.env (so
 * it's there next launch too) and apply it to this process right away (so the
 * chat can start immediately — no restart). Updates that provider's line in place,
 * preserving every other line, so adding a second provider's key never disturbs
 * the first one.
 */
export function saveApiKey(envVar: string, key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  process.env[envVar] = trimmed;

  const dir = globalConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = globalEnvPath();

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* no file yet */
  }
  const line = `${envVar}=${trimmed}`;
  const pattern = new RegExp(`^\\s*${envVar}=.*$`, "m");
  const next = pattern.test(existing)
    ? existing.replace(pattern, line)
    : (existing ? existing.replace(/\s*$/, "\n") : "") + line + "\n";
  writeFileSync(path, next, { mode: 0o600 });
}

/**
 * What lands in ~/.mindweave/.env the first time Mindweave runs.
 *
 * Every provider, because this is the file a new user actually opens — it listed two of
 * thirteen, and someone who came for Gemini or Groq found no sign their provider existed.
 * Built from the registry rather than typed out, so a new driver cannot be forgotten
 * here (docsCurrent.test.ts holds the same line for .env.example and PROVIDERS.md).
 */
const GLOBAL_ENV_TEMPLATE = [
  "# Mindweave global config — applies in every project.",
  "# Paste a key below (no quotes needed). You only need the one for the provider you",
  "# actually use; fill in several and /provider moves between them.",
  "",
  // The name on its OWN line, never trailing the assignment. `KEY=   # DeepSeek` reads
  // fine and parses as a VALUE of "# DeepSeek", so every provider would have reported a
  // key it did not have: no first-run prompt, and every request rejected with no
  // explanation. Caught by reading the parsed result rather than the file.
  ...allProviders().flatMap((p) => [`# ${p.label}`, `${p.apiKeyEnv}=`]),
  "",
  "# Optional:",
  "# MINDWEAVE_MODEL — which model to open with. Run /model in Mindweave for the list.",
  "# MINDWEAVE_MODEL=",
  "",
].join(String.fromCharCode(10));


/** Create ~/.mindweave/.env with a commented template the first time we run. */
function ensureGlobalTemplate(): void {
  try {
    const dir = globalConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = globalEnvPath();
    if (!existsSync(path)) {
      writeFileSync(
        path,
        GLOBAL_ENV_TEMPLATE,
        { mode: 0o600 },
      );
    }
  } catch {
    // Best-effort: if we can't write the template, config loading still works.
  }
}

/** Apply a single .env file (set-if-absent), tolerating a missing/garbled file. */
function applyEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no file here — fine
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7) : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key || key in process.env) continue; // already set wins
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // ignore empty assignments (e.g. the blank template line)
    process.env[key] = value;
  }
}
