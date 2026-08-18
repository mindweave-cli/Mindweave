/**
 * markup.test.ts — the HTML/CSS extraction tier (cross-language string wiring).
 *
 * Uses the real tree-sitter HTML/CSS grammars (like chassis.test.ts), so it proves
 * the node-type walking against the actual parser, not a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarkup, markupSpan, isMarkupSupported } from "./markup.js";

const PAGE = [
  "<!DOCTYPE html>", // 1
  "<html><head>", // 2
  "<style>", // 3
  "  .hero-stats { color: red; }", // 4
  "  #nav .value { font-weight: 700; }", // 5
  "</style>", // 6
  "</head><body>", // 7
  '  <section id="vision">', // 8
  '    <div class="hero-stats value">hi</div>', // 9
  "  </section>", // 10
  "  <script>", // 11
  '    const n = document.getElementById("nav");', // 12
  '    document.querySelectorAll(".hero-stats").forEach(x => x.classList.add("active"));', // 13
  "  </script>", // 14
  "</body></html>", // 15
].join("\n");

test("isMarkupSupported covers html and stylesheets, not code", () => {
  assert.ok(isMarkupSupported("a.html"));
  assert.ok(isMarkupSupported("a.css"));
  assert.ok(isMarkupSupported("a.scss"));
  assert.ok(!isMarkupSupported("a.ts"));
});

test("CSS selectors (incl. embedded <style>) become definitions at their real line", async () => {
  const ex = (await extractMarkup("page.html", PAGE))!;
  const def = (name: string) => ex.defs.find((d) => d.name === name);
  // Embedded <style> starts at line 3, so the rules land on 4 and 5.
  assert.equal(def("hero-stats")?.kind, "class");
  assert.equal(def("hero-stats")?.line, 4);
  assert.equal(def("nav")?.kind, "id");
  assert.equal(def("nav")?.line, 5);
  // The HTML section id is a definition too (the element lives here).
  assert.equal(def("vision")?.kind, "id");
  assert.equal(def("vision")?.line, 8);
});

test("HTML classes and JS DOM calls become references, wiring across the languages", async () => {
  const ex = (await extractMarkup("page.html", PAGE))!;
  const refLines = (name: string) => ex.refs.filter((r) => r.name === name).map((r) => r.line).sort((a, b) => a - b);
  // class="hero-stats value" on line 9, then querySelectorAll(".hero-stats") on line 13.
  assert.deepEqual(refLines("hero-stats"), [9, 13]);
  assert.deepEqual(refLines("value"), [9]);
  // getElementById("nav") on line 12; classList.add("active") on line 13.
  assert.deepEqual(refLines("nav"), [12]);
  assert.deepEqual(refLines("active"), [13]);
});

test("a standalone stylesheet extracts every class/id selector", async () => {
  const css = ".btn { }\n.card .title { }\n#header { }";
  const ex = (await extractMarkup("styles.css", css))!;
  const kinds = new Map(ex.defs.map((d) => [d.name, d.kind]));
  assert.equal(kinds.get("btn"), "class");
  assert.equal(kinds.get("card"), "class");
  assert.equal(kinds.get("title"), "class");
  assert.equal(kinds.get("header"), "id");
  assert.equal(ex.refs.length, 0); // a stylesheet only defines
});

test("markupSpan locates a CSS rule and an HTML element by name", async () => {
  assert.deepEqual(await markupSpan("page.html", PAGE, "hero-stats"), { start: 4, end: 4 });
  // <section id="vision"> … </section> spans lines 8–10.
  assert.deepEqual(await markupSpan("page.html", PAGE, "vision"), { start: 8, end: 10 });
});

test("a local href/src becomes an import; an absolute URL or anchor does not", async () => {
  const html = '<link href="theme.css"><a href="#top">x</a><script src="https://cdn/x.js"></script>';
  const ex = (await extractMarkup("i.html", html))!;
  assert.deepEqual(ex.imports.map((i) => i.spec), ["theme.css"]);
});

test("a class touched by many rules is DEFINED once and REFERENCED after that", async () => {
  // A real stylesheet writes the same class from many rules. Storing one symbol per
  // OCCURRENCE measured 439 symbols for 128 distinct names on a 2,045-line sheet
  // (`.sepia` sixty-six times), and that one file was then 83% of the project's whole
  // symbol graph — which is what ranking ranks over and what an outline lists.
  const css = [
    ".panel { color: red; }", // 1  → definition
    ".panel.is-open { color: blue; }", // 2  → reference
    "body.sepia .panel { color: tan; }", // 3  → reference (+ sepia defined)
    "@media (width > 40em) { .panel { color: green; } }", // 4  → reference
  ].join("\n");

  const out = await extractMarkup("theme.css", css);
  assert.ok(out, "extraction failed");
  const panels = out!.defs.filter((d) => d.name === "panel");
  assert.equal(panels.length, 1, `.panel defined ${panels.length} times, expected once`);
  assert.equal(panels[0]!.line, 1, "the first rule that names it is its definition");

  // Nothing is lost: "every rule that styles this" is still answerable, as references.
  const panelRefs = out!.refs.filter((r) => r.name === "panel");
  assert.equal(panelRefs.length, 3, `expected the 3 later rules as references, got ${panelRefs.length}`);
  assert.deepEqual(panelRefs.map((r) => r.line), [2, 3, 4]);
});

test("two selectors in one rule are still two definitions", async () => {
  // Deduping is per NAME, not per rule — `.a .b { }` defines both, which is what makes
  // a compound selector navigable at all.
  const out = await extractMarkup("t.css", ".hero-stats .value { color: red; }");
  const names = (out?.defs ?? []).map((d) => d.name).sort();
  assert.deepEqual(names, ["hero-stats", "value"]);
});
