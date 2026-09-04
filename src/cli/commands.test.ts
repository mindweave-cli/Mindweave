/**
 * commands.test.ts — every advertised command actually reaches its branch.
 *
 * The failure this guards is specific and has happened: a command that is listed in
 * `/help`, offered by the autocomplete, and fully implemented, but which the router
 * never recognises — so typing it answers "unknown command" while everything about the
 * feature works. Nothing about that is visible when reading either file, because each
 * one is correct on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_COMMANDS } from "./commands.js";
import { routeCommand } from "./commandRoute.js";

const catalog = { builtins: BASE_COMMANDS.map((c) => c.name), skills: [] };

test("every advertised command routes to a builtin", () => {
  for (const command of BASE_COMMANDS) {
    const route = routeCommand(command.name, catalog);
    assert.equal(route.kind === "mcp-config" ? "builtin" : route.kind, "builtin", `${command.name} does not route`);
  }
});

test("/update is one of them", () => {
  // Named on its own as well as covered by the sweep above: this is the command that
  // ends the process and starts another, so "it is reachable" is worth stating rather
  // than inferring from a loop.
  assert.ok(BASE_COMMANDS.some((c) => c.name === "/update"));
  assert.equal(routeCommand("/update", catalog).kind, "builtin");
});

test("every command has a description worth printing", () => {
  // `/help` renders these verbatim. A blank one leaves a naked command name in a column
  // of explanations.
  for (const command of BASE_COMMANDS) {
    assert.ok(command.description.trim().length > 0, `${command.name} has no description`);
    assert.ok(!command.description.endsWith("."), `${command.name}'s description ends in a full stop`);
  }
});

test("the list has no duplicates", () => {
  const names = BASE_COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "a command is listed twice");
});

test("every name is a lowercase slash command", () => {
  // `routeCommand` lowercases what the user typed before matching, so an entry with a
  // capital in it could never be matched by anything.
  for (const { name } of BASE_COMMANDS) {
    assert.match(name, /^\/[a-z][a-z-]*$/, `${name} cannot be matched as typed`);
  }
});

test("a command that is not on the list does NOT route as a builtin", () => {
  // The other half: the sweep above would pass just as well if everything routed.
  assert.notEqual(routeCommand("/definitelynotacommand", catalog).kind, "builtin");
});
