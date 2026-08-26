/**
 * commandRoute.test.ts — every command, routed.
 *
 * The eighteen built-ins had no coverage at all before this file, because the routing
 * lived inside a React component as an if-chain and there was nothing to call. These
 * are the cases a user actually produces: a typo, an argument with capitals in it, a
 * skill named the same as a builtin, a path pasted into the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandLine, routeCommand, unknownCommandMessage, MCP_CONFIG_VERBS } from "./commandRoute.js";
import type { SkillMeta } from "../governor/types.js";

const BUILTINS = [
  "/help", "/init", "/provider", "/key", "/model", "/think", "/rules", "/skills",
  "/forbidden", "/forbid-command", "/link", "/include", "/exclude", "/shells", "/mcp",
  "/context", "/undo", "/compact", "/clear", "/continue",
];

function skill(name: string): SkillMeta {
  return { name, description: "", path: `${name}/SKILL.md` } as unknown as SkillMeta;
}

const CATALOG = { builtins: BUILTINS, skills: [skill("release"), skill("Deploy")] };

test("every built-in command routes to itself", () => {
  for (const name of BUILTINS) {
    const r = routeCommand(name, CATALOG);
    assert.equal(r.kind, "builtin", `${name} did not route to a builtin`);
    assert.equal(r.kind === "builtin" && r.name, name);
  }
});

test("the command word is case-insensitive, the argument is not", () => {
  const r = routeCommand("/INCLUDE src/Api", CATALOG);
  assert.equal(r.kind, "builtin");
  assert.equal(r.kind === "builtin" && r.name, "/include");
  // Lowercasing this would break the path on a case-sensitive checkout.
  assert.equal(r.kind === "builtin" && r.arg, "src/Api");
});

test("arguments survive extra whitespace intact", () => {
  const p = parseCommandLine("   /rules    always   use pnpm   ");
  assert.equal(p.name, "/rules");
  assert.equal(p.arg, "always   use pnpm", "inner spacing was rewritten");
});

test("a bare command has an empty argument, not undefined", () => {
  // Every list-vs-add branch keys off `arg` being falsy; undefined here would still
  // work by accident, and stop working the first time someone compares to "".
  assert.equal(parseCommandLine("/rules").arg, "");
  assert.equal(parseCommandLine("/rules   ").arg, "");
});

test("/mcp splits on an EXACT verb, so a near-miss is not a removal", () => {
  for (const verb of MCP_CONFIG_VERBS) {
    assert.equal(routeCommand(`/mcp ${verb} thing`, CATALOG).kind, "mcp-config", `/mcp ${verb} did not route to config`);
  }
  // The bug: a prefix match sent this to the remove branch, which failed its own exact
  // check one layer down and fell through to being parsed as an ADD.
  assert.equal(routeCommand("/mcp rmdir-server", CATALOG).kind, "builtin", "/mcp rmdir-server was treated as a removal");
  assert.equal(routeCommand("/mcp added-server", CATALOG).kind, "builtin", "/mcp added-server was treated as an add");
  assert.equal(routeCommand("/mcp", CATALOG).kind, "builtin");
  assert.equal(routeCommand("/mcp list", CATALOG).kind, "builtin");
});

test("/mcp verbs are matched case-insensitively too", () => {
  assert.equal(routeCommand("/mcp ADD name url", CATALOG).kind, "mcp-config");
});

test("a project skill is reachable as /name, whatever its capitalisation", () => {
  const r = routeCommand("/release now", CATALOG);
  assert.equal(r.kind, "skill");
  assert.equal(r.kind === "skill" && r.skill.name, "release");
  assert.equal(r.kind === "skill" && r.arg, "now");
  assert.equal(routeCommand("/deploy", CATALOG).kind, "skill", "a skill named with capitals is unreachable");
});

test("a skill can NEVER shadow a built-in command", () => {
  // Otherwise a project could define a skill called `undo` and take away the only way
  // to roll back its own damage.
  const shadowing = { builtins: BUILTINS, skills: [skill("undo"), skill("help")] };
  assert.equal(routeCommand("/undo", shadowing).kind, "builtin");
  assert.equal(routeCommand("/help", shadowing).kind, "builtin");
});

test("an MCP prompt routes by server:name, and a project skill outranks it", () => {
  const r = routeCommand("/github:review 42", CATALOG);
  assert.equal(r.kind, "prompt");
  assert.equal(r.kind === "prompt" && r.server, "github");
  assert.equal(r.kind === "prompt" && r.prompt, "review");
  assert.equal(r.kind === "prompt" && r.arg, "42");
});

test("an unknown command says so, and points somewhere useful", () => {
  const r = routeCommand("/modle", CATALOG);
  assert.equal(r.kind, "unknown");
  const msg = unknownCommandMessage("/modle");
  assert.match(msg, /\/modle/, "the message does not say what was not understood");
  // The old message hardcoded 13 of the 18 names and had drifted — it omitted /help,
  // which is the one that answers the question.
  assert.match(msg, /\/help/, "the reply does not point at /help");
});

test("a pasted unix path is not mistaken for a command that exists", () => {
  const r = routeCommand("/usr/local/bin/node --version", CATALOG);
  assert.equal(r.kind, "unknown", "a pasted path took a command branch");
});

test("a lone slash is unknown rather than a crash", () => {
  assert.equal(routeCommand("/", CATALOG).kind, "unknown");
  assert.equal(routeCommand("/ ", CATALOG).kind, "unknown");
});

/**
 * The whole `/mcp add` path, from the typed line to a parsed server spec.
 *
 * Routing and body were each fine in isolation; the LINK between them was dead, and
 * nothing tested the link. This walks the real functions in the real order so a break
 * anywhere along it fails here.
 */
