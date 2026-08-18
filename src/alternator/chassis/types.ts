/**
 * types.ts — the typed contract for the chassis (Mindweave's code map).
 *
 * The whole point of doing this in TypeScript instead of a loosely-typed graph
 * is that the compiler enforces the invariants:
 *
 *  - **Branded ids** (`FileId`, `SymbolId`) are nominally distinct from plain
 *    strings and from each other, so you cannot pass a file path where a symbol
 *    id is expected — a whole class of graph-corruption bugs becomes a type error.
 *  - **Discriminated unions** + exhaustive `switch` (via `assertNever`) mean
 *    adding a symbol kind or source fails to compile until it's handled everywhere.
 *  - **`Confidence` is in the result type**, so every consumer is forced to know
 *    whether an answer is compiler-`resolved` (LSP) or `name-level` (tree-sitter)
 *    and defer to grep/read accordingly. The "graph is an assistant, not an
 *    authority" rule is a contract here, not a comment.
 */

/** A resolved absolute file path, branded so it can't be confused with a name. */
export type FileId = string & { readonly __brand: "FileId" };

/** A unique symbol identity (`<file>#<name>@<line>`), branded. */
export type SymbolId = string & { readonly __brand: "SymbolId" };

export const asFileId = (abs: string): FileId => abs.split("\\").join("/") as FileId;
export const makeSymbolId = (file: FileId, name: string, line: number): SymbolId =>
  `${file}#${name}@${line}` as SymbolId;

/** How much to trust a derived fact. `resolved` = an LSP/compiler answer;
 *  `name-level` = a tree-sitter match by name (may over/under-count). */
export type Confidence = "resolved" | "name-level";

/** Where a fact came from — kept so we can prefer the higher-confidence source. */
export type Source = "lsp" | "tree-sitter";

/** Symbol kinds, normalized across LSP SymbolKind and tree-sitter tags. */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "variable"
  | "constant"
  | "field"
  | "module"
  // Markup kinds (HTML/CSS): a CSS class rule is "class", an `id`/`#id` is "id",
  // so a landing page's structure and cross-language wires live in the same graph.
  | "id"
  // A JSX element carrying a className/id, keyed by that name — the same key its CSS
  // rule uses, which is what wires a component's markup to the stylesheet that styles it.
  | "element"
  | "other";

/** A defined symbol — one node in the graph. */
export interface SymbolNode {
  readonly id: SymbolId;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly file: FileId;
  readonly line: number; // 1-based definition line
  readonly endLine?: number; // 1-based last line of the definition (for nesting)
  readonly signature?: string; // short header for outlines (no body)
  readonly doc?: string; // first line of the leading doc-comment / docstring, if any
}

/** One reference to a symbol (a use site). */
export interface Ref {
  readonly file: FileId;
  readonly line: number;
  readonly confidence: Confidence;
}

/** A nested outline entry for a file (symbols + signatures + docs, never bodies). */
export interface OutlineEntry {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly signature?: string;
  readonly doc?: string;
  readonly children?: readonly OutlineEntry[];
}

/** A symbol with its PageRank score (for the relevance map). */
export interface RankedSymbol {
  readonly symbol: SymbolNode;
  readonly score: number;
}

/** A directory-level rollup: what a folder contains and depends on, at a glance. */
export interface DirectorySummary {
  readonly dir: FileId; // the directory (forward-slashed absolute)
  readonly files: number;
  readonly symbols: number;
  readonly topSymbols: readonly SymbolNode[]; // a few representative/central symbols
  readonly dependsOn: readonly FileId[]; // other directories this folder imports from
}

/** The full line span of a symbol's definition — for reading or replacing its body
 *  without touching the whole file. Lines are 1-based and inclusive. */
export interface SymbolSpan {
  readonly file: FileId;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly start: number;
  readonly end: number;
  /** `resolved` = the language server's range; `name-level` = a tree-sitter span. */
  readonly confidence: Confidence;
}

/** A compiler/linter diagnostic from a language server (LSP publishDiagnostics). */
export interface CodeDiagnostic {
  readonly file: string; // absolute, forward-slashed
  readonly line: number; // 1-based
  readonly column: number; // 1-based
  readonly severity: "error" | "warning" | "info" | "hint";
  readonly message: string;
  readonly source?: string; // e.g. "ts", "eslint"
  /**
   * The column the failing token ENDS at (1-based, exclusive), same line only.
   * Present whenever the server's range didn't cross a line break — enough to
   * draw a caret under the exact token (`~~~~~~~~`) instead of just a marker
   * under its first character. Absent for a genuinely multi-line span.
   */
  readonly endColumn?: number;
}

/** What the chassis can tell you about its own readiness. */
export interface ChassisStatus {
  readonly ready: boolean;
  readonly files: number;
  readonly symbols: number;
  /** Languages currently served by an LSP (compiler-accurate). */
  readonly resolvedLanguages: readonly string[];
}

/**
 * The read-only query API the tools and engine talk to. Implementations live in
 * `index.ts`; a no-op `NULL_CHASSIS` is used until the lane has built one.
 */
export interface Chassis {
  /** Symbols defined in a file (or a directory tree), as a nested outline. */
  outline(absPath: string): Promise<readonly OutlineEntry[]>;
  /** Where a symbol named `name` is defined (often one; can be several). */
  definition(name: string): Promise<{ symbols: readonly SymbolNode[]; confidence: Confidence }>;
  /** Who references a symbol named `name`. */
  references(name: string): Promise<{ refs: readonly Ref[]; confidence: Confidence }>;
  /** PageRank-ranked symbols most relevant to a set of focus files. */
  relevant(focusFiles: readonly string[], limit?: number): Promise<readonly RankedSymbol[]>;
  /** The line span(s) of a named symbol's definition, for reading/replacing its body.
   *  `opts.path` narrows to one file; `opts.line` (1-based) disambiguates overloads.
   *  Empty when the symbol can't be located or its span can't be bounded. */
  span(name: string, opts?: { path?: string; line?: number }): Promise<readonly SymbolSpan[]>;
  /** A directory-level rollup (file/symbol counts, central symbols, folder deps), or
   *  null when the directory has no indexed files. */
  directorySummary(absDir: string): Promise<DirectorySummary | null>;
  /** Compiler/linter diagnostics for a file (errors/warnings), via LSP. Empty when
   *  no server is available or none are reported. Syncs the file first so results
   *  reflect the current on-disk contents (e.g. right after an edit). */
  diagnostics(absPath: string): Promise<readonly CodeDiagnostic[]>;
  status(): ChassisStatus;
  /** Stop background work and shut down language servers. */
  dispose?(): Promise<void>;
}

/** Exhaustiveness helper: a `default: assertNever(x)` fails to compile if a new
 *  union member is added but not handled. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
