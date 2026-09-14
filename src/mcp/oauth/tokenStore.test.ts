/**
 * tokenStore.test.ts — credentials on disk.
 *
 * EVERY test runs inside `withSandbox`, which points `MINDWEAVE_STATE_DIR` at a temporary
 * directory. Without it these write real OAuth tokens into whoever's `~/.mindweave` is
 * running the suite. That exact class of mistake has already happened once in this repo,
 * with MCP config rather than tokens, and it ended with test fixtures showing up as hung
 * servers in a live session. Tokens would be worse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authFilePath, clearAuth, isExpired, readAuth, serverKey, writeAuth, type StoredAuth } from "./tokenStore.js";
import type { McpServerConfig } from "../config.js";

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mw-oauth-"));
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = previous;
  }
}

const http = (url: string, name = "remote"): McpServerConfig => ({ type: "http", name, url });
const auth = (over: Partial<StoredAuth> = {}): StoredAuth => ({
  accessToken: "at",
  clientId: "cid",
  tokenEndpoint: "https://auth.x.dev/token",
  ...over,
});

test("a credential is keyed by the URL as well as the name", () => {
  // Keying by name alone would hand the token minted for one host to whatever is
  // configured under that name later. Names are the user's and get reused; the URL is
  // what the token was actually issued for.
  assert.notEqual(serverKey("linear", http("https://mcp.linear.app/mcp")), serverKey("linear", http("https://evil.example/mcp")));
  // Stable for the same pair, or nothing would ever be found again.
  assert.equal(serverKey("linear", http("https://mcp.linear.app/mcp")), serverKey("linear", http("https://mcp.linear.app/mcp")));
  // The name leads, so a person opening the file can tell whose entry it is.
  assert.match(serverKey("linear", http("https://mcp.linear.app/mcp")), /^linear:[0-9a-f]{16}$/);

  // Headers count too. A configured header is often what selects an account or a tenant
  // at the other end, so a token minted under one has no business being sent after it
  // changed — that credential belongs to a context that no longer exists.
  const plain: McpServerConfig = { type: "http", name: "linear", url: "https://mcp.linear.app/mcp" };
  const tenanted: McpServerConfig = { ...plain, headers: { "x-tenant": "acme" } };
  assert.notEqual(serverKey("linear", plain), serverKey("linear", tenanted));
});

test("a token round-trips, and an unknown server has nothing", async () => {
  await withSandbox(async () => {
    const key = serverKey("remote", http("https://x.dev/mcp"));
    assert.equal(await readAuth(key), undefined);
    await writeAuth(key, auth({ refreshToken: "rt", expiresAt: 123, scope: "read" }));
    const back = await readAuth(key);
    assert.equal(back?.accessToken, "at");
    assert.equal(back?.refreshToken, "rt");
    assert.equal(back?.scope, "read");
  });
});

test("writing one server's token leaves every other server's alone", async () => {
  // One map, written whole. A rewrite that dropped the others would sign the user out of
  // everything each time any single token refreshed.
  await withSandbox(async () => {
    const a = serverKey("a", http("https://a.dev/mcp", "a"));
    const b = serverKey("b", http("https://b.dev/mcp", "b"));
    await writeAuth(a, auth({ accessToken: "token-a" }));
    await writeAuth(b, auth({ accessToken: "token-b" }));
    assert.equal((await readAuth(a))?.accessToken, "token-a");
    assert.equal((await readAuth(b))?.accessToken, "token-b");

    await clearAuth(a);
    assert.equal(await readAuth(a), undefined);
    assert.equal((await readAuth(b))?.accessToken, "token-b", "clearing one must not touch another");
  });
});

test("the file is written owner-only", async () => {
  await withSandbox(async () => {
    await writeAuth(serverKey("x", http("https://x.dev/mcp", "x")), auth());
    const stat = await fs.stat(authFilePath());
    // Windows does not carry POSIX permission bits, so the mode is only meaningful where
    // the filesystem actually has them; asserting 0600 everywhere would fail for a
    // reason that has nothing to do with this code.
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600, "a token file readable by other accounts is a leaked token");
    }
  });
});

test("a corrupt or missing file reads as 'no credential' rather than throwing", async () => {
  // Both mean the same thing to a caller — nothing to send — and the flow that follows
  // will mint a fresh one. Throwing would turn a damaged file into an unusable app.
  await withSandbox(async () => {
    assert.equal(await readAuth("nobody"), undefined);
    await fs.mkdir(join(process.env.MINDWEAVE_STATE_DIR!), { recursive: true });
    await fs.writeFile(authFilePath(), "{ not json", "utf8");
    assert.equal(await readAuth("nobody"), undefined);
  });
});

test("clearing something that was never there is not an error", async () => {
  await withSandbox(async () => {
    await clearAuth("never-stored");
  });
});

test("expiry leaves a minute of headroom, and no expiry never expires", () => {
  const now = 1_000_000;
  // A token has to survive the round trip it is about to be spent on, and a clock a few
  // seconds fast would otherwise send something the server already retired.
  assert.equal(isExpired(auth({ expiresAt: now + 120_000 }), now), false);
  assert.equal(isExpired(auth({ expiresAt: now + 30_000 }), now), true, "inside the skew counts as expired");
  assert.equal(isExpired(auth({ expiresAt: now - 1 }), now), true);
  // A server that never said is asked again on the next 401, not refreshed on a guess.
  assert.equal(isExpired(auth(), now), false);
});
