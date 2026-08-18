/**
 * markup.ts — the HTML/CSS extraction tier: cross-language wiring on Mindweave's
 * name-keyed graph.
 *
 * Mindweave's code tier (treesitter.ts) only understands TS/JS/Python, so a landing
 * page (a big HTML file with embedded <style>/<script>) was invisible to the graph
 * — the model had to read the whole file and brute-force string edits. This tier
 * makes those files first-class:
 *
 *   - CSS selectors (`.hero`, `#nav`) become DEFINITIONS (name = the class/id).
 *   - HTML `class="hero"` become REFERENCES; `id="nav"` become DEFINITIONS (the
 *     element lives here) — so `#nav` from CSS and the element share the name.
 *   - Embedded <style> is parsed as CSS and <script> scanned for DOM refs, because
 *     a page keeps all three languages in one file.
 *
 * Because Mindweave's graph is keyed by NAME, feeding these defs/refs in wires the CSS
 * rule ↔ the HTML elements ↔ the JS that touches them for free: `definition("hero")`
 * finds the rule + element, `references("hero")` finds every use. `outline(page.html)`
 * becomes the page's structure (sections + selectors) with line numbers — the model
 * navigates to the exact part instead of reading 1700 lines.
 */
import { extname } from "node:path";
import type Parser from "web-tree-sitter";
import type { LineSpan } from "../../tools/spanCore.js";
import { pickNearest } from "../../tools/spanCore.js";
import { parseTree, type Extraction, type ExtractedDef, type ExtractedRef, type ExtractedImport } from "./treesitter.js";
import { extractDomRefs } from "./domRefs.js";
import { IN_WORKER, isolatedMarkup } from "./isolation.js";

const HTML_EXTS = new Set([".html", ".htm"]);
const CSS_EXTS = new Set([".css", ".scss", ".sass", ".less"]);

const HTML_GRAMMAR = "tree-sitter-html.wasm";
const CSS_GRAMMAR = "tree-sitter-css.wasm";

/** Whether this tier handles a file (HTML or a stylesheet). */
export function isMarkupSupported(absPath: string): boolean {
  const e = extname(absPath).toLowerCase();
  return HTML_EXTS.has(e) || CSS_EXTS.has(e);
}

function isHtml(absPath: string): boolean {
  return HTML_EXTS.has(extname(absPath).toLowerCase());
}

/** Extract defs/refs/imports from an HTML or CSS file. Null on failure (the caller
 *  degrades to grep/read), matching treeSitterExtract's contract. */
export async function extractMarkup(absPath: string, code: string): Promise<Extraction | null> {
  // Isolated like the code tier, and for the same measured reason. This tier had no
  // guard at all before — not even the grammar-size one — while parsing the big nested
  // pages that cost the most. Inside the worker this check is false and the real work
  // below runs, which is what the child is for.
  if (!IN_WORKER) return isolatedMarkup(absPath, code);
  try {
    if (isHtml(absPath)) return await extractHtml(code);
    return { ...(await extractCssDefs(code, 0)), imports: [] };
  } catch {
    return null;
  }
}

// ── CSS ────────────────────────────────────────────────────────────────────────

/**
 * Every class/id selector in a stylesheet: DEFINED once, at the first rule that names
 * it, and REFERENCED at every rule after that.
 *
 * Robust by design: instead of leaning on CSS grammar sub-node names, we take each
 * rule's whole selector text and pull `.class` / `#id` tokens from it — so
 * `.hero-stats .value { }` records BOTH `hero-stats` and `value` at that rule.
 * `lineOffset` shifts lines when the CSS is an embedded <style> block.
 *
 * WHY DEDUPED. A class is written once per rule that touches it, and a real stylesheet
 * touches the same class from many rules: measured on a 2,045-line sheet, 439 symbols
 * for 128 distinct names — 3.4x — with `.sepia` stored sixty-six separate times. That
 * one file was then 83% of the whole project's symbol graph, which is what the ranking
 * ranks over and what an outline lists. Nothing is lost by deduping: "every rule that
 * styles this class" is a REFERENCES question, and it is now answered as one.
 */
