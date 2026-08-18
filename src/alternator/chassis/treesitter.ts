/**
 * treesitter.ts — the universal extraction tier.
 *
 * Parses any supported language with tree-sitter (WASM, in-process) and pulls out
 * definitions and references via tag queries. This is the
 * always-available layer: it needs no language server, just a bundled grammar.
 * Facts from here are `name-level` (matched by name, not resolved), which the
 * graph records so the model knows to defer to grep/read when it matters.
 *
 * Grammars come from `tree-sitter-wasms`; the runtime from `web-tree-sitter`.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import Parser from "web-tree-sitter";
import type { SymbolKind } from "./types.js";
import { pickNearest, type LineSpan } from "../../tools/spanCore.js";
import { extractDomRefs } from "./domRefs.js";
import { IN_WORKER, isolatedExtract, isolatedSpan } from "./isolation.js";

// Inside the isolation worker every grammar runs in-process ON PURPOSE — that is where
// a fatal compile, and the memory a parse retains, are allowed to accumulate and die.
// `IN_WORKER` (owned by isolation.ts) is what breaks the recursion.

// web-tree-sitter is pinned to the 0.20.x era to match tree-sitter-wasms' grammar
// ABI (its grammars are built with tree-sitter-cli 0.20.8). Newer runtimes use a
// dynamic-linking loader that rejects these grammars. This is the proven combo.
const require = createRequire(import.meta.url);
const WASM_DIR = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

export interface ExtractedDef {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based
  endLine?: number; // 1-based last line of the definition
  signature?: string;
  doc?: string; // first line of the leading doc-comment / docstring
}
export interface ExtractedRef {
  name: string;
  line: number;
}
export interface ExtractedImport {
  /** The module specifier as written (e.g. "./util", "react", "os.path"). */
  spec: string;
  line: number;
}
export interface Extraction {
  defs: ExtractedDef[];
  refs: ExtractedRef[];
  imports: ExtractedImport[];
}

// A language: which grammar wasm, and the tag query that finds defs/refs. Capture
// names are `definition.<kind>` (on the name node) and `reference` (on the used
// name), so a capture gives us the name text + line directly.
interface LangDef {
  grammar: string;
  query: string;
}

const TS_QUERY = `
(function_declaration name: (identifier) @definition.function)
(method_definition name: (property_identifier) @definition.method)
(class_declaration name: (type_identifier) @definition.class)
(interface_declaration name: (type_identifier) @definition.interface)
(type_alias_declaration name: (type_identifier) @definition.type)
(enum_declaration name: (identifier) @definition.enum)
(variable_declarator name: (identifier) @definition.function value: [(arrow_function) (function_expression)])
(public_field_definition name: (property_identifier) @definition.field)
(call_expression function: (identifier) @reference)
(call_expression function: (member_expression property: (property_identifier) @reference))
(new_expression constructor: (identifier) @reference)
(import_statement source: (string) @import)
(export_statement source: (string) @import)
`;

const JS_QUERY = `
(function_declaration name: (identifier) @definition.function)
(method_definition name: (property_identifier) @definition.method)
(class_declaration name: (identifier) @definition.class)
(variable_declarator name: (identifier) @definition.function value: [(arrow_function) (function_expression)])
(call_expression function: (identifier) @reference)
(call_expression function: (member_expression property: (property_identifier) @reference))
(new_expression constructor: (identifier) @reference)
(import_statement source: (string) @import)
(export_statement source: (string) @import)
`;

const PY_QUERY = `
(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)
(call function: (identifier) @reference)
(call function: (attribute attribute: (identifier) @reference))
(import_from_statement module_name: (dotted_name) @import)
(import_statement name: (dotted_name) @import)
`;

// ── The broad language set (validated against each real grammar wasm) ───────────
// Every query below was probed against tree-sitter-wasms' actual grammar so it both
// COMPILES (a bad node name throws at load) and extracts real defs/refs. Adding a
// language here is all it takes — the graph, outline, ranking, and read_symbol all
// flow from these captures.

const GO_QUERY = `
(function_declaration name: (identifier) @definition.function)
(method_declaration name: (field_identifier) @definition.method)
(type_declaration (type_spec name: (type_identifier) @definition.type))
(call_expression function: (identifier) @reference)
(call_expression function: (selector_expression field: (field_identifier) @reference))
`;