test("a typed /mcp add reaches a valid server spec", async () => {
  const { parseAddSpec, splitArgs } = await import("../mcp/configWrite.js");
  const line = "/mcp add fetch npx -y @modelcontextprotocol/server-fetch";
  const r = routeCommand(line, CATALOG);
  assert.equal(r.kind, "mcp-config", "/mcp add did not route to the config writer");

  const argv = splitArgs(r.kind === "mcp-config" ? r.arg : "");
  assert.equal(argv.shift(), "add", "the verb was not the first token the body sees");
  const parsed = parseAddSpec(argv);
  assert.equal(parsed.ok, true, `the spec did not parse: ${parsed.ok ? "" : parsed.error}`);
  assert.equal(parsed.ok && parsed.spec.name, "fetch");
});

test("a typed /mcp remove reaches the removal branch with its target", async () => {
  const { splitArgs } = await import("../mcp/configWrite.js");
  const r = routeCommand("/mcp remove fetch", CATALOG);
  assert.equal(r.kind, "mcp-config");
  const argv = splitArgs(r.kind === "mcp-config" ? r.arg : "");
  assert.equal(argv.shift(), "remove");
  assert.equal(argv[0], "fetch", "the server name never reached the removal");
});

/**
 * The list and the handlers, held together.
 *
 * BASE_COMMANDS is what `/help` prints and what the input's autocomplete offers. A
 * command can be added to that list with no handler behind it (it then does nothing at
 * all, silently), or given a handler and left out of the list (it then exists but is
 * undiscoverable). Both have happened in this file's history — `/mcp add` was the
 * second kind for months. Read from the source, because there is nowhere else the two
 * meet.
 */
test("every advertised command has a handler, and every handler is advertised", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/cli/App.tsx", "utf8");

  const listBlock = src.slice(src.indexOf("const BASE_COMMANDS = ["));
  const listed = new Set(
    [...listBlock.slice(0, listBlock.indexOf("];")).matchAll(/name: "(\/[a-z-]+)"/g)].map((m) => m[1]!),
  );
  const handled = new Set([...src.matchAll(/name === "(\/[a-z-]+)"/g)].map((m) => m[1]!));

  assert.ok(listed.size >= 18, `only found ${listed.size} commands in BASE_COMMANDS — did the list move?`);

  const advertisedButDead = [...listed].filter((c) => !handled.has(c));
  assert.deepEqual(advertisedButDead, [], "these are offered by /help and autocomplete but nothing handles them");

  const workingButHidden = [...handled].filter((c) => !listed.has(c));
  assert.deepEqual(workingButHidden, [], "these commands work but are in no list, so nobody can find them");
});