async function extractCssDefs(
  code: string,
  lineOffset: number,
  seen: Set<string> = new Set(),
): Promise<{ defs: ExtractedDef[]; refs: ExtractedRef[] }> {
  const tree = await parseTree(CSS_GRAMMAR, code);
  if (!tree) return { defs: [], refs: [] };
  const defs: ExtractedDef[] = [];
  const refs: ExtractedRef[] = [];
  try {
    for (const rule of tree.rootNode.descendantsOfType("rule_set")) {
      const selectors = rule.namedChildren.find((c) => c.type === "selectors") ?? rule.namedChild(0);
      const selText = selectors ? selectors.text : "";
      const line = rule.startPosition.row + 1 + lineOffset;
      const endLine = rule.endPosition.row + 1 + lineOffset;
      const sig = oneLine(selText);
      const here = new Set<string>();
      for (const m of selText.matchAll(/([.#])([A-Za-z_][\w-]*)/g)) {
        const name = m[2]!;
        const kind = m[1] === "#" ? "id" : "class";
        const key = `${kind}:${name}`;
        if (here.has(key)) continue; // a class repeated in one selector counts once
        here.add(key);
        if (seen.has(key)) {
          refs.push({ name, line });
          continue;
        }
        seen.add(key);
        defs.push({ name, kind, line, endLine, signature: sig });
      }
    }
  } finally {
    tree.delete();
  }
  return { defs, refs };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

async function extractHtml(code: string): Promise<Extraction> {
  const tree = await parseTree(HTML_GRAMMAR, code);
  if (!tree) return { defs: [], refs: [], imports: [] };
  const defs: ExtractedDef[] = [];
  const refs: ExtractedRef[] = [];
  const imports: ExtractedImport[] = [];
  try {
    const root = tree.rootNode;

    // Attributes: class="…" → refs, id="…" → defs, href/src → local imports.
    for (const attr of root.descendantsOfType("attribute")) {
      const nameNode = attr.namedChildren.find((c) => c.type === "attribute_name");
      const valNode = attr.namedChildren.find(
        (c) => c.type === "quoted_attribute_value" || c.type === "attribute_value",
      );
      if (!nameNode || !valNode) continue;
      const attrName = nameNode.text.toLowerCase();
      const value = stripQuotes(valNode.text);
      const line = attr.startPosition.row + 1;
      if (attrName === "class") {
        for (const cls of value.split(/\s+/).filter(Boolean)) refs.push({ name: cls, line });
      } else if (attrName === "id") {
        const id = value.trim();
        if (id) defs.push({ name: id, kind: "id", line, signature: `#${id}` });
      } else if (attrName === "href" || attrName === "src") {
        if (isLocalRef(value)) imports.push({ spec: value, line });
      }
    }

    // Embedded <style> → CSS defs; <script> → DOM refs. raw_text carries the inner
    // source; its start row shifts the reported lines to the enclosing file.
    const cssSeen = new Set<string>();
    for (const style of root.descendantsOfType("style_element")) {
      const raw = style.namedChildren.find((c) => c.type === "raw_text");
      if (raw) {
        // One `seen` across every <style> block in the page, so a class defined in the
        // first block is a reference in the second rather than a second definition.
        const css = await extractCssDefs(raw.text, raw.startPosition.row, cssSeen);
        defs.push(...css.defs);
        refs.push(...css.refs);
      }
    }
    for (const script of root.descendantsOfType("script_element")) {
      const raw = script.namedChildren.find((c) => c.type === "raw_text");
      if (raw) refs.push(...extractDomRefs(raw.text, raw.startPosition.row));
    }
  } finally {
    tree.delete();
  }
  return { defs, refs, imports };
}

/**
 * The line span of a named CSS rule or HTML element, so read_symbol /
 * replace_symbol_body can target a selector's whole block by name. For CSS: the
 * rule_set whose selector mentions `.name`/`#name`. For HTML: the element carrying
 * `id="name"`. `nearLine` disambiguates when the name appears more than once.
 * Null when it can't be located (the caller degrades to a ranged read).
 */
export async function markupSpan(
  absPath: string,
  code: string,
  name: string,
  nearLine?: number,
): Promise<LineSpan | null> {
  try {
    if (isHtml(absPath)) return await htmlSpan(code, name, nearLine);
    return await cssSpan(code, name, nearLine, 0);
  } catch {
    return null;
  }
}

async function cssSpan(code: string, name: string, nearLine: number | undefined, lineOffset: number): Promise<LineSpan | null> {
  const tree = await parseTree(CSS_GRAMMAR, code);
  if (!tree) return null;
  try {
    const spans: LineSpan[] = [];
    const token = new RegExp(`[.#]${escapeRegExp(name)}(?![\\w-])`);
    for (const rule of tree.rootNode.descendantsOfType("rule_set")) {
      const selectors = rule.namedChildren.find((c) => c.type === "selectors") ?? rule.namedChild(0);
      if (selectors && token.test(selectors.text)) {
        spans.push({ start: rule.startPosition.row + 1 + lineOffset, end: rule.endPosition.row + 1 + lineOffset });
      }
    }
    return pickNearest(spans, nearLine);
  } finally {
    tree.delete();
  }
}

async function htmlSpan(code: string, name: string, nearLine?: number): Promise<LineSpan | null> {
  const tree = await parseTree(HTML_GRAMMAR, code);
  if (!tree) return null;
  try {
    const spans: LineSpan[] = [];
    // Also search embedded <style> blocks, so a selector defined in a page resolves.
    for (const style of tree.rootNode.descendantsOfType("style_element")) {
      const raw = style.namedChildren.find((c) => c.type === "raw_text");
      if (raw) {
        const inner = await cssSpan(raw.text, name, nearLine, raw.startPosition.row);
        if (inner) spans.push(inner);
      }
    }
    // Elements carrying id="name".
    for (const attr of tree.rootNode.descendantsOfType("attribute")) {
      const nameNode = attr.namedChildren.find((c) => c.type === "attribute_name");
      const valNode = attr.namedChildren.find(
        (c) => c.type === "quoted_attribute_value" || c.type === "attribute_value",
      );
      if (!nameNode || !valNode) continue;
      if (nameNode.text.toLowerCase() !== "id" || stripQuotes(valNode.text).trim() !== name) continue;
      const el = enclosingElement(attr);
      spans.push({ start: el.startPosition.row + 1, end: el.endPosition.row + 1 });
    }
    return pickNearest(spans, nearLine);
  } finally {
    tree.delete();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Climb from an attribute to its enclosing element (for an id's element span). */
function enclosingElement(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let n: Parser.SyntaxNode = node;
  while (n.parent && n.type !== "element") n = n.parent;
  return n.type === "element" ? n : node;
}

function isLocalRef(value: string): boolean {
  const v = value.trim();
  if (!v || v.startsWith("#")) return false; // in-page anchor, not a file
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false; // http:, mailto:, data:, etc.
  if (v.startsWith("//")) return false; // protocol-relative
  return true;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 119) + "…" : flat;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
