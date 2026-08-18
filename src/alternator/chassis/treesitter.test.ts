/**
 * treesitter.test.ts — validates the tag queries against the real grammars.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupported, treeSitterExtract, extractDoc, treeSitterSpan } from "./treesitter.js";

test("isSupported recognizes code files, rejects others", () => {
  assert.ok(isSupported("/p/a.ts"));
  assert.ok(isSupported("/p/a.tsx"));
  assert.ok(isSupported("/p/a.py"));
  assert.equal(isSupported("/p/a.txt"), false);
});

test("extracts TypeScript definitions and references", async () => {
  const code = [
    "export function alpha() { return beta(); }",
    "class Widget { render() { alpha(); } }",
    "const gamma = () => Widget;",
    "interface Shape { area(): number; }",
    "type ID = string;",
  ].join("\n");
  const ex = await treeSitterExtract("/p/a.ts", code);
  assert.ok(ex, "extraction should succeed");
  const names = new Set(ex!.defs.map((d) => d.name));
  for (const n of ["alpha", "Widget", "render", "gamma", "Shape", "ID"]) {
    assert.ok(names.has(n), `expected definition ${n}; got ${[...names].join(",")}`);
  }
  const refs = new Set(ex!.refs.map((r) => r.name));
  assert.ok(refs.has("beta"), "expected reference beta");
  assert.ok(refs.has("alpha"), "expected reference alpha");
});

test("treeSitterSpan returns the real body of an arrow-fn const, not a re-export entry", async () => {
  // The storeon read_symbol bug: `login` is defined as an arrow-fn const AND named in a
  // `module.exports = { … }` block. A lookup that resolves to the exports line (near=6)
  // must still yield the whole body span, not the single export line.
  const code = [
    "export const login = async (req, res) => {", // 1
    "  authenticate(req);", // 2
    "  return res.json({ ok: true });", // 3
    "};", // 4
    "", // 5
    "module.exports = { login };", // 6
  ].join("\n");
  const span = await treeSitterSpan("/p/auth.ts", code, "login", 6);
  assert.ok(span, "should find a span");
  assert.equal(span!.start, 1, "span starts at the declaration");
  assert.equal(span!.end, 4, "span covers the whole body, not the 1-line export");
});

test("captures endLine and a leading doc-comment for a definition", async () => {
  const code = [
    "/** Greets a person warmly. */", // 1
    "export function greet(name) {", // 2
    "  return `hi ${name}`;", // 3
    "}", // 4
  ].join("\n");
  const ex = await treeSitterExtract("/p/a.ts", code);
  const greet = ex!.defs.find((d) => d.name === "greet")!;
  assert.equal(greet.line, 2);
  assert.equal(greet.endLine, 4, "endLine spans to the closing brace");
  assert.equal(greet.doc, "Greets a person warmly.");
});

test("extractDoc reads // comments above and Python docstrings below", () => {
  // `//` block above a definition on line 3.
  const js = ["// first line", "// second line", "function f() {}"];
  assert.equal(extractDoc(js, 3), "first line");
  // Python docstring just below the def line (line 1).
  const py = ["def f():", '    """Does the thing."""', "    return 1"];
  assert.equal(extractDoc(py, 1), "Does the thing.");
  // No doc.
  assert.equal(extractDoc(["function bare() {}"], 1), undefined);
});

test("extractDoc skips section-divider comments", () => {
  const src = ["  // ── queries ──────", "  definition(name) {}"];
  assert.equal(extractDoc(src, 2), undefined);
});

test("extracts import specifiers from import/export-from statements", async () => {
  const code = ['import { a } from "./util";', 'export { b } from "../lib/mod";', "const x = 1;"].join("\n");
  const ex = await treeSitterExtract("/p/a.ts", code);
  const specs = new Set(ex!.imports.map((i) => i.spec));
  assert.ok(specs.has("./util"), `expected ./util; got ${[...specs].join(",")}`);
  assert.ok(specs.has("../lib/mod"));
});

