/**
 * protocol.ts — the MCP wire, as data and pure functions.
 *
 * MCP went STATELESS in revision 2026-07-28. That is not a tweak: the
 * `initialize`/`notifications/initialized` handshake is gone, protocol-level sessions
 * are gone, and every single request now carries its own protocol version and client
 * capabilities in a `_meta` envelope. A client written against the old shape does not
 * "mostly work" against a new server; it never introduces itself at all.
 *
 * The catch is that the ecosystem did not move on the same day. Most servers in the
 * wild still speak a 2024/2025 revision and still expect the handshake. So this module
 * describes BOTH shapes and keeps the difference in one place: a `Dialect` picked once
 * per connection (see `discover.ts`), which every request builder then respects.
 *
 * Everything here is PURE — types, envelope construction, result classification, error
 * mapping. No sockets, no processes, no clock. The transports and the connection state
 * machine are the only parts that touch the world, which keeps the fiddly protocol
 * decisions unit-testable rather than smoke-testable.
 */

/** Protocol revisions this client understands, newest first. */
export const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type ProtocolVersion = (typeof SUPPORTED_VERSIONS)[number];

/** The revision we prefer and implement natively. */
export const PREFERRED_VERSION: ProtocolVersion = "2026-07-28";

/** The revision at which MCP became stateless. At or after this, no handshake. */
export const STATELESS_SINCE: ProtocolVersion = "2026-07-28";

/**
 * How to speak to one server.
 *  - `stateless` (2026-07-28+): no handshake; `_meta` on every request.
 *  - `handshake` (everything earlier): `initialize` + `notifications/initialized`
 *    once, then bare requests.
 * Chosen per connection, never per request, so a server can't be spoken to two ways.
 */
export type Dialect = "stateless" | "handshake";

/** Which dialect a negotiated version implies. */
export function dialectFor(version: string): Dialect {
  return version >= STATELESS_SINCE ? "stateless" : "handshake";
}

// ─── _meta keys (2026-07-28) ────────────────────────────────────────────────────
// Reverse-DNS namespaced by the spec. Written out rather than templated so a typo
// is a visible diff and not a silently-ignored field.

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** Who we are, sent on every stateless request (and once at handshake otherwise). */
export interface ClientIdentity {
  name: string;
  version: string;
}

/**
 * What we tell servers we can do.
 *
 * Deliberately EMPTY of the deprecated features. Roots, Sampling, and Logging were all
 * deprecated in 2026-07-28 with a twelve-month removal clock, and the spec's own
 * migration advice is to pass paths as tool parameters, call the LLM provider directly,
 * and log to stderr. Advertising them would invite servers to use them and would make
 * us responsible for features scheduled to disappear.
 *
 * It is also empty of `elicitation`, and that emptiness is now load-bearing rather than
 * merely absent: under MRTR a server "MUST NOT send an inputRequests that the client has
 * not declared support for", so declaring nothing is what keeps servers from asking us
 * questions we have no way to put to the user. Adding a key here without building the UI
 * behind it would invite exactly the requests we would then have to fail.
 */
export interface ClientCapabilities {
  extensions?: Record<string, unknown>;
}

export const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {};

/**
 * Build the `_meta` envelope for one request. Empty on the handshake dialect, where
 * this information travelled once in `initialize` instead.
 */
export function buildMeta(
  dialect: Dialect,
  version: string,
  identity: ClientIdentity,
  capabilities: ClientCapabilities = DEFAULT_CLIENT_CAPABILITIES,
): Record<string, unknown> | undefined {
  if (dialect !== "stateless") return undefined;
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_CAPABILITIES]: capabilities,
    [META_CLIENT_INFO]: { name: identity.name, version: identity.version },
  };
}

/** A JSON-RPC 2.0 request frame, with MCP's `_meta` folded into params when it applies. */
export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Compose a request frame. `_meta` rides inside `params`, per the spec. */
export function buildRequest(
  id: number,
  method: string,
  params: Record<string, unknown> | undefined,
  meta: Record<string, unknown> | undefined,
): RpcRequest {
  const body = meta ? { ...(params ?? {}), _meta: meta } : params;
  return { jsonrpc: "2.0", id, method, ...(body ? { params: body } : {}) };
}

// ─── Results ────────────────────────────────────────────────────────────────────

/**
 * Every 2026-07-28 result carries `resultType`. Earlier servers do not send it, and
 * the spec is explicit that a missing field MUST be read as "complete" — so the
 * default here is not a convenience, it is the compatibility rule. Getting it backwards
 * would make every legacy result look like a pending multi-round-trip request.
 */
export type ResultType = "complete" | "input_required";

export function resultTypeOf(result: unknown): ResultType {
  const t = (result as { resultType?: unknown } | null)?.resultType;
  return t === "input_required" ? "input_required" : "complete";
}

/**
 * The three methods a server may answer with `input_required`.
 *
 * Closed by the spec — "Servers MUST NOT send InputRequiredResult responses on any other
 * client requests" — which is why this is a list and not a flag on every call. A
 * `tools/list` that claimed to need input would be a broken server, and treating it as a
 * continuation rather than as a catalog would hide that.
 */
export const MRTR_METHODS = ["tools/call", "resources/read", "prompts/get"] as const;