const RUST_QUERY = `
(function_item name: (identifier) @definition.function)
(struct_item name: (type_identifier) @definition.struct)
(enum_item name: (type_identifier) @definition.enum)
(trait_item name: (type_identifier) @definition.trait)
(mod_item name: (identifier) @definition.module)
(call_expression function: (identifier) @reference)
(call_expression function: (field_expression field: (field_identifier) @reference))
(macro_invocation macro: (identifier) @reference)
`;

const JAVA_QUERY = `
(class_declaration name: (identifier) @definition.class)
(interface_declaration name: (identifier) @definition.interface)
(enum_declaration name: (identifier) @definition.enum)
(method_declaration name: (identifier) @definition.method)
(constructor_declaration name: (identifier) @definition.method)
(method_invocation name: (identifier) @reference)
(object_creation_expression type: (type_identifier) @reference)
`;

const C_QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @definition.function))
(struct_specifier name: (type_identifier) @definition.struct)
(enum_specifier name: (type_identifier) @definition.enum)
(type_definition declarator: (type_identifier) @definition.type)
(call_expression function: (identifier) @reference)
`;

const CPP_QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @definition.function))
(class_specifier name: (type_identifier) @definition.class)
(struct_specifier name: (type_identifier) @definition.struct)
(enum_specifier name: (type_identifier) @definition.enum)
(call_expression function: (identifier) @reference)
(call_expression function: (field_expression field: (field_identifier) @reference))
`;

const CSHARP_QUERY = `
(class_declaration name: (identifier) @definition.class)
(interface_declaration name: (identifier) @definition.interface)
(struct_declaration name: (identifier) @definition.struct)
(enum_declaration name: (identifier) @definition.enum)
(method_declaration name: (identifier) @definition.method)
(invocation_expression function: (identifier) @reference)
(invocation_expression function: (member_access_expression name: (identifier) @reference))
`;

const PHP_QUERY = `
(function_definition name: (name) @definition.function)
(method_declaration name: (name) @definition.method)
(class_declaration name: (name) @definition.class)
(interface_declaration name: (name) @definition.interface)
(trait_declaration name: (name) @definition.trait)
(function_call_expression function: (name) @reference)
(member_call_expression name: (name) @reference)
`;

const LUA_QUERY = `
(function_definition_statement (identifier) @definition.function)
(local_function_definition_statement (identifier) @definition.function)
(call (variable (identifier) @reference))
`;

const SCALA_QUERY = `
(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)
(object_definition name: (identifier) @definition.module)
(trait_definition name: (identifier) @definition.trait)
(call_expression function: (identifier) @reference)
`;

const BASH_QUERY = `
(function_definition name: (word) @definition.function)
(command name: (command_name) @reference)
`;

const OCAML_QUERY = `
(value_definition (let_binding pattern: (value_name) @definition.function))
(type_definition (type_binding name: (type_constructor) @definition.type))
`;

const ZIG_QUERY = `
(function_declaration name: (identifier) @definition.function)
`;

const SOLIDITY_QUERY = `
(contract_declaration name: (identifier) @definition.class)
(function_definition name: (identifier) @definition.function)
`;

const SWIFT_QUERY = `
(function_declaration name: (simple_identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(protocol_declaration name: (type_identifier) @definition.interface)
(call_expression (simple_identifier) @reference)
`;

/**
 * The JSX half, appended to the TS/JS query for the grammars that have JSX nodes.
 *
 * A component file's render body has no DECLARATIONS in it, so a declaration-only query
 * goes silent over exactly the part most likely to be edited: measured on a 1,381-line
 * React component, the outline's last entry was L1128 and the entire render — 18% of the
 * file, and where the change actually had to go — did not exist in the graph at all. The
 * model had nothing to navigate by, guessed an offset, missed, and read again.
 *
 * The whole attribute node is captured and read in JS rather than matched by grammar
 * sub-node names, the same choice `markup.ts` makes and for the same reason: the shape
 * of a `jsx_attribute` differs between grammars and versions, its text does not.
 */
const JSX_QUERY = `
(jsx_attribute) @jsx.attribute
`;

const KOTLIN_QUERY = `
(function_declaration (simple_identifier) @definition.function)
(class_declaration (type_identifier) @definition.class)
(object_declaration (type_identifier) @definition.class)
(call_expression (simple_identifier) @reference)
`;

