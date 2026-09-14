/**
 * mcpMinitabs.probe.test.tsx — `/mcp`'s pure logic, and its list screen rendered.
 *
 * Same split `keyManager.probe.test.tsx` uses: the DECISIONS (which steps a form needs,
 * what argv a draft turns into, which actions a server offers) are pure functions and are
 * tested directly, fast and exactly; the one screen reachable with no simulated keypress
 * — the servers list, the moment `/mcp` opens — is rendered into a fake terminal and read
 * back like every other UI claim here. The wizard and manage screens are reached by real
 * keystrokes this file does not simulate, for the same reason `/key`'s own "enter" field
 * mode never is either: this codebase has no validated arrow/Enter/PageUp byte sequence
 * for a list component yet, and guessing one here would risk a test that is wrong in the
 * same way the code could be.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, Box } from "ink";
import { McpMinitabs, actionsFor, argvFromDraft, blankDraft, deriveName, draftFromConfig, serverDetail, stepsFor, type WizardDraft } from "./components/McpMinitabs.js";
import type { ConnectionStatus } from "../mcp/connection.js";
import { parseAddSpec } from "../mcp/configWrite.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 76,
    rows: 30,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(
    <Box flexDirection="column" width={64} borderStyle="single" borderColor="gray" paddingX={1}>
      {node}
    </Box>,
    { stdout: stream, patchConsole: false, interactive: true },
  );
  app.unmount();
  const ESC = String.fromCharCode(27);
  return out.join("").replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "");
}

function status(over: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    name: "fake",
    type: "stdio",
    state: "connected",
    toolCount: 3,
    promptCount: 0,
    offersResources: false,
    attempts: 0,
    ...over,
  };
}

// ── stepsFor ─────────────────────────────────────────────────────────────────

test("there is no 'pick a transport' step and no 'server name' step — you type the command first", () => {
  // Both absences are deliberate. Choosing "A command" and then being asked for a NAME is
  // a form arguing with itself, so the transports are the two rows of the command field
  // and the name is derived from what was typed. Same shape for adding and for editing.
  assert.deepEqual(stepsFor("stdio"), ["command", "env", "scope", "review"]);
});

test("an http server has a headers step instead of env — a header's value routinely contains spaces", () => {
  assert.deepEqual(stepsFor("http"), ["command", "headers", "scope", "review"]);
});

test("the name is derived from what was typed, for both transports", () => {
  const cmd = (commandLine: string): string => deriveName({ ...blankDraft(), commandLine });
  assert.equal(cmd("npx -y @modelcontextprotocol/server-github"), "github", "scope and the 'server-' prefix are noise");
  assert.equal(cmd("npx -y @upstash/context7-mcp"), "context7", "a trailing -mcp says WHAT it is, not WHICH");
  assert.equal(cmd("python tools/weather.py"), "weather", "a path and an extension are not the name");
  assert.equal(cmd(""), "", "nothing typed, nothing derived");

  const url = (commandLine: string): string => deriveName({ ...blankDraft(), type: "http", commandLine });
  assert.equal(url("https://mcp.linear.app/mcp"), "linear", "an mcp. subdomain and the public suffix are noise");
  assert.equal(url("https://example.com/mcp"), "example");
  assert.equal(url("not a url"), "", "unparseable gets no guess");
});

test("a derived name is what actually reaches the validator, so nothing is typed twice", () => {
  const draft: WizardDraft = { ...blankDraft(), commandLine: "npx -y @modelcontextprotocol/server-github" };
  const parsed = parseAddSpec(argvFromDraft(draft));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.ok && parsed.spec.name, "github");
});

test("editing keeps the server's OWN name — a derived one must never rename it", () => {
  const draft: WizardDraft = { ...blankDraft(), name: "my-github", commandLine: "npx -y @modelcontextprotocol/server-github" };
  const parsed = parseAddSpec(argvFromDraft(draft));
  assert.equal(parsed.ok && parsed.spec.name, "my-github");
});

// ── argvFromDraft / round-trip through the ONE validator ────────────────────

test("a stdio draft turns into the same argv typed add would produce, and parses", () => {
  const draft: WizardDraft = { type: "stdio", name: "github", commandLine: "npx -y @modelcontextprotocol/server-github", env: "GITHUB_TOKEN=ghp_x", headers: "", scope: "project" };
  const argv = argvFromDraft(draft);
  const parsed = parseAddSpec(argv);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.spec.config, {
    type: "stdio",
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "ghp_x" },
  });
  assert.equal(parsed.spec.scope, "project");
});

test("an http draft carries --global and parses to an http config", () => {
  const draft: WizardDraft = { type: "http", name: "remote", commandLine: "https://x.dev/mcp", env: "", headers: "", scope: "global" };
  const parsed = parseAddSpec(argvFromDraft(draft));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.spec.config, { type: "http", name: "remote", url: "https://x.dev/mcp" });
  assert.equal(parsed.spec.scope, "global");
});

test("an http draft's headers survive the round trip, including a value with its own spaces", () => {
  const draft: WizardDraft = {
    type: "http",
    name: "remote",
    commandLine: "https://x.dev/mcp",
    env: "",
    headers: "Authorization: Bearer abc 123, X-Api-Key: xyz",
    scope: "project",
  };
  const parsed = parseAddSpec(argvFromDraft(draft));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.spec.config.type === "http" ? parsed.spec.config.headers : null,
    { Authorization: "Bearer abc 123", "X-Api-Key": "xyz" },
    "comma-separated, not space-separated — a header's value routinely contains spaces",
  );
});

test("multiple env pairs and a multi-word command line both survive the round trip", () => {
  const draft: WizardDraft = {
    type: "stdio",
    name: "pg",
    commandLine: "npx pg-server --readonly",
    env: "PGHOST=localhost PGPASS=a=b=c",
    headers: "",
    scope: "project",
  };
  const parsed = parseAddSpec(argvFromDraft(draft));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.spec.config.type === "stdio" ? parsed.spec.config.args : null, ["pg-server", "--readonly"]);
  assert.deepEqual(parsed.spec.config.type === "stdio" ? parsed.spec.config.env : null, { PGHOST: "localhost", PGPASS: "a=b=c" }, "split on the FIRST = only");
});

test("a bad draft is refused by the same validator typed add uses, not silently accepted", () => {
  const draft: WizardDraft = { type: "http", name: "x", commandLine: "not-a-url", env: "", headers: "", scope: "project" };
  assert.equal(parseAddSpec(argvFromDraft(draft)).ok, false);
});

// ── draftFromConfig — Edit's starting point ─────────────────────────────────

test("editing a stdio server pre-fills command, args and env as one line each", () => {
  const draft = draftFromConfig(
    { type: "stdio", name: "github", command: "npx", args: ["-y", "@x/server-github"], env: { TOKEN: "abc" } },
    "project",
  );
  assert.equal(draft.type, "stdio");
  assert.equal(draft.name, "github");
  assert.equal(draft.commandLine, "npx -y @x/server-github");
  assert.equal(draft.env, "TOKEN=abc");
});

test("editing an http server pre-fills the URL and its headers, and carries no env", () => {
  const draft = draftFromConfig({ type: "http", name: "remote", url: "https://x.dev/mcp", headers: { Authorization: "Bearer abc" } }, "global");
  assert.equal(draft.type, "http");
  assert.equal(draft.commandLine, "https://x.dev/mcp");
  assert.equal(draft.headers, "Authorization: Bearer abc");
  assert.equal(draft.env, "");
  assert.equal(draft.scope, "global");
});

test("a fresh draft is a blank stdio form scoped to this project", () => {
  assert.deepEqual(blankDraft(), { type: "stdio", name: "", commandLine: "", env: "", headers: "", scope: "project" });
});

// ── actionsFor — what the manage screen offers ──────────────────────────────

test("a connected, healthy server offers Disable but not Reconnect", () => {
  const acts = actionsFor(status({ state: "connected" }), 0);
  assert.ok(acts.includes("Disable"));
  assert.ok(!acts.includes("Enable"));
  assert.ok(!acts.includes("Reconnect"), "reconnecting something already connected is not a real action");
});

test("a disabled server offers Enable, not Disable", () => {
  const acts = actionsFor(status({ state: "disabled" }), 0);
  assert.ok(acts.includes("Enable"));
  assert.ok(!acts.includes("Disable"));
});

test("a failed or needs-auth server offers Reconnect", () => {
  assert.ok(actionsFor(status({ state: "failed" }), 0).includes("Reconnect"));
  assert.ok(actionsFor(status({ state: "needs-auth" }), 0).includes("Reconnect"));
});

test("blocked tools add a Review row, and it leads — the state the user must act on", () => {
  const acts = actionsFor(status({ state: "connected" }), 2);
  assert.equal(acts[0], "Review blocked tools");
});

test("Edit, Remove and Back are always offered, whatever the state", () => {
  for (const state of ["connected", "disabled", "failed", "needs-auth", "pending"] as const) {
    const acts = actionsFor(status({ state }), 0);
    assert.ok(acts.includes("Edit (command, URL, env)"), `${state}: Edit missing`);
    assert.ok(acts.includes("Remove"), `${state}: Remove missing`);
    assert.ok(acts.includes("Back"), `${state}: Back missing`);
  }
});

// ── serverDetail — the list row's dim column ────────────────────────────────

test("the list row states facts, never a call-to-action verb — Enter always opens manage now", () => {
  const text = serverDetail(status({ state: "connected", toolCount: 4, version: "2026-07-28" }), 0);
  assert.match(text, /connected · 4 tools/);
  assert.match(text, /2026-07-28/);
  assert.doesNotMatch(text, /Enter to/i, "a stale action verb from the old flat list");
});

test("prompts and resources are named when the server actually offers them", () => {
  const text = serverDetail(status({ toolCount: 1, promptCount: 2, offersResources: true }), 0);
  assert.match(text, /1 tool, 2 prompts, resources/);
});

test("a blocked count outranks the connection state entirely", () => {
  assert.equal(serverDetail(status({ state: "connected" }), 3), "3 tools blocked");
});

test("disabled, pending and failed states read plainly", () => {
  assert.equal(serverDetail(status({ state: "disabled" }), 0), "disabled");
  assert.equal(serverDetail(status({ state: "pending" }), 0), "connecting…");
  assert.equal(serverDetail(status({ state: "failed", error: "ENOTFOUND" }), 0), "error · ENOTFOUND");
});

// ── the list screen, rendered ────────────────────────────────────────────────

function noop() {}

test("the list leads with '+ Add a server', then every server and its state", () => {
  const servers = [status({ name: "filesystem-mcp", state: "connected", toolCount: 6 }), status({ name: "github", state: "disabled" })];
  const out = frame(
    <McpMinitabs
      servers={servers}
      blockedCountFor={() => 0}
      configFor={() => undefined}
      onSubmit={noop}
      onSetDisabled={noop}
      onRemove={noop}
      onReconnect={noop}
      onReviewBlocked={noop}
      width={64}
      onClose={noop}
      active={false}
    />,
  );
  assert.match(out, /MCP servers/);
  assert.match(out, /\+ Add a server/);
  const addAt = out.indexOf("+ Add a server");
  const fsAt = out.indexOf("filesystem-mcp");
  assert.ok(addAt >= 0 && addAt < fsAt, "'+ Add a server' is not the first row");
  assert.match(out, /connected · 6 tools/);
  assert.match(out, /disabled/);
});

test("it is a bordered panel, not a takeover of the screen — same weight as /key", () => {
  const out = frame(
    <McpMinitabs
      servers={[status()]}
      blockedCountFor={() => 0}
      configFor={() => undefined}
      onSubmit={noop}
      onSetDisabled={noop}
      onRemove={noop}
      onReconnect={noop}
      onReviewBlocked={noop}
      width={64}
      onClose={noop}
      active={false}
    />,
  );
  assert.match(out, /[┌│└]/, "no panel border — this is rendering as a full screen");
  assert.match(out, /←\/→ tab · ↑\/↓ move · Enter select · Esc closes/);
});

test("both tabs are always shown, both bracketed — the active one just reads brighter", () => {
  const out = frame(
    <McpMinitabs
      servers={[status()]}
      blockedCountFor={() => 0}
      configFor={() => undefined}
      onSubmit={noop}
      onSetDisabled={noop}
      onRemove={noop}
      onReconnect={noop}
      onReviewBlocked={noop}
      width={64}
      onClose={noop}
      active={false}
    />,
  );
  // Both tabs keep their brackets — no filled background — the active one is bold/white
  // in a real terminal, but with FORCE_COLOR off here the bracket text itself is what
  // this test can check for.
  const titleRow = out.split(/\r?\n/).find((l) => l.includes("MCP servers"))!;
  assert.match(titleRow, /\[1\]/, "tab 1 is not shown");
  assert.match(titleRow, /\[2\]/, "tab 2 is not shown — 'why is there only one tab' regression");
});

test("an empty config is still a place to add one, not a dead end", () => {
  const out = frame(
    <McpMinitabs
      servers={[]}
      blockedCountFor={() => 0}
      configFor={() => undefined}
      onSubmit={noop}
      onSetDisabled={noop}
      onRemove={noop}
      onReconnect={noop}
      onReviewBlocked={noop}
      width={64}
      onClose={noop}
      active={false}
    />,
  );
  assert.match(out, /\+ Add a server/);
});

test("signing out is not a one-way door — Sign in comes back for a connected server", () => {
  // The dead end this closes: Sign in was offered only for `needs-auth`, but signing out
  // deliberately leaves the connection running (the token is not refused until the next
  // call). So the server sat there connected, with no credential and no way to get one.
  const connected = status({ name: "linear", type: "http", state: "connected", toolCount: 36 });

  const held = actionsFor(connected, 0, true);
  assert.ok(held.includes("Sign out"), "a held credential can be dropped");
  assert.ok(!held.some((a) => a.startsWith("Sign in")), "and is not also offered a sign-in");

  const dropped = actionsFor(connected, 0, false);
  assert.ok(dropped.some((a) => a.startsWith("Sign in")), "with no credential there must be a way back in");
  assert.ok(!dropped.includes("Sign out"), "nothing to sign out of");
});

test("a local command server is never offered a sign-in, whatever its state", () => {
  // There is no authorization server to send anyone to.
  for (const state of ["connected", "needs-auth", "failed"] as const) {
    const local = status({ name: "fs", type: "stdio", state });
    assert.ok(!actionsFor(local, 0, false).some((a) => a.startsWith("Sign in")), `stdio/${state} offered a sign-in`);
  }
});
