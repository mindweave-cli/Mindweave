/**
 * dropHandles.test.ts — a dropped path becomes a short handle, and comes back whole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDropHandles, expandHandles } from "./dropHandles.js";
import { findDroppedPaths } from "./attachments.js";

const WIN = "C:\\Users\\dev\\Pictures\\Screenshots\\Screenshot 2026-09-06 091037.png";
const identity = (p: string) => p;

test("a dropped image path becomes mwimg1", () => {
  const h = createDropHandles(identity);
  assert.equal(h.register(`look at "${WIN}"`), "look at mwimg1");
});

test("a dropped non-image becomes mwfile1, numbered apart from the images", () => {
  const h = createDropHandles(identity);
  assert.equal(h.register('read "C:\\src\\notes.txt"'), "read mwfile1");
  assert.equal(h.register(`and "${WIN}"`), "and mwimg1");
  assert.equal(h.register('and "C:\\src\\other.txt"'), "and mwfile2");
});

test("the same file dropped twice keeps one handle", () => {
  const h = createDropHandles(identity);
  assert.equal(h.register(`a "${WIN}"`), "a mwimg1");
  assert.equal(h.register(`b "${WIN}"`), "b mwimg1");
});

test("two paths in one drop both get handles, and the text around them survives", () => {
  const h = createDropHandles(identity);
  const out = h.register('compare "C:\\a\\one.txt" with "C:\\b\\two.txt" please');
  assert.equal(out, "compare mwfile1 with mwfile2 please");
});

test("expanding puts the real path back, quoted so spaces survive", () => {
  const h = createDropHandles(identity);
  const typed = h.register(`describe "${WIN}"`);
  assert.equal(expandHandles(typed, h), `describe "${WIN}"`);
});

test("text typed around a handle is preserved through the round trip", () => {
  const h = createDropHandles(identity);
  const typed = h.register(`"${WIN}"`);
  const edited = `what is in ${typed} exactly?`;
  assert.equal(expandHandles(edited, h), `what is in "${WIN}" exactly?`);
});

test("a bare unquoted path is handled too", () => {
  const h = createDropHandles(identity);
  assert.equal(h.register("see /home/me/notes.md now"), "see mwfile1 now");
});

test("ordinary quoted prose is NOT a file drop", () => {
  // QUOTED_RE alone matches any quoted run; requiring an absolute root is what keeps
  // a sentence from being turned into an attachment.
  const h = createDropHandles(identity);
  const text = 'he said "hello world" and left';
  assert.equal(findDroppedPaths(text).length, 0);
  assert.equal(h.register(text), text);
});

test("text with no path at all comes back identical", () => {
  const h = createDropHandles(identity);
  const text = "just a normal sentence about C drive and / slashes";
  assert.equal(h.register(text), text);
});

test("an unknown handle is left alone rather than blanked", () => {
  // A handle from a previous session (a resumed transcript, a retyped word) has no path
  // behind it. Leaving the text as written is the only safe answer.
  const h = createDropHandles(identity);
  assert.equal(expandHandles("check mwimg7 please", h), "check mwimg7 please");
});

test("a word that merely starts like a handle is not one", () => {
  const h = createDropHandles(identity);
  assert.equal(expandHandles("mwimgless mwfiles mwimg", h), "mwimgless mwfiles mwimg");
});

test("labelFor answers with the handle, for the chat's benefit", () => {
  const h = createDropHandles(identity);
  h.register(`"${WIN}"`);
  assert.equal(h.labelFor(WIN), "mwimg1");
  assert.equal(h.labelFor("C:\\nothing\\here.png"), undefined);
});

test("the resolver decides identity, so two spellings of one file share a handle", () => {
  const h = createDropHandles((p) => p.toLowerCase());
  assert.equal(h.register('"C:\\A\\File.TXT"'), "mwfile1");
  assert.equal(h.register('"C:\\a\\file.txt"'), "mwfile1");
});

test("a pasted slash command is a command, not a dropped file", () => {
  // `/mcp` satisfies the POSIX half of the bare-path pattern, so pasting a command used
  // to turn its first word into a file handle. That expanded back to a quoted absolute
  // path at send time, the line no longer began with `/`, and the command was delivered
  // to the model as a sentence — which answered helpfully instead of running it.
  for (const line of ["/mcp add --http linear https://mcp.linear.app/mcp", "/key", "/model deepseek", "/undo"]) {
    assert.deepEqual(findDroppedPaths(line), [], `'${line}' should not look like a drop`);
  }
});

test("a real path pasted at the start of a line is still a drop", () => {
  // The rule is the SECOND slash: a path has one, a command does not. Losing this would
  // trade one bug for another.
  assert.equal(findDroppedPaths("/Users/me/notes.txt explain this").length, 1);
  assert.equal(findDroppedPaths("/home/me/a.txt").length, 1);
  // And a command-shaped word anywhere BUT the start is untouched, because a line that
  // begins with something else is not a command line at all.
  assert.equal(findDroppedPaths("look at /tmp").length, 1);
});