/** What a server asked us to go and find out, unpacked from an `InputRequiredResult`. */
export interface InputRequired {
  /**
   * Server-assigned key -> the request it wants answered. The keys are the server's
   * own and the answers must come back under the same ones, so the map is carried
   * whole rather than flattened into a list.
   */
  readonly inputRequests: Record<string, { method: string }>;
  /**
   * Opaque continuation token. MUST be echoed back exactly on the retry, and MUST NOT
   * be sent at all when the server did not supply one — so "absent" and "empty string"
   * are genuinely different here and undefined is not a stand-in for either.
   */
  readonly requestState?: string;
}

/**
 * Read an `InputRequiredResult`, or null if this result is simply complete (pure).
 *
 * Nothing is inspected beyond the shape: `requestState` is the server's private
 * business and the spec forbids parsing it, so it is passed through as the string it
 * arrived as. From `inputRequests` only the method names are lifted, and only so a
 * failure can say what was asked for — the params belong to whoever can answer them.
 */
export function readInputRequired(result: unknown): InputRequired | null {
  if (resultTypeOf(result) !== "input_required") return null;
  const r = result as { inputRequests?: unknown; requestState?: unknown };
  const requests: Record<string, { method: string }> = {};
  if (r.inputRequests && typeof r.inputRequests === "object" && !Array.isArray(r.inputRequests)) {
    for (const [key, value] of Object.entries(r.inputRequests as Record<string, unknown>)) {
      const method = (value as { method?: unknown } | null)?.method;
      requests[key] = { method: typeof method === "string" ? method : "unknown" };
    }
  }
  return {
    inputRequests: requests,
    ...(typeof r.requestState === "string" ? { requestState: r.requestState } : {}),
  };
}

/**
 * Cache directives on list results (`tools/list`, `prompts/list`, `resources/list`,
 * `resources/read`, `resources/templates/list`). `ttlMs` is a freshness hint;
 * `cacheScope` says whether a shared intermediary may hold it.
 */
export interface CacheDirective {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

export function cacheDirectiveOf(result: unknown): CacheDirective {
  const r = result as { ttlMs?: unknown; cacheScope?: unknown } | null;
  const ttl = typeof r?.ttlMs === "number" && Number.isFinite(r.ttlMs) && r.ttlMs >= 0 ? r.ttlMs : undefined;
  const scope = r?.cacheScope === "public" || r?.cacheScope === "private" ? r.cacheScope : undefined;
  return { ...(ttl !== undefined ? { ttlMs: ttl } : {}), ...(scope ? { cacheScope: scope } : {}) };
}

// ─── Errors ─────────────────────────────────────────────────────────────────────

/**
 * The 2026-07-28 error-code partition. `-32000`–`-32019` stays implementation-defined
 * (existing SDK usage is grandfathered); `-32020`–`-32099` is reserved for the spec.
 *
 * The three MCP codes were RENUMBERED out of the implementation-defined range in this
 * revision, so the old values still appear in the wild and both have to be recognised.
 * Resource-not-found also moved, from `-32002` to plain JSON-RPC `-32602`.
 */
export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

/** Pre-renumbering values, still sent by servers on older revisions. */
const LEGACY_ERROR_CODES = {
  headerMismatch: -32001,
  resourceNotFound: -32002,
  missingRequiredClientCapability: -32003,
  unsupportedProtocolVersion: -32004,
} as const;

export type McpErrorKind =
  | "parse"
  | "invalid-request"
  | "method-not-found"
  | "invalid-params"
  | "internal"
  | "header-mismatch"
  | "missing-capability"
  | "unsupported-version"
  | "unknown";

/** Classify a JSON-RPC error code, accepting both the new and pre-renumbering values. */
export function errorKind(code: number): McpErrorKind {
  switch (code) {
    case ERROR_CODES.parse:
      return "parse";
    case ERROR_CODES.invalidRequest:
      return "invalid-request";
    case ERROR_CODES.methodNotFound:
      return "method-not-found";
    case ERROR_CODES.invalidParams:
      return "invalid-params";
    case ERROR_CODES.internal:
      return "internal";
    case ERROR_CODES.headerMismatch:
    case LEGACY_ERROR_CODES.headerMismatch:
      return "header-mismatch";
    case ERROR_CODES.missingRequiredClientCapability:
    case LEGACY_ERROR_CODES.missingRequiredClientCapability:
      return "missing-capability";
    case ERROR_CODES.unsupportedProtocolVersion:
    case LEGACY_ERROR_CODES.unsupportedProtocolVersion:
      return "unsupported-version";
    default:
      return "unknown";
  }
}

/**
 * Does this error mean "that method does not exist here"?
 *
 * Load-bearing for version detection: a pre-2026 server has never heard of
 * `server/discover`, and how it says so is not consistent. Most return
 * `-32601 Method not found`; some return an internal error whose message says the
 * same thing. Both have to count, or the backwards-compatibility probe reads a
 * legacy server as simply broken and drops it.
 */
export function isMethodNotFound(code: number, message = ""): boolean {
  if (errorKind(code) === "method-not-found") return true;
  return /method not found|unknown method|not supported|unsupported method/i.test(message);
}

/** Resource-not-found, across the code change (`-32002` → `-32602`). */
export function isResourceNotFound(code: number): boolean {
  return code === ERROR_CODES.invalidParams || code === LEGACY_ERROR_CODES.resourceNotFound;
}
