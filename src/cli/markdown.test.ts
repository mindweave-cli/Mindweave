/**
 * markdown.test.ts — the terminal markdown renderer.
 *
 * ANSI styling is terminal-dependent, so we assert on the ANSI-stripped content:
 * markup markers are gone, entities are decoded, lists/headings/code render as
 * readable text. (Whether a span is bold/cyan is a visual detail we don't pin.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { renderMarkdown, normalizeBlocks } from "./markdown.js";

const ESC = String.fromCharCode(27);
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

test("inline bold/italic/code render without their literal markers", () => {
  assert.equal(strip(renderMarkdown("**bold** and *em* and `code`")), "bold and em and code");
});

test("HTML entities are decoded back to characters", () => {
  assert.equal(strip(renderMarkdown(`a & b's "c" < d`)), `a & b's "c" < d`);
});

test("ordered and unordered lists render with numbers / bullets", () => {
  const ordered = strip(renderMarkdown("1. one\n2. two"));
  assert.match(ordered, /1\. one/);
  assert.match(ordered, /2\. two/);
  assert.match(strip(renderMarkdown("- a\n- b")), /• a/);
});

test("headings drop the # and code fences drop the backticks", () => {
  const heading = strip(renderMarkdown("# Title"));
  assert.match(heading, /Title/);
  assert.doesNotMatch(heading, /#/);
  const code = strip(renderMarkdown("```\nx = 1\n```"));
  assert.doesNotMatch(code, /```/);
  assert.match(code, /x = 1/);
});

test("a link shows its text and url", () => {
  const out = strip(renderMarkdown("[the docs](https://mindweave.dev)"));
  assert.match(out, /the docs/);
  assert.match(out, /https:\/\/mindweave\.dev/);
});

test("plain text passes through unchanged", () => {
  assert.equal(strip(renderMarkdown("just a sentence.")), "just a sentence.");
});

test("a wide table is wrapped to fit the width — no line overflows", () => {
  const md = [
    "| Page | File | Key features |",
    "| --- | --- | --- |",
    "| Book Detail | book-detail.html | Dynamic single-book view via ?book= query param, reserve button with 3s visual feedback, Not Found fallback, and a related books section |",
    "| Home | home.html | Hero banner, book-type cards, author grid, community features, visit info |",
  ].join("\n");
  const width = 60;
  const lines = strip(renderMarkdown(md, width)).split("\n");
  for (const line of lines) {
    assert.ok(line.length <= width, `line exceeds width ${width} (${line.length}): ${JSON.stringify(line)}`);
  }
  // The content is still all there, just wrapped across lines (drop the box
  // borders and collapse whitespace to check the words survived the wrap).
  const flat = strip(renderMarkdown(md, width)).replace(/[│─┼├┤]/g, " ").replace(/\s+/g, " ");
  assert.match(flat, /Key features/);
  assert.match(flat, /related books section/);
  assert.match(flat, /book-detail\.html/);
});

test("a narrow table still fits and stays a grid", () => {
  const md = "| A | B |\n| --- | --- |\n| one two three four five | six |";
  const width = 24;
  for (const line of strip(renderMarkdown(md, width)).split("\n")) {
    assert.ok(line.length <= width, `overflow: ${line.length} > ${width}`);
  }
});

test("a table is a closed box — every row bounded, header ruled off", () => {
  // This reverses an earlier decision. The borderless version was airier read on
  // its own and worse in a transcript: with only a thin gutter, a wrapped cell was
  // hard to tell from the row beneath it and the block stopped reading as one unit
  // of structured data. The box is what makes a table scannable AS a table, which
  // is the only reason to choose one over prose.
  const md = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |";
  const lines = strip(renderMarkdown(md, 40)).split("\n").filter((l) => l.trim());
  for (const line of lines) {
    assert.match(line, /^[┌├└│]/, `row not bounded on the left: ${JSON.stringify(line)}`);
    assert.match(line, /[┐┤┘│]$/, `row not bounded on the right: ${JSON.stringify(line)}`);
  }
  // The header is ruled off from the body, and the box is closed top and bottom.
  assert.equal(lines.filter((l) => l.startsWith("├")).length, 1, "expected one rule under the header");
  assert.ok(lines[0]!.startsWith("┌") && lines[lines.length - 1]!.startsWith("└"), "the box must close");
});

// ── Block spacing (normalizeBlocks) ───────────────────────────────────────────
// The reply in the screenshot that prompted this: every block hugging the next, and
// a summary sentence swallowed by the bullet above it.

test("a sentence written under the last bullet is a PARAGRAPH, not part of that bullet", () => {
  // The parse fault, not just a spacing one. CommonMark lazy continuation absorbs the
  // line into the item, so it rendered at the left margin under the bullet as if the
  // renderer had lost its indentation.
  const md = [
    "- `books.html` — catalog grid",
    "- `astra.html` — a bonus page",
    "So the cart loop is already closed.",
  ].join("\n");
  const tokens = marked.lexer(normalizeBlocks(md));
  const kinds = tokens.filter((t) => t.type !== "space").map((t) => t.type);
  assert.deepEqual(kinds, ["list", "paragraph"], "the sentence must stand on its own");
});

test("a list introduced by a sentence gets a blank line above it", () => {
  const md = "What exists today:\n- home.html\n- books.html";
  assert.match(normalizeBlocks(md), /What exists today:\n\n- home\.html/);
});

test("a bold section label gets air above it", () => {
  // Models write these as headings without using heading syntax.
  const md = "Here is my read on where things stand.\n**What exists (all static):**";
  assert.match(normalizeBlocks(md), /stand\.\n\n\*\*What exists/);
});

test("nested and sibling bullets are NOT separated from each other", () => {
  const md = "- one\n  - nested\n- two";
  assert.equal(normalizeBlocks(md), md, "a list is one block; blanks inside it would split it");
});

test("an indented continuation stays attached to its bullet", () => {
  const md = "- one\n  more about one";
  assert.equal(normalizeBlocks(md), md);
});

test("content inside a fenced code block is never touched", () => {
  // A fence can contain anything, including lines that look like bullets or headings.
  const md = ["```bash", "- not a bullet", "# not a heading", "```"].join("\n");
  assert.match(normalizeBlocks(md), /```bash\n- not a bullet\n# not a heading\n```/);
});

test("a fence gets air on both sides", () => {
  const md = "Run this:\n```bash\nnpm test\n```\nThen check the output.";
  const n = normalizeBlocks(md);
  assert.match(n, /Run this:\n\n```bash/);
  assert.match(n, /```\n\nThen check/);
});

test("a table is separated from the prose either side of it", () => {
  const md = "The results:\n| a | b |\n| - | - |\n| 1 | 2 |\nThat is all of them.";
  const n = normalizeBlocks(md);
  assert.match(n, /The results:\n\n\| a \| b \|/);
  assert.match(n, /\| 1 \| 2 \|\n\nThat is all/);
});

test("text that is already spaced is left exactly as it was", () => {
  const md = "A paragraph.\n\n- one\n- two\n\nAnother paragraph.";
  assert.equal(normalizeBlocks(md), md, "it must be idempotent, or repeated renders drift");
});

test("the real reply from the screenshot renders with its blocks separated", () => {
  const md = [
    "Good picture now. Here's my read on where things stand.",
    "**What exists (all static, already styled):**",
    "- `home.html` — landing",
    "- `astra.html` — a bonus page",
    "So the cart loop is already closed.",
    "**What is probably still missing:**",
    "- Wishlist / favorites",
  ].join("\n");
  const rendered = renderMarkdown(md, 80);
  const paragraphs = rendered.split("\n\n");
  assert.ok(paragraphs.length >= 5, `expected the blocks to be separated, got ${paragraphs.length} run(s)`);
  assert.ok(
    !/a bonus page\nSo the cart/.test(rendered),
    "the summary sentence must not still be hanging off the last bullet",
  );
});

// ── the wall ─────────────────────────────────────────────────────────────────

/**
 * The exact shape from the bug report: a summary written as consecutive
 * `**Term** — description` lines with no blank lines between them. CommonMark reads
 * those as ONE paragraph, so the renderer emitted a nine-line block of prose with
 * bold scattered through it and no way in for the eye.
 */
