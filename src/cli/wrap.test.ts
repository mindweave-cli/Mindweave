/**
 * wrap.test.ts — the wrapper this file exists BECAUSE of a real, reproduced Ink
 * bug: `<Text wrap="wrap">` on the exact same input produced some continuation
 * lines with a stray leading space and others without (verified with a bare Ink
 * render, see wrap.ts's header comment). Every test below is really asking one
 * question of our own wrapper: does line N+1 ever start with whitespace that
 * wasn't deliberately there in the source text?
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapAnsi } from "./wrap.js";

function noLeadingSpace(lines: string[]) {
  for (const line of lines.slice(1)) {
    assert.ok(!/^\s/.test(line), `continuation line starts with whitespace: "${line}"`);
  }
}

test("a normal sentence wraps with NO continuation line ever starting with a space", () => {
  const lines = wrapAnsi("This is a normal sentence that should wrap cleanly across two or three lines without issue", 20);
  noLeadingSpace(lines);
  assert.ok(lines.length >= 4);
});

test("one long unbroken run (no spaces at all) — the user's exact repro shape", () => {
  const lines = wrapAnsi("asddddddddddsadasdasdasddddddddddsadasdasdasdasddddddddddsadasdasd", 20);
  noLeadingSpace(lines);
  assert.equal(lines.join(""), "asddddddddddsadasdasdasddddddddddsadasdasdasdasddddddddddsadasdasd", "no characters lost");
});

test("two long words separated by one space", () => {
  const lines = wrapAnsi("aaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbb", 20);
  noLeadingSpace(lines);
});

test("no line exceeds the given width", () => {
  const text = "a bb ccc dddd eeeee ffffff ggggggg hhhhhhhh iiiiiiiii jjjjjjjjjj";
  for (const w of [5, 10, 20, 40]) {
    for (const line of wrapAnsi(text, w)) assert.ok(line.length <= w, `"${line}" (${line.length}) exceeds width ${w}`);
  }
});

test("no word is split while a shorter line could still hold it whole", () => {
  const lines = wrapAnsi("cat dog bird", 20);
  assert.deepEqual(lines, ["cat dog bird"]);
});

test("existing newlines are hard breaks, not something the wrapper can merge away", () => {
  const lines = wrapAnsi("first paragraph\n\nsecond paragraph", 40);
  assert.deepEqual(lines, ["first paragraph", "", "second paragraph"]);
});

test("an empty string wraps to a single empty line, not zero lines", () => {
  assert.deepEqual(wrapAnsi("", 20), [""]);
});

// ── ANSI awareness — chalk's escape codes must not count toward width ──────────

test("a chalk-bold word's width is measured on the visible text, not the escape bytes", () => {
  const bold = "\x1b[1mHello\x1b[22m"; // visually 5 columns, byte length far more
  const lines = wrapAnsi(`${bold} world`, 20);
  assert.deepEqual(lines, [`${bold} world`], "fits on one line — the codes must not have inflated the measured width");
});

test("a styled word survives wrapping with its escape codes intact", () => {
  const bold = "\x1b[1mHello\x1b[22m";
  const lines = wrapAnsi(`${bold} there, this text is long enough to wrap onto a second line`, 20);
  assert.ok(lines[0]!.includes(bold), "the styled word must not be split or have its codes stripped");
});

test("a single word too wide for the line still breaks rather than overflowing", () => {
  const lines = wrapAnsi("x".repeat(50), 10);
  assert.equal(lines.length, 5);
  for (const line of lines) assert.equal(line.length, 10);
});

// ── Hanging indent on list items ──────────────────────────────────────────────
// The one place a continuation line SHOULD start with whitespace. Without it the
// second row of an item begins in the bullet's own column and reads as a new item.

test("a wrapped list item hangs its continuation under the item's text", () => {
  const lines = wrapAnsi("• Font picker: let users choose serif or sans-serif and a size", 30);
  assert.ok(lines.length > 1, "the input must actually wrap for this test to mean anything");
  assert.ok(!/^\s/.test(lines[0]!), "the first row starts at the margin");
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {2}\S/, `continuation should hang by the marker width: "${line}"`);
  }
});

test("an ordered item hangs by its own marker width", () => {
  const lines = wrapAnsi("12. Snapshot documents on save and let the user browse old versions", 30);
  assert.ok(lines.length > 1);
  for (const line of lines.slice(1)) assert.match(line, /^ {4}\S/, `"${line}"`);
});

test("hanging indent never pushes a row past the width", () => {
  const item = "• " + "word ".repeat(40).trim();
  for (const w of [12, 20, 40, 80]) {
    for (const line of wrapAnsi(item, w)) assert.ok(line.length <= w, `"${line}" (${line.length}) exceeds ${w}`);
  }
});

test("a diff removal line is NOT treated as a list item", () => {
  // `-` starts a markdown bullet, but by the time text reaches the wrapper our own
  // renderer has already turned bullets into `•`. A leading `-` here is a diff line.
  const lines = wrapAnsi("- const [dropTargetId, setDropTargetId] = useState<string | null>(null);", 30);
  for (const line of lines.slice(1)) assert.ok(!/^\s/.test(line), `"${line}" should not hang`);
});

test("a nested item hangs under its own text, not the outer margin", () => {
  const lines = wrapAnsi("  • Nested item whose text is long enough to wrap onto another row", 28);
  assert.ok(lines.length > 1);
  for (const line of lines.slice(1)) assert.match(line, /^ {4}\S/, `"${line}"`);
});