const LANGS: Record<string, LangDef> = {
  ".ts": { grammar: "tree-sitter-typescript.wasm", query: TS_QUERY },
  ".mts": { grammar: "tree-sitter-typescript.wasm", query: TS_QUERY },
  ".cts": { grammar: "tree-sitter-typescript.wasm", query: TS_QUERY },
  ".tsx": { grammar: "tree-sitter-tsx.wasm", query: TS_QUERY + JSX_QUERY },
  ".js": { grammar: "tree-sitter-javascript.wasm", query: JS_QUERY },
  ".mjs": { grammar: "tree-sitter-javascript.wasm", query: JS_QUERY },
  ".cjs": { grammar: "tree-sitter-javascript.wasm", query: JS_QUERY },
  ".jsx": { grammar: "tree-sitter-javascript.wasm", query: JS_QUERY + JSX_QUERY },
  ".py": { grammar: "tree-sitter-python.wasm", query: PY_QUERY },
  ".pyi": { grammar: "tree-sitter-python.wasm", query: PY_QUERY },
  ".go": { grammar: "tree-sitter-go.wasm", query: GO_QUERY },
  ".rs": { grammar: "tree-sitter-rust.wasm", query: RUST_QUERY },
  ".java": { grammar: "tree-sitter-java.wasm", query: JAVA_QUERY },
  ".c": { grammar: "tree-sitter-c.wasm", query: C_QUERY },
  ".h": { grammar: "tree-sitter-c.wasm", query: C_QUERY },
  ".cpp": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".cc": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".cxx": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".hpp": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".hh": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".hxx": { grammar: "tree-sitter-cpp.wasm", query: CPP_QUERY },
  ".cs": { grammar: "tree-sitter-c_sharp.wasm", query: CSHARP_QUERY },
  ".php": { grammar: "tree-sitter-php.wasm", query: PHP_QUERY },
  ".lua": { grammar: "tree-sitter-lua.wasm", query: LUA_QUERY },
  ".scala": { grammar: "tree-sitter-scala.wasm", query: SCALA_QUERY },
  ".sc": { grammar: "tree-sitter-scala.wasm", query: SCALA_QUERY },
  ".sh": { grammar: "tree-sitter-bash.wasm", query: BASH_QUERY },
  ".bash": { grammar: "tree-sitter-bash.wasm", query: BASH_QUERY },
  ".ml": { grammar: "tree-sitter-ocaml.wasm", query: OCAML_QUERY },
  ".mli": { grammar: "tree-sitter-ocaml.wasm", query: OCAML_QUERY },
  ".zig": { grammar: "tree-sitter-zig.wasm", query: ZIG_QUERY },
  ".sol": { grammar: "tree-sitter-solidity.wasm", query: SOLIDITY_QUERY },
  ".swift": { grammar: "tree-sitter-swift.wasm", query: SWIFT_QUERY },
  ".kt": { grammar: "tree-sitter-kotlin.wasm", query: KOTLIN_QUERY },
  ".kts": { grammar: "tree-sitter-kotlin.wasm", query: KOTLIN_QUERY },
};

/** Extensions we can extract from (used by the lane to decide what to parse). */
export function isSupported(absPath: string): boolean {
  return extname(absPath).toLowerCase() in LANGS;
}

/** The directory holding the grammar wasm files. Exported so the language tests can
 *  weigh a grammar without duplicating how it is located. */
export const GRAMMAR_DIR = WASM_DIR;

/** The grammar wasm filename a path would load, or null if unsupported. */
export function grammarFileFor(absPath: string): string | null {
  return LANGS[extname(absPath).toLowerCase()]?.grammar ?? null;
}

/** The JS/TS family — these also carry DOM references to markup names. */
const JS_TS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

type Language = Parser.Language;
type Query = Parser.Query;

let initPromise: Promise<void> | undefined;
const parser = { current: null as Parser | null };
const langCache = new Map<string, { language: Language; query: Query }>();

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init().then(() => {
      parser.current = new Parser();
    });
  }
  return initPromise;
}

const grammarCache = new Map<string, Language>();

/** Load a grammar wasm by filename (cached). Shared by the code tier (which also
 *  compiles a query) and the markup tier (which walks the tree directly). */
