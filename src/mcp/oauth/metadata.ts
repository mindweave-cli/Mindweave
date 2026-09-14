/**
 * metadata.ts — finding out WHO can issue a token for a server, from the server itself.
 *
 * A remote MCP server that wants authorization answers an unauthenticated call with 401
 * and a `WWW-Authenticate` header, and that header is the whole entry point: it names the
 * URL of the server's Protected Resource Metadata (RFC 9728), which in turn names the
 * authorization servers that can issue tokens for it, and each of those publishes its own
 * metadata (RFC 8414) saying where to send someone to approve access and where to redeem
 * the code afterwards. Three documents, fetched in that order, and none of them is
 * configured by hand: the point of the chain is that adding a server is a URL and nothing
 * else.
 *
 * Everything here is PURE — parsing and URL construction only. The fetching lives in
 * `flow.ts`, so the part with all the branching is the part a test can drive directly
 * with a string, and the part doing network I/O stays small enough to read in one go.
 *
 * THE FALLBACKS ARE NOT OPTIONAL. RFC 9728 arrived long after the servers that are
 * deployed today, and a large share of them either omit the header, omit the metadata
 * document, or publish it at the pre-RFC location. Every lookup here therefore produces a
 * LIST of candidate URLs in descending order of correctness, and the caller tries them in
 * turn. The alternative is refusing to connect to most of the ecosystem on a technicality.
 */

/** What a 401's `WWW-Authenticate` told us. Every field is optional: a server may send
 *  the header with nothing useful in it, or no header at all. */
export interface AuthChallenge {
  /** The RFC 9728 metadata document's URL, when the server names it. The one field worth
   *  the header existing — it skips the guesswork below entirely. */
  resourceMetadata?: string;
  /** Scopes the server says this call needed. Passed through to the authorize request so
   *  the consent screen asks for the right things rather than a guess. */
  scope?: string;
  /** `invalid_token`, `insufficient_scope`, … Kept for the message shown to the user: an
   *  expired token and a token missing a scope are both 401 and want different words. */
  error?: string;
}

/**
 * Parse a `WWW-Authenticate` header (pure).
 *
 * The grammar is `Scheme param=value, param="value"` and the values that matter here are
 * routinely quoted and routinely contain `=` and `,` of their own (a metadata URL has a
 * query string), so this walks the string rather than splitting it. A header we cannot
 * make sense of yields an empty challenge rather than throwing: it costs us the shortcut,
 * not the connection, because every field is a shortcut past a fallback.
 */
