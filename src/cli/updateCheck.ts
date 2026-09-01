/**
 * updateCheck.ts — a quiet check for a newer release.
 *
 * Reads exactly one public fact from the registry — the version currently tagged
 * `latest` — the same request `npm install` itself makes. Nothing describing the
 * user leaves the machine: no identifier, no payload, nothing that makes this the
 * telemetry the project promises it does not have. Still opt-out
 * (MINDWEAVE_NO_UPDATE_CHECK), because a network call at startup a user cannot turn
 * off reads as a small breach of that promise even when it is harmless.
 *
 * Checked at most once a day, cached in ~/.mindweave/update-check.json, so an
 * ordinary session never adds a network round trip to every launch. Fails silent on
 * every path — a slow or unreachable registry must never be the reason the app
 * hesitates, errors, or even prints a warning.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "./bootstrap.js";
import { appVersion } from "./version.js";

const REGISTRY_URL = "https://registry.npmjs.org/mindweave/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

function cachePath(): string {
  return join(globalConfigDir(), "update-check.json");
}

function readCache(): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<UpdateCache>;
    if (typeof raw.checkedAt === "number" && typeof raw.latest === "string") return raw as UpdateCache;
  } catch {
    // No cache yet, or it is corrupt — treat as absent rather than crashing on it.
  }
  return null;
}

function writeCache(cache: UpdateCache): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    // A read-only disk should not turn a version check into a startup failure.
  }
}

/**
 * Plain x.y.z compare. Positive when `a` is newer than `b`. A missing or
 * non-numeric part reads as 0 rather than throwing, so a malformed string from the
 * registry — or from a stale cache file — degrades to "no update" instead of a crash.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    // Offline, DNS failure, a timeout, a non-JSON body — all the same outcome: no answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateCheckDeps {
  now?: number;
  running?: string;
  fetchImpl?: typeof fetch;
  readCacheImpl?: () => UpdateCache | null;
  writeCacheImpl?: (c: UpdateCache) => void;
}

/**
 * The newer version string if one is genuinely available, else null. Every
 * dependency is injectable so a test never touches the real registry or the real
 * disk; production code calls it with no arguments.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<string | null> {
  if (process.env.MINDWEAVE_NO_UPDATE_CHECK) return null;
  const running = deps.running ?? appVersion();
  if (!running) return null;

  const now = deps.now ?? Date.now();
  const readC = deps.readCacheImpl ?? readCache;
  const writeC = deps.writeCacheImpl ?? writeCache;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const cached = readC();
  if (cached && now - cached.checkedAt < CHECK_INTERVAL_MS) {
    return compareVersions(cached.latest, running) > 0 ? cached.latest : null;
  }

  const latest = await fetchLatest(fetchImpl);
  // A failed fetch writes nothing: a machine that is genuinely offline should try
  // again on its next launch rather than going quiet for a full day on the strength
  // of one bad request.
  if (!latest) return null;
  writeC({ checkedAt: now, latest });
  return compareVersions(latest, running) > 0 ? latest : null;
}
