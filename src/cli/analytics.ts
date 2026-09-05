/**
 * analytics.ts — anonymous usage count, on by default, one file to swap the backend.
 *
 * The payload is `{ id, version }` and nothing else — no code, no keys, no paths, no
 * provider, no tokens. `id` is a random uuid generated once per machine and kept in
 * ~/.mindweave/analytics.json alongside the on/off flag. The whole thing is a single
 * POST to a plain HTTP endpoint, so the backend behind ANALYTICS_ENDPOINT can be
 * replaced later — a different language, a different host — without this file, or the
 * CLI, changing at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "../memory/store.js";

/**
 * Where pings land. Swap this one line (or set MINDWEAVE_ANALYTICS_URL) once the site
 * has a real domain — nothing else here needs to change.
 */
const DEFAULT_ENDPOINT = "https://mindweavedev.netlify.app/.netlify/functions/ping";

function endpoint(): string {
  return process.env.MINDWEAVE_ANALYTICS_URL?.trim() || DEFAULT_ENDPOINT;
}

interface AnalyticsConfig {
  enabled: boolean;
  id: string;
}

function configPath(): string {
  return join(stateRoot(), "analytics.json");
}

function readConfig(): AnalyticsConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof raw?.id === "string" && typeof raw?.enabled === "boolean") {
      return { enabled: raw.enabled, id: raw.id };
    }
    return null;
  } catch {
    return null;
  }
}

function writeConfig(cfg: AnalyticsConfig): void {
  if (!existsSync(stateRoot())) mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

let cached: AnalyticsConfig | null = null;

function config(): AnalyticsConfig {
  if (cached) return cached;
  cached = readConfig() ?? { enabled: true, id: randomUUID() };
  if (!readConfig()) writeConfig(cached);
  return cached;
}

export function analyticsEnabled(): boolean {
  return config().enabled;
}

export function setAnalyticsEnabled(on: boolean): void {
  const cfg = config();
  cfg.enabled = on;
  writeConfig(cfg);
}

/**
 * The full transparency explanation — shown every time the /analytics box opens, not
 * just once. The startup line only ever says on/off; this is where someone actually
 * reads what it does and where to check it themselves.
 */
export const ANALYTICS_EXPLANATION =
  "Sends a random id + the version number, nothing else. Fully open: the code that " +
  "sends it is in the repo, and the numbers it produces are public on the site.\n" +
  "github.com/mindweave-cli/Mindweave · https://mindweavedev.netlify.app/";

/** Shown once per launch, every launch — not a one-time notice. */
export function startupStatusLine(): string {
  return `Analytics: ${analyticsEnabled() ? "on" : "off"} — /analytics for details.`;
}

/** Fire-and-forget. Never throws, never delays startup. */
export function sendAnalyticsPing(version: string): void {
  const cfg = config();
  if (!cfg.enabled) return;
  void fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: cfg.id, version }),
  }).catch(() => {});
}