async function loadGrammar(grammarFile: string): Promise<Language> {
  const cached = grammarCache.get(grammarFile);
  if (cached) return cached;
  const bytes = await readFile(join(WASM_DIR, grammarFile));
  const language = await Parser.Language.load(new Uint8Array(bytes));
  grammarCache.set(grammarFile, language);
  return language;
}

async function loadLang(def: LangDef): Promise<{ language: Language; query: Query }> {
  const cached = langCache.get(def.grammar);
  if (cached) return cached;
  const language = await loadGrammar(def.grammar);
  const query = language.query(def.query);
  const entry = { language, query };
  langCache.set(def.grammar, entry);
  return entry;
}

/**
 * Parse `code` with a named grammar wasm and return the tree (or null on failure).
 * The caller OWNS the tree and must `tree.delete()` it. Used by the markup tier to
 * parse HTML/CSS, which don't fit the code tier's def/ref tag-query shape.
 */
export async function parseTree(grammarFile: string, code: string): Promise<Parser.Tree | null> {
  try {
    await ensureInit();
    const language = await loadGrammar(grammarFile);
    parser.current!.setLanguage(language);
    return parser.current!.parse(code);
  } catch {
    return null;
  }
}

// Node types that ARE a definition (the smallest enclosing one of these, climbed
// from a captured name node, is the symbol's full body). Broad across grammars so
// the tree-sitter fallback works for TS/JS/Python and degrades gracefully elsewhere.
const DECL_TYPES = new Set([
  // JS / TS / Python
  "function_declaration",
  "function_definition",
  "function_expression",
  "generator_function_declaration",
  "arrow_function",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "variable_declarator",
  "public_field_definition",
  "field_definition",
  // Rust
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",
  // Go
  "type_declaration",
  "type_spec",
  // Java / C#
  "constructor_declaration",
  "struct_declaration",
  // C / C++
  "struct_specifier",
  "class_specifier",
  "enum_specifier",
  "type_definition",
  // PHP
  "trait_declaration",
  // Lua
  "function_definition_statement",
  "local_function_definition_statement",
  // Scala
  "object_definition",
  "trait_definition",
  // OCaml
  "value_definition",
  // Solidity / Swift / Kotlin
  "contract_declaration",
  "protocol_declaration",
  "object_declaration",
]);

// Wrappers that belong WITH the definition (so the span includes `export`/decorators).
const WRAPPER_TYPES = new Set(["export_statement", "decorated_definition", "decorator"]);

/** Climb from a captured name node to the line span of its whole definition. */
function enclosingSpan(nameNode: Parser.SyntaxNode): LineSpan {
  let node: Parser.SyntaxNode | null = nameNode.parent;
  let decl: Parser.SyntaxNode | null = null;
  while (node) {
    if (DECL_TYPES.has(node.type)) {
      decl = node;
      break;
    }
    node = node.parent;
  }
  let top = decl ?? nameNode;
  // Swallow an `export`/decorator wrapper so the header line isn't left behind.
  while (top.parent && WRAPPER_TYPES.has(top.parent.type)) top = top.parent;
  return { start: top.startPosition.row + 1, end: top.endPosition.row + 1 };
}

/**
 * The full line span of a symbol named `name` in `code`, from the AST. Structural
 * (the span IS an AST node), but `name-level` in confidence because the MATCH is by
 * name — the tree-sitter fallback used when no language server can answer. `nearLine`
 * disambiguates when the name is defined more than once. Null when it can't be found.
 */
export async function treeSitterSpan(
  absPath: string,
  code: string,
  name: string,
  nearLine?: number,
): Promise<LineSpan | null> {
  const def = LANGS[extname(absPath).toLowerCase()];
  if (!def) return null;
  // NO grammar parses in this process. See treeSitterExtract for why the old
  // size-based exemption was wrong.
  if (!IN_WORKER) return isolatedSpan(def.grammar, absPath, code, name, nearLine);
  try {
    await ensureInit();
    const { language, query } = await loadLang(def);
    parser.current!.setLanguage(language);
    const tree = parser.current!.parse(code);
    if (!tree) return null;
    const spans: LineSpan[] = [];
    for (const cap of query.captures(tree.rootNode)) {
      if (!cap.name.startsWith("definition.")) continue;
      if (cap.node.text !== name) continue;
      spans.push(enclosingSpan(cap.node));
    }
    tree.delete();
    return pickNearest(spans, nearLine);
  } catch {
    return null;
  }
}