export function parseWwwAuthenticate(header: string | null | undefined): AuthChallenge {
  if (!header) return {};
  const challenge: AuthChallenge = {};
  // Skip the scheme token ("Bearer"), then read `key=value` pairs. A quoted value runs to
  // its closing quote and may hold anything; a bare value runs to the next comma.
  const params = /([A-Za-z_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  for (const match of header.matchAll(params)) {
    const key = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
    if (!value) continue;
    if (key === "resource_metadata") challenge.resourceMetadata = value;
    else if (key === "scope") challenge.scope = value;
    else if (key === "error") challenge.error = value;
  }
  return challenge;
}

/**
 * Where a server's Protected Resource Metadata might live, best first (pure).
 *
 * RFC 9728 inserts the well-known segment BEFORE the resource's own path
 * (`/.well-known/oauth-protected-resource/mcp`), which is the opposite of the OpenID
 * convention and the single most common thing to get wrong, so the path-aware form leads
 * and the root form follows for servers that publish one document for the whole host.
 */
export function protectedResourceUrls(serverUrl: string): string[] {
  const url = safeUrl(serverUrl);
  if (!url) return [];
  const path = trimSlashes(url.pathname);
  const out: string[] = [];
  if (path) out.push(`${url.origin}/.well-known/oauth-protected-resource/${path}`);
  out.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/**
 * Where an authorization server's metadata might live, best first (pure).
 *
 * Four shapes, because two specifications disagree about where the segment goes and both
 * are deployed: RFC 8414 puts `.well-known` before the issuer's path, OpenID Connect
 * Discovery appends it. An issuer with no path collapses to two.
 */
export function authServerUrls(issuer: string): string[] {
  const url = safeUrl(issuer);
  if (!url) return [];
  const path = trimSlashes(url.pathname);
  const out: string[] = [];
  if (path) {
    out.push(`${url.origin}/.well-known/oauth-authorization-server/${path}`);
    out.push(`${url.origin}/${path}/.well-known/oauth-authorization-server`);
    out.push(`${url.origin}/.well-known/openid-configuration/${path}`);
    out.push(`${url.origin}/${path}/.well-known/openid-configuration`);
    return out;
  }
  out.push(`${url.origin}/.well-known/oauth-authorization-server`);
  out.push(`${url.origin}/.well-known/openid-configuration`);
  return out;
}

/** The fields of RFC 9728 we act on. */
export interface ResourceMetadata {
  /** Issuers that can mint tokens for this server. More than one is legal; we take the
   *  first that produces usable metadata. */
  authorizationServers: string[];
  /** The canonical identifier for this resource, sent as RFC 8707 `resource` so the token
   *  we get back is bound to THIS server and is useless if it leaks to another. */
  resource?: string;
  scopesSupported?: string[];
}

/** Read RFC 9728 metadata, or null if it is not that (pure). */
export function readResourceMetadata(json: unknown): ResourceMetadata | null {
  const o = asObject(json);
  if (!o) return null;
  const servers = stringArray(o.authorization_servers);
  if (servers.length === 0) return null;
  const out: ResourceMetadata = { authorizationServers: servers };
  const resource = asString(o.resource);
  if (resource) out.resource = resource;
  const scopes = stringArray(o.scopes_supported);
  if (scopes.length > 0) out.scopesSupported = scopes;
  return out;
}

/** The fields of RFC 8414 we act on. */
export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7591 dynamic registration. Absent means the server expects a client id issued
   *  out of band, which is a wall for a CLI that has never spoken to it before. */
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  /** Present and lacking S256 is a server we refuse: plain PKCE is not protection. */
  codeChallengeMethodsSupported?: string[];
}

/** Read RFC 8414 / OIDC discovery metadata, or null if the required endpoints are absent
 *  (pure). Both endpoints are load bearing, so a document missing either is not usable
 *  even though it parsed. */
export function readAuthServerMetadata(json: unknown): AuthServerMetadata | null {
  const o = asObject(json);
  if (!o) return null;
  const authorizationEndpoint = asString(o.authorization_endpoint);
  const tokenEndpoint = asString(o.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  const out: AuthServerMetadata = {
    issuer: asString(o.issuer) ?? "",
    authorizationEndpoint,
    tokenEndpoint,
  };
  const registration = asString(o.registration_endpoint);
  if (registration) out.registrationEndpoint = registration;
  const revocation = asString(o.revocation_endpoint);
  if (revocation) out.revocationEndpoint = revocation;
  const scopes = stringArray(o.scopes_supported);
  if (scopes.length > 0) out.scopesSupported = scopes;
  const methods = stringArray(o.code_challenge_methods_supported);
  if (methods.length > 0) out.codeChallengeMethodsSupported = methods;
  return out;
}

/**
 * Does this authorization server support the only PKCE method we will use (pure)?
 *
 * A server that ADVERTISES its methods and does not list S256 is refused rather than
 * downgraded. `plain` sends the verifier itself as the challenge, which protects against
 * nothing, and quietly falling back to it would turn a loud incompatibility into a silent
 * loss of the protection PKCE exists for. A server that advertises nothing is assumed to
 * support S256, which is what the OAuth 2.1 draft requires of it anyway.
 */
export function supportsS256(meta: AuthServerMetadata): boolean {
  return meta.codeChallengeMethodsSupported === undefined || meta.codeChallengeMethodsSupported.includes("S256");
}

/**
 * The scope string to ask for, or undefined to let the server decide (pure).
 *
 * The 401's own `scope` wins: it is the server saying what the call that just failed
 * needed, which is more precise than anything advertised. Otherwise everything the
 * resource says it supports, and failing that nothing at all — an empty `scope` parameter
 * is meaningfully different from an absent one at several providers, so it is omitted
 * rather than sent blank.
 */
export function scopeToRequest(challenge: AuthChallenge, resource: ResourceMetadata | null): string | undefined {
  if (challenge.scope?.trim()) return challenge.scope.trim();
  if (resource?.scopesSupported && resource.scopesSupported.length > 0) return resource.scopesSupported.join(" ");
  return undefined;
}

function safeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}