const WALL = [
  "The feature ideas are organized by category. Here's what's in there:",
  "**Smart Organization & Linking** — auto-linking, and extending the quick switcher.",
  "**Writing Environment** — typewriter scrolling, scene cards, and version history.",
  "**Interface** — Sepia theme, ambient soundscapes.",
  "**AI** — local grammar checker, idea generator, summarizer.",
  "**Export** — Markdown, HTML, PDF, DOCX.",
  "The checklist at the bottom shows what's already done.",
].join("\n");

test("a run of bold definition lines becomes separate blocks, not one wall", () => {
  const out = strip(renderMarkdown(WALL, 100));
  const terms = ["Smart Organization", "Writing Environment", "Interface", "AI —", "Export"];
  for (const term of terms) {
    const line = out.split("\n").find((l) => l.includes(term.replace(" —", "")));
    assert.ok(line, `lost the term entirely: ${term}`);
  }
  // THE assertion: every definition is separated from the next by a blank line.
  const rows = out.split("\n");
  const defnRows = rows.map((r, i) => (/^(Smart|Writing|Interface|AI|Export)/.test(r) ? i : -1)).filter((i) => i >= 0);
  assert.equal(defnRows.length, 5, `expected five definition lines, got ${defnRows.length}:\n${out}`);
  for (let i = 1; i < defnRows.length; i++) {
    assert.ok(defnRows[i]! - defnRows[i - 1]! >= 2, `two definitions landed adjacent:\n${out}`);
  }
});