/**
 * The first line of a symbol's documentation, if any — a JSDoc/`//` block just
 * ABOVE the definition (JS/TS/most languages) or a `"""`/`'''` docstring just
 * BELOW it (Python). Pure and line-based (exported for tests); returns a short,
 * clean sentence or undefined. Best-effort intent, not a full doc parser.
 */
export function extractDoc(lines: string[], defLine1: number): string | undefined {
  // ── comment block immediately above (skip blanks + decorators) ──
  let i = defLine1 - 2; // 0-based index of the line above the definition
  while (i >= 0 && (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("@"))) i--;
  const above: string[] = [];
  if (i >= 0 && lines[i]!.includes("*/")) {
    // A block comment: gather upward to its opening `/*` / `/**`.
    while (i >= 0) {
      above.unshift(lines[i]!);
      if (lines[i]!.includes("/*")) break;
      i--;
    }
  } else {
    while (i >= 0 && lines[i]!.trim().startsWith("//")) {
      above.unshift(lines[i]!);
      i--;
    }
  }
  const fromAbove = firstDocSentence(above);
  if (fromAbove) return fromAbove;

  // ── Python docstring on the first line(s) of the body ──
  let j = defLine1; // 0-based index of the line after the definition
  while (j < lines.length && lines[j]!.trim() === "") j++;
  const m = /^[rbuRBU]*("""|''')(.*)$/.exec(lines[j]?.trim() ?? "");
  if (m) {
    const rest = m[2]!;
    const close = rest.indexOf(m[1]!);
    const text = (close >= 0 ? rest.slice(0, close) : rest).trim();
    return clipDoc(text);
  }
  return undefined;
}

/** Strip comment markers from a gathered block and return its first sentence,
 *  skipping section dividers (`// ── queries ──`) and tag-only lines (`@param`). */
function firstDocSentence(block: string[]): string | undefined {
  for (const raw of block) {
    const cleaned = raw
      .replace(/^\s*\/\*\*?/, "")
      .replace(/\*\/\s*$/, "")
      .replace(/^\s*\*\s?/, "")
      .replace(/^\s*\/\/+/, "")
      .trim();
    if (cleaned && !cleaned.startsWith("@") && !isDivider(cleaned)) return clipDoc(cleaned);
  }
  return undefined;
}

/** A section divider (`──── queries ────`, `====`, `####`) — not real prose. */
function isDivider(s: string): boolean {
  const dashes = (s.match(/[─\-=*#~_]/g) ?? []).length;
  const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
  return dashes >= 4 && dashes >= letters;
}

function clipDoc(text: string): string | undefined {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  // Prefer up to the first sentence end, then hard-cap.
  const dot = one.search(/[.!?](\s|$)/);
  const sentence = dot >= 0 ? one.slice(0, dot + 1) : one;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

const KIND_OF: Record<string, SymbolKind> = {
  function: "function",
  method: "method",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  field: "field",
  variable: "variable",
  struct: "struct",
  trait: "trait",
  module: "module",
  constant: "constant",
};

/** Extract defs + refs from one file. Returns null when the language is
 *  unsupported or anything fails (the caller degrades to grep/read). */
export async function treeSitterExtract(absPath: string, code: string): Promise<Extraction | null> {
  const def = LANGS[extname(absPath).toLowerCase()];
  if (!def) return null;
  // NO grammar parses in this process.
  //
  // This used to exempt anything under 4.5 MB of grammar wasm, on the theory that only
  // the oversized grammars were dangerous. Measurement killed that theory: a parse
  // RETAINS memory that `tree.delete()` does not return, roughly 57-70 MB for one 54 KB
  // JSX file, and tsx (2.41 MB) and typescript (2.34 MB) sat comfortably under the
  // threshold while being the two most-used grammars in the product. Grammar file size
  // predicts the cost of COMPILING a grammar; it says nothing about what a parse keeps.
  // Indexing 120 ordinary files under the old rule peaked at 1.9 GB in the main
  // process, where there is nothing to contain it.
  if (!IN_WORKER) return isolatedExtract(def.grammar, absPath, code);
  try {
    await ensureInit();
    const { language, query } = await loadLang(def);
    parser.current!.setLanguage(language);
    const tree = parser.current!.parse(code);
    if (!tree) return null;

    const lines = code.split("\n");
    const defs: ExtractedDef[] = [];
    const refs: ExtractedRef[] = [];
    const imports: ExtractedImport[] = [];
    // One per FILE: a landmark named twice in the same component is one symbol.
    const jsxSeen = new Set<string>();
    for (const cap of query.captures(tree.rootNode)) {
      const name = cap.node.text;
      const line = cap.node.startPosition.row + 1;
      if (cap.name === "import") {
        const spec = unquote(cap.node.text);
        if (spec) imports.push({ spec, line });
        continue;
      }
      if (cap.name.startsWith("definition.")) {
        const kind = KIND_OF[cap.name.slice("definition.".length)] ?? "other";
        const span = enclosingSpan(cap.node);
        defs.push({
          name,
          kind,
          line,
          endLine: span.end,
          signature: (lines[line - 1] ?? "").trim().slice(0, 200),
          doc: extractDoc(lines, line),
        });
      } else if (cap.name === "jsx.attribute") {
        // A JSX landmark: `className="sidebar-header"` / `id="editor"`. The FIRST place a
        // name appears in the file is its definition (so it lands in the outline and the
        // render body stops being a blank stretch), every later one a reference — the
        // same rule the stylesheet tier uses, so a class defined in CSS and used in JSX
        // meet on the graph's name key and `references` finds both sides.
        for (const landmark of jsxLandmarks(cap.node.text)) {
          const key = `${landmark.kind}:${landmark.name}`;
          if (jsxSeen.has(key)) {
            refs.push({ name: landmark.name, line });
            continue;
          }
          jsxSeen.add(key);
          defs.push({
            name: landmark.name,
            kind: "element",
            line,
            endLine: jsxElementEnd(cap.node),
            signature: (lines[line - 1] ?? "").trim().slice(0, 200),
          });
        }
      } else if (cap.name === "reference") {
        refs.push({ name, line });
      }
    }
    tree.delete();
    // JS/TS also wire markup by DOM name (getElementById/querySelector/classList):
    // record those as name-level refs so a standalone script links to a CSS/HTML id.
    if (JS_TS_EXTS.has(extname(absPath).toLowerCase())) {
      for (const d of extractDomRefs(code)) refs.push({ name: d.name, line: d.line });
    }
    return { defs, refs, imports };
  } catch {
    return null;
  }
}

/**
 * The last line of the JSX element an attribute belongs to.
 *
 * `enclosingSpan` is for declarations and climbs to the nearest one, which from inside a
 * render body is the whole component — it reported a 227-line span for a single `<div>`'s
 * opening tag, which would then be what `read_symbol` handed back. The element's own
 * extent is the honest answer, and it is one or two parents up.
 */
function jsxElementEnd(attribute: Parser.SyntaxNode): number {
  let node: Parser.SyntaxNode | null = attribute.parent;
  while (node) {
    if (node.type === "jsx_element" || node.type === "jsx_self_closing_element") {
      return node.endPosition.row + 1;
    }
    // Stop at the opening tag's own boundary rather than climbing into the component.
    if (node.type !== "jsx_opening_element") break;
    node = node.parent;
  }
  return attribute.endPosition.row + 1;
}

/**
 * The navigable names in one JSX attribute, or none.
 *
 * Only `className` and `id` with a plain string value: those are what a person searches
 * for and what a stylesheet names, so they are the landmarks worth putting on the map.
 * `className={cx(...)}` and every other attribute are deliberately skipped — capturing
 * every `<div>` would bury the outline it is supposed to make readable.
 */
function jsxLandmarks(attributeText: string): { name: string; kind: "class" | "id" }[] {
  const m = /^(className|id)\s*=\s*["']([^"'{}]+)["']$/.exec(attributeText.trim());
  if (!m) return [];
  const kind = m[1] === "id" ? "id" : "class";
  return m[2]!
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => ({ name, kind }));
}

/** Strip surrounding quotes from a captured string-literal node's text. */
function unquote(raw: string): string {
  return raw.replace(/^["'`]|["'`]$/g, "").trim();
}
