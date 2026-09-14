/**
 * metadata.test.ts — reading a server's answer to "who can let me in?".
 *
 * Every one of these is a real shape from the deployed ecosystem rather than an invented
 * one, because the whole reason this module has fallbacks is that servers disagree about
 * where their metadata lives. The ordering assertions matter as much as the parsing: a
 * candidate list in the wrong order is a connection that takes four round trips to fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authServerUrls,
  parseWwwAuthenticate,
  protectedResourceUrls,
  readAuthServerMetadata,
  readResourceMetadata,
  scopeToRequest,
  supportsS256,
} from "./metadata.js";

test("a WWW-Authenticate header gives up the metadata URL, the scope and the error", () => {
  const challenge = parseWwwAuthenticate(
    `Bearer realm="mcp", error="invalid_token", error_description="The token expired", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"`,
  );
  assert.equal(challenge.resourceMetadata, "https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  assert.equal(challenge.scope, "read write");
  assert.equal(challenge.error, "invalid_token");
});

test("a metadata URL carrying its own = and , survives being parsed out", () => {
  // The value is quoted and holds a query string. Splitting the header on commas — the
  // obvious implementation — truncates this at `?a=1` and every later lookup 404s.
  const challenge = parseWwwAuthenticate(`Bearer resource_metadata="https://x.dev/.well-known/prm?a=1,b=2", scope="a"`);
  assert.equal(challenge.resourceMetadata, "https://x.dev/.well-known/prm?a=1,b=2");
  assert.equal(challenge.scope, "a");
});

test("a missing, empty or unparseable header is an empty challenge, never a throw", () => {
  // Losing the header costs a shortcut, not the connection: every field it carries has a
  // fallback below it. Throwing here would turn a server that omits it into one we refuse.
  for (const header of [null, undefined, "", "Bearer", "Basic realm=x"]) {
    assert.deepEqual(parseWwwAuthenticate(header).resourceMetadata, undefined);
  }
});

test("protected-resource lookup puts the well-known segment BEFORE the path, then falls back to the root", () => {
  // RFC 9728 inserts the segment ahead of the resource path, which is the opposite of the
  // OpenID convention and the single most common thing to get wrong.
  assert.deepEqual(protectedResourceUrls("https://mcp.example.com/servers/github"), [
    "https://mcp.example.com/.well-known/oauth-protected-resource/servers/github",
    "https://mcp.example.com/.well-known/oauth-protected-resource",
  ]);
  // A root URL has only one sensible location, and it is not listed twice.
  assert.deepEqual(protectedResourceUrls("https://mcp.example.com/"), ["https://mcp.example.com/.well-known/oauth-protected-resource"]);
  assert.deepEqual(protectedResourceUrls("not a url"), []);
});

test("auth-server lookup covers both specs' idea of where .well-known goes", () => {
  const urls = authServerUrls("https://auth.example.com/tenant1");
  assert.deepEqual(urls, [
    "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
    "https://auth.example.com/tenant1/.well-known/oauth-authorization-server",
    "https://auth.example.com/.well-known/openid-configuration/tenant1",
    "https://auth.example.com/tenant1/.well-known/openid-configuration",
  ]);
  // RFC 8414 leads OpenID discovery: it is the one the MCP specification names.
  assert.ok(urls[0]!.includes("oauth-authorization-server"), "RFC 8414 must be tried first");
});

test("resource metadata is only usable if it names an authorization server", () => {
  assert.deepEqual(
    readResourceMetadata({ resource: "https://mcp.x.dev/mcp", authorization_servers: ["https://auth.x.dev"], scopes_supported: ["read"] }),
    { authorizationServers: ["https://auth.x.dev"], resource: "https://mcp.x.dev/mcp", scopesSupported: ["read"] },
  );
  // A document that parses but names nobody is worse than no document: it would have us
  // stop looking with nowhere to go.
  assert.equal(readResourceMetadata({ resource: "https://mcp.x.dev/mcp" }), null);
  assert.equal(readResourceMetadata({ authorization_servers: [] }), null);
  assert.equal(readResourceMetadata("nope"), null);
});

test("auth server metadata without BOTH endpoints is refused, even though it parsed", () => {
  const full = readAuthServerMetadata({
    issuer: "https://auth.x.dev",
    authorization_endpoint: "https://auth.x.dev/authorize",
    token_endpoint: "https://auth.x.dev/token",
    registration_endpoint: "https://auth.x.dev/register",
    code_challenge_methods_supported: ["S256"],
  });
  assert.equal(full?.tokenEndpoint, "https://auth.x.dev/token");
  assert.equal(full?.registrationEndpoint, "https://auth.x.dev/register");

  // Either endpoint missing makes the rest unusable — there is no flow without both.
  assert.equal(readAuthServerMetadata({ issuer: "x", token_endpoint: "https://a" }), null);
  assert.equal(readAuthServerMetadata({ issuer: "x", authorization_endpoint: "https://a" }), null);
});

test("a server that advertises PKCE methods and omits S256 is refused, not downgraded", () => {
  // `plain` sends the verifier as its own challenge and protects against nothing. Falling
  // back to it would turn a loud incompatibility into a silent loss of protection.
  assert.equal(supportsS256({ issuer: "", authorizationEndpoint: "a", tokenEndpoint: "b", codeChallengeMethodsSupported: ["plain"] }), false);
  assert.equal(supportsS256({ issuer: "", authorizationEndpoint: "a", tokenEndpoint: "b", codeChallengeMethodsSupported: ["plain", "S256"] }), true);
  // Advertising nothing is assumed capable: OAuth 2.1 requires S256 of it anyway, and
  // refusing every server that stays quiet would refuse most of them.
  assert.equal(supportsS256({ issuer: "", authorizationEndpoint: "a", tokenEndpoint: "b" }), true);
});

test("the 401's own scope beats the resource's advertised list", () => {
  const resource = { authorizationServers: ["https://a"], scopesSupported: ["read", "write"] };
  // The header is the server saying what the call that just failed needed. That is more
  // precise than anything advertised, so it wins.
  assert.equal(scopeToRequest({ scope: "issues:write" }, resource), "issues:write");
  assert.equal(scopeToRequest({}, resource), "read write");
  // Undefined rather than "": several providers treat an empty scope parameter as a
  // request for no scopes at all, which is not the same as leaving it out.
  assert.equal(scopeToRequest({}, null), undefined);
  assert.equal(scopeToRequest({ scope: "   " }, null), undefined);
});