test("the sentences around the run stay separate from it", () => {
  const rows = strip(renderMarkdown(WALL, 100)).split("\n");
  const intro = rows.findIndex((r) => r.startsWith("The feature ideas"));
  const first = rows.findIndex((r) => r.startsWith("Smart Organization"));
  const outro = rows.findIndex((r) => r.startsWith("The checklist"));
  assert.ok(first - intro >= 2, "the intro sentence hugged the first definition");
  assert.ok(outro - rows.findIndex((r) => r.startsWith("Export")) >= 2, "the closing sentence hugged the list");
});

test("a sentence that merely OPENS with bold is not broken up", () => {
  // The distinction that keeps this safe: a definition has a separator after the
  // bold term. Ordinary emphasis mid-sentence must stay in its paragraph.
  const md = "**The trick** that keeps it specific is simple.\nWe wrap it and it explains itself.";
  const out = strip(renderMarkdown(md, 100));
  assert.ok(!out.includes("\n\n"), `an ordinary sentence was split apart:\n${out}`);
});

// ── tables ───────────────────────────────────────────────────────────────────

const TABLE = ["| Status | Meaning |", "| --- | --- |", "| 401 | key rejected |", "| 429 | rate limited |"].join("\n");

test("a table is drawn as a box", () => {
  const out = strip(renderMarkdown(TABLE, 80));
  assert.match(out, /┌.*┬.*┐/, "no top border");
  assert.match(out, /└.*┴.*┘/, "no bottom border");
  assert.match(out, /│ Status/, "no cell borders");
  assert.match(out, /401/);
});

test("no row of a table ever exceeds the width it was given", () => {
  for (const width of [40, 60, 80, 120]) {
    for (const row of strip(renderMarkdown(TABLE, width)).split("\n")) {
      assert.ok(row.length <= width, `row of ${row.length} exceeded width ${width}: ${row}`);
    }
  }
});

test("a table too wide to draw falls back to labelled stacks, not shredded columns", () => {
  const wide = [
    "| File | What changed |",
    "| --- | --- |",
    "| src/cli/markdown.ts | the definition-line detection that fixes the wall of text |",
  ].join("\n");
  const out = strip(renderMarkdown(wide, 30));
  assert.ok(!out.includes("┌"), `forced a box into 30 columns:\n${out}`);
  assert.match(out, /File:/, "the fallback labels each value");
  assert.match(out, /markdown\.ts/, "no value may be lost");
  for (const row of out.split("\n")) assert.ok(row.length <= 30, `fallback overflowed: ${row}`);
});

test("a column never shrinks below something readable", () => {
  const many = ["| a | b | c | d | e |", "| --- | --- | --- | --- | --- |", "| 1 | 2 | 3 | 4 | 5 |"].join("\n");
  const out = strip(renderMarkdown(many, 24));
  // Either it fits honestly or it goes vertical — what it must never do is render
  // one-character columns that happen to still be a box.
  if (out.includes("┌")) {
    const header = out.split("\n").find((l) => l.includes("│ a"))!;
    assert.ok(header.length <= 24, "kept the box by overflowing instead");
  }
  assert.match(out, /[1-5]/, "the values survived either way");
});
