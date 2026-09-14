/**
 * tokenStore.ts — where a server's tokens live between runs.
 *
 * NOT the `.env` file the API keys use, and that is deliberate. A provider key is typed
 * once by a person and belongs in a file a person can open; an OAuth token is issued by a
 * machine, expires in an hour, is replaced silently by a refresh, and is meaningless to
 * read. Putting the two in one file would mean a rewrite of the user's own config every
 * time a token rotated, with their comments and ordering at risk each time.
 *
 * So: one JSON file of our own under the state directory, written whole, `0600`.
 *
 * KEYED BY NAME **AND** CONFIG, via `serverKey`. Keying by name alone would hand the
 * token issued for one URL to whatever is configured under that name later — rename a
 * server, point it at a different host, and the old credential follows it. Names are
 * chosen by the user and reused freely; the URL is what the token was actually minted
 * for, so both go into the key and changing either is a different server.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stateRoot } from "../../memory/store.js";
import type { McpServerConfig } from "../config.js";

/** One server's credentials, as persisted. */
export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means the server never said, which we treat as "ask again on the
   *  next 401" rather than as "never expires". */
  expiresAt?: number;
  scope?: string;
  /** From dynamic registration (RFC 7591). Kept because re-registering on every launch
   *  litters the authorization server with one client per run, and several refuse after
   *  a while. */
  clientId: string;
  /** Some authorization servers issue one to a "public" client anyway. Stored because the
   *  token endpoint will ask for it on refresh, and losing it means re-registering. */
  clientSecret?: string;
  /** The token endpoint this was minted at, so a refresh needs no rediscovery. */
  tokenEndpoint: string;
  /** Where to tell the server the token is finished with, when it offers that at all. */
  revocationEndpoint?: string;
  /** RFC 8707 audience, replayed on refresh so the new token is bound the same way. */
  resource?: string;
}

/** The whole file. A map, so several servers coexist and one being rewritten cannot
 *  disturb another's entry. */
interface AuthFile {
  servers: Record<string, StoredAuth>;
}

/** Read on every call rather than cached at import, matching `stateRoot` itself, so a
 *  test can point this somewhere disposable before anything touches it. */
export function authFilePath(): string {
  return join(stateRoot(), "mcp-auth.json");
}

/**
 * The identity a credential is filed under (pure).
 *
 * A short hash of the URL rather than the URL itself: this string ends up as a JSON key
 * in a file people will open when something is wrong, and a full URL with its query
 * string makes that file unreadable. The name is kept in front of it so the entry is
 * still recognisable at a glance.
 */
export function serverKey(name: string, config: McpServerConfig): string {
  // The HEADERS are part of the identity too, not just the URL. A configured header is
  // frequently the thing that selects an account or a tenant at the other end, so a token
  // minted while one was set has no business being sent after it changed — that is a
  // credential for a context that no longer exists.
  const identity =
    config.type === "http"
      ? JSON.stringify({ type: "http", url: config.url, headers: config.headers ?? {} })
      : JSON.stringify({ type: "stdio", command: config.command, args: config.args });
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${name}:${digest}`;
}

async function readFile(): Promise<AuthFile> {
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const servers = typeof parsed === "object" && parsed !== null ? (parsed as AuthFile).servers : undefined;
    return { servers: typeof servers === "object" && servers !== null ? servers : {} };
  } catch {
    // Missing is the normal case on a first run, and unreadable is not worth failing a
    // connection over: both mean "no credential", and the flow that follows will mint one.
    return { servers: {} };
  }
}

/**
 * Replace the whole file, owner-readable only.
 *
 * Written to a temporary name and renamed, because a token file truncated by a crash
 * mid-write is not a token file with one bad entry — it is a file that fails to parse and
 * silently signs the user out of every server at once. The mode is set on the temporary
 * file BEFORE the rename, so there is no window in which the real path exists readable.
 */
async function writeFile(file: AuthFile): Promise<void> {
  const target = authFilePath();
  await fs.mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
}

export async function readAuth(key: string): Promise<StoredAuth | undefined> {
  return (await readFile()).servers[key];
}

export async function writeAuth(key: string, auth: StoredAuth): Promise<void> {
  // Re-read immediately before writing rather than holding the file in memory: two
  // servers can finish a refresh at the same moment, and the loser of a last-write-wins
  // race would otherwise drop the winner's brand new token.
  const file = await readFile();
  file.servers[key] = auth;
  await writeFile(file);
}

export async function clearAuth(key: string): Promise<void> {
  const file = await readFile();
  if (!(key in file.servers)) return;
  delete file.servers[key];
  await writeFile(file);
}

/**
 * Is this token worth sending (pure)?
 *
 * A minute of headroom, because the token has to survive the round trip it is about to be
 * spent on, and a clock that is thirty seconds fast would otherwise send something the
 * server has already retired and turn a refresh into a 401.
 */
const EXPIRY_SKEW_MS = 60_000;

export function isExpired(auth: StoredAuth, now = Date.now()): boolean {
  return auth.expiresAt !== undefined && auth.expiresAt - EXPIRY_SKEW_MS <= now;
}