test("extracts Python definitions and references", async () => {
  const code = ["def foo():", "    return bar()", "", "class Animal:", "    def speak(self):", "        foo()"].join("\n");
  const ex = await treeSitterExtract("/p/a.py", code);
  assert.ok(ex, "extraction should succeed");
  const names = new Set(ex!.defs.map((d) => d.name));
  for (const n of ["foo", "Animal", "speak"]) {
    assert.ok(names.has(n), `expected definition ${n}; got ${[...names].join(",")}`);
  }
  assert.ok(new Set(ex!.refs.map((r) => r.name)).has("bar"), "expected reference bar");
});

// ── JSX landmarks ────────────────────────────────────────────────────────────────
// A declaration-only query goes silent over a component's render body, which is where
// most UI edits land: measured on a 1,381-line React component, the outline's last entry
// was L1128 and the whole render did not exist in the graph. The model had nothing to
// navigate by, guessed an offset, missed, and read the file again.

test("a JSX className becomes a navigable landmark, keyed like its CSS rule", async () => {
  const code = [
    'export function App() {', // 1
    '  return (', // 2
    '    <div className="app-shell">', // 3
    '      <div className="sidebar-header">', // 4
    '        <button className="home-btn" onClick={goHome}>Home</button>', // 5
    '      </div>', // 6
    '    </div>', // 7
    '  );', // 8
    '}', // 9
  ].join("\n");

  const ex = await treeSitterExtract("/p/App.tsx", code);
  assert.ok(ex, "extraction failed");
  const byName = new Map(ex!.defs.map((d) => [d.name, d]));

  assert.ok(byName.has("sidebar-header"), `render body not in the graph: ${ex!.defs.map((d) => d.name).join(", ")}`);
  assert.equal(byName.get("sidebar-header")!.kind, "element");
  assert.equal(byName.get("sidebar-header")!.line, 4);
  // The element's own extent, not the enclosing component: enclosingSpan climbs to the
  // nearest DECLARATION, which from inside a render body is the whole function.
  assert.equal(byName.get("sidebar-header")!.endLine, 6, "span should be the element, not the component");
});

test("a class on several elements is one definition and the rest references", async () => {
  const code = [
    'export function List() {', // 1
    '  return (', // 2
    '    <ul className="tree-item">', // 3
    '      <li className="tree-item">a</li>', // 4
    '      <li className="tree-item">b</li>', // 5
    '    </ul>', // 6
    '  );', // 7
    '}', // 8
  ].join("\n");

  const ex = await treeSitterExtract("/p/List.tsx", code);
  const defs = (ex?.defs ?? []).filter((d) => d.name === "tree-item");
  const refs = (ex?.refs ?? []).filter((r) => r.name === "tree-item");
  assert.equal(defs.length, 1, `defined ${defs.length} times, expected once`);
  assert.equal(defs[0]!.line, 3);
  assert.deepEqual(refs.map((r) => r.line), [4, 5], "later uses are references");
});

test("multiple classes on one element are all landmarks; dynamic ones are not", async () => {
  const code = [
    'export function Row() {', // 1
    '  return (', // 2
    '    <div className="row is-active">', // 3
    '      <span className={cx("dynamic", x)}>hi</span>', // 4
    '      <input id="search-box" />', // 5
    '    </div>', // 6
    '  );', // 7
    '}', // 8
  ].join("\n");

  const ex = await treeSitterExtract("/p/Row.tsx", code);
  const names = (ex?.defs ?? []).filter((d) => d.kind === "element" || d.kind === "id").map((d) => d.name).sort();
  assert.deepEqual(names, ["is-active", "row", "search-box"]);
  // Capturing every <div> would bury the outline this exists to make readable.
  assert.ok(!names.includes("dynamic"), "a computed className is not a landmark");
});

test("a plain .ts file gets no JSX landmarks and still compiles its query", async () => {
  const ex = await treeSitterExtract("/p/plain.ts", 'const className = "not-jsx";\nexport function go() {}\n');
  assert.ok(ex, "the non-JSX query must still load");
  assert.ok(!(ex!.defs ?? []).some((d) => d.kind === "element"), "no elements in a file with no JSX");
});
