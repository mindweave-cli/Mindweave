/**
 * index.ts — the Chassis: build the code graph from a project and answer queries.
 *
 * This is what the tools and engine talk to (the `Chassis` interface in types.ts).
 * The graph is sourced from the tree-sitter tier ONLY (universal, `name-level`).
 * The LSP tier is consulted per query and takes precedence when it answers; its
 * results are never written back into the graph, so anything reading the graph
 * directly — `relevant`, `outline`, `directorySummary` — is on the tree-sitter
 * tier regardless of whether a language server is running. Building is plain,
 * deterministic work — the `alternator` lane runs it in the background, so it
 * costs no tokens.
 */
import { promises as fs } from "node:fs";
import { dirname, extname, resolve as resolvePath } from "node:path";
import { walkFiles } from "../../tools/walk.js";
import { excludedFromSearch } from "../../tools/guard.js";
import { loadCache, saveCache, type ChassisSnapshot, type FileStamp } from "./cache.js";
import { CodeGraph } from "./graph.js";
import { LspManager } from "./lsp.js";
import { ensureServers, languageIdFor } from "./servers.js";
import { rankSymbols } from "./rank.js";
import { isSupported, treeSitterExtract, treeSitterSpan } from "./treesitter.js";
import { isMarkupSupported, extractMarkup, markupSpan } from "./markup.js";
import type { LineSpan } from "../../tools/spanCore.js";
import {
  asFileId,
  makeSymbolId,
  type Chassis,
  type ChassisStatus,
  type CodeDiagnostic,
  type Confidence,
  type DirectorySummary,
  type FileId,
  type OutlineEntry,
  type Ref,
  type RankedSymbol,
  type SymbolKind,
  type SymbolNode,
  type SymbolSpan,
} from "./types.js";

export interface ChassisOptions {
  /** Use language servers for compiler-accurate def/ref (default true). Tests
   *  disable it for determinism + speed (pure tree-sitter tier). */
  lsp?: boolean;
}

const MAX_FILES = 6000; // safety cap for pathological repos
const MAX_FILE_BYTES = 1_500_000;

export class CodeChassis implements Chassis {
  private graph = new CodeGraph();
  private ready = false;
  private lsp: LspManager | null;
  private langs = new Set<string>();
  /** Per-file size/mtime, so refresh re-indexes only what changed. */
  private manifest = new Map<FileId, FileStamp>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly root: string, opts: ChassisOptions = {}) {
    this.lsp = opts.lsp === false ? null : new LspManager(root);
  }

  /** Parse one file into the graph (replacing any prior facts for it) and stamp
   *  the manifest. `stamp` lets the caller pass a stat it already took. */
  async indexFile(absPath: string, stamp?: FileStamp): Promise<void> {
    const markup = isMarkupSupported(absPath);
    if (!isSupported(absPath) && !markup) return;
    const file = asFileId(absPath);
    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch {
      return;
    }
    if (buf.length > MAX_FILE_BYTES) return;
    const text = buf.toString("utf8");
    // Markup files (HTML/CSS) go through the markup tier; code through tree-sitter tags.
    const extraction = markup ? await extractMarkup(absPath, text) : await treeSitterExtract(absPath, text);
    if (!extraction) return;

    this.graph.clearFile(file);
    for (const d of extraction.defs) {
      const node: SymbolNode = {
        id: makeSymbolId(file, d.name, d.line),
        name: d.name,
        kind: d.kind,
        file,
        line: d.line,
        ...(d.endLine !== undefined ? { endLine: d.endLine } : {}),
        signature: d.signature,
        ...(d.doc ? { doc: d.doc } : {}),
      };
      this.graph.addSymbol(node);
    }
    for (const r of extraction.refs) {
      const ref: Ref = { file, line: r.line, confidence: "name-level" };
      this.graph.addRef(r.name, ref);
    }
    // Resolve relative imports to in-repo files → dependency edges (best-effort).
    for (const imp of extraction.imports) {
      const target = await resolveImportTarget(absPath, imp.spec);
      if (target) this.graph.addImport(file, asFileId(target));
    }

    let s = stamp;
    if (!s) {
      try {
        const st = await fs.stat(absPath);
        s = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        /* leave unset */
      }
    }
    if (s) this.manifest.set(file, s);
  }

  /**
   * Reconcile the graph with disk: re-index files whose size/mtime changed (or
   * are new), drop files that disappeared. First run (empty manifest) indexes
   * everything; later runs touch only what changed. Also notes every supported
   * file to the LSP so a warm (cache-restored) start can still answer `resolved`.
   */
  async refresh(): Promise<void> {
    const walked = await walkFiles(this.root, MAX_FILES);
    // The code graph is a search surface like any other: `definition`,
    // `references`, `relevant` and outline's folder rollup all read out of it. So
    // it must honour the same exclusion grep/glob/read_file do, or indexing becomes
    // the quiet way to surface a secret or another agent's data that every direct
    // route refuses. Filtered at the SOURCE rather than at each query, so a new
    // reader of the graph cannot forget it.
    const files = walked.files.filter((f) => !excludedFromSearch(f.abs));
    const seen = new Set<FileId>();
    for (const f of files) {
      // Note every file with a known language server — LSP precision can cover
      // languages tree-sitter can't parse (noteFile ignores unknown languages).
      this.lsp?.noteFile(f.abs);
      const lang = languageIdFor(f.abs);
      if (lang && this.lsp) this.langs.add(lang);

      // The bulk graph (outline + ranking) covers tree-sitter code + HTML/CSS markup.
      if (!isSupported(f.abs) && !isMarkupSupported(f.abs)) continue;
      const file = asFileId(f.abs);
      seen.add(file);

      let st;
      try {
        st = await fs.stat(f.abs);
      } catch {
        continue;
      }
      const prev = this.manifest.get(file);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue; // unchanged
      await this.indexFile(f.abs, { mtimeMs: st.mtimeMs, size: st.size });
    }
    // Files that vanished since last time.
    for (const file of [...this.manifest.keys()]) {
      if (!seen.has(file)) {
        this.graph.clearFile(file);
        this.manifest.delete(file);
      }
    }
    this.ready = true;
  }

  /** Build the whole project graph (the lane calls this in the background). */
  async build(): Promise<void> {
    await this.refresh();
  }

  /** Auto-install language servers for the project's languages that don't have
   *  one available yet (background, best-effort). No-op when LSP is disabled. */
  async ensureServers(log?: (m: string) => void): Promise<void> {
    if (!this.lsp) return;
    await ensureServers(this.langs, log);
  }

  // ── persistence (on-disk cache) ────────────────────────────────────────────
  /** Load a saved graph for this project; returns true if one was restored. */
  async loadFromCache(): Promise<boolean> {
    const snap = await loadCache(this.root);
    if (!snap) return false;
    for (const sym of snap.symbols) this.graph.addSymbol(sym);
    for (const [name, refs] of snap.refs) for (const r of refs) this.graph.addRef(name, r);
    for (const [from, tos] of snap.imports ?? []) for (const to of tos) this.graph.addImport(asFileId(from), asFileId(to));
    for (const [f, s] of snap.manifest) this.manifest.set(asFileId(f), s);
    this.ready = true; // usable immediately from cache while refresh runs
    return true;
  }

  saveToCache(): Promise<boolean> {
    const snapshot: Omit<ChassisSnapshot, "version"> = {
      manifest: [...this.manifest.entries()].map(([f, s]) => [f, s]),
      symbols: this.graph.allSymbols(),
      refs: [...this.graph.allRefs()].map(([n, r]) => [n, [...r]]),
      imports: this.graph.allImports(),
    };
    return saveCache(this.root, snapshot);
  }

  /** Keep the graph fresh in the background by reconciling every `ms`. */
  startReconcile(ms: number): void {
    if (this.timer || ms <= 0) return;
    this.timer = setInterval(() => {
      void this.refresh()
        .then(() => this.saveToCache())
        .catch(() => {});
    }, ms);
    // Don't let the interval keep the process alive on its own.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  // ── Chassis query API ─────────────────────────────────────────────────────
  async outline(absPath: string): Promise<readonly OutlineEntry[]> {
    return this.graph.outlineForFile(asFileId(absPath));
  }

  async definition(name: string): Promise<{ symbols: readonly SymbolNode[]; confidence: Confidence }> {
    // LSP first (compiler-accurate); fall back to the tree-sitter graph.
    if (this.lsp) {
      const hits = await this.lsp.symbols(name);
      if (hits.length) {
        const symbols: SymbolNode[] = hits.map((h) => {
          const file = asFileId(h.file);
          return { id: makeSymbolId(file, h.name, h.line), name: h.name, kind: h.kind, file, line: h.line };
        });
        return { symbols, confidence: "resolved" };
      }
    }
    return this.graph.definition(name);
  }

  async references(name: string): Promise<{ refs: readonly Ref[]; confidence: Confidence }> {
    if (this.lsp) {
      const hits = await this.lsp.symbols(name);
      if (hits.length) {
        const lsp = this.lsp;
        const refs = await collectLspReferences(hits, (f, l, c) => lsp.references(f, l, c));
        // A language server that located the symbol and reports no callers has
        // ANSWERED — the symbol is unused. Falling through to the graph here would
        // replace that correct answer with name-level string matches, which is how
        // an unused symbol acquires imaginary callers. Only an LSP that could not
        // find the symbol at all falls back.
        return { refs, confidence: "resolved" };
      }
    }
    return this.graph.references(name);
  }

  async relevant(focusFiles: readonly string[], limit = 25): Promise<readonly RankedSymbol[]> {
    const focus: FileId[] = focusFiles.map(asFileId);
    return rankSymbols(this.graph, focus, limit);
  }

  async span(name: string, opts: { path?: string; line?: number } = {}): Promise<readonly SymbolSpan[]> {
    const wantFile = opts.path ? asFileId(opts.path) : null;
    // Locate the symbol (LSP-resolved or graph) to know which file(s) hold it.
    const { symbols } = await this.definition(name);
    const locs: { file: FileId; kind: SymbolKind; line?: number }[] = symbols
      .filter((s) => !wantFile || s.file === wantFile)
      .map((s) => ({ file: s.file, kind: s.kind, line: s.line }));
    // A path was given but the symbol isn't in the map — still try that one file
    // directly, so read_symbol works even before the graph has indexed it.
    if (locs.length === 0 && wantFile) locs.push({ file: wantFile, kind: "other" });

    const out: SymbolSpan[] = [];
    const seen = new Set<string>();
    for (const loc of locs) {
      const near = opts.line ?? loc.line;
      // LSP documentSymbol range first (compiler-accurate), tree-sitter fallback.
      let range: LineSpan | null = null;
      let confidence: Confidence = "name-level";
      if (this.lsp) {
        range = await this.lsp.symbolRange(loc.file, name, near);
        if (range) confidence = "resolved";
      }
      // A single-line range is almost always a re-export or object-property entry
      // (e.g. `module.exports = { login }`), not the symbol's real body — so cross-check
      // the AST and prefer the LARGER span. This is what stops read_symbol returning one
      // useless line for a `const foo = () => { … }` whose name also appears in an
      // exports block. Also the plain fallback when there's no language server.
      if (!range || range.end <= range.start) {
        try {
          const code = await fs.readFile(loc.file, "utf8");
          const ast = isMarkupSupported(loc.file)
            ? await markupSpan(loc.file, code, name, near)
            : await treeSitterSpan(loc.file, code, name, near);
          if (ast && (!range || ast.end - ast.start > range.end - range.start)) {
            range = ast;
            if (confidence !== "resolved") confidence = "name-level";
          }
        } catch {
          /* unreadable — keep whatever the language server gave */
        }
      }
      if (!range) continue;
      const key = `${loc.file}:${range.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: loc.file, name, kind: loc.kind, start: range.start, end: range.end, confidence });
    }
    return out;
  }

  async directorySummary(absDir: string): Promise<DirectorySummary | null> {
    const dirId = asFileId(absDir);
    const files = this.graph.filesUnder(dirId);
    if (files.length === 0) return null;
    const fileSet = new Set(files);

    let symbolCount = 0;
    for (const f of files) symbolCount += this.graph.symbolsInFile(f).length;

    // Central symbols within the folder (rank personalized to its files); fall back
    // to the first few if ranking has nothing yet.
    const ranked = await this.relevant(files, 8);
    const topSymbols = ranked.length
      ? ranked.map((r) => r.symbol)
      : files.flatMap((f) => this.graph.symbolsInFile(f)).slice(0, 8);

    // Folders this one depends on: imports that leave the directory, by their folder.
    const deps = new Set<FileId>();
    for (const f of files) {
      for (const to of this.graph.dependencies(f)) {
        if (fileSet.has(to)) continue;
        const d = parentDir(to);
        if (d && d !== dirId) deps.add(d);
      }
    }
    return { dir: dirId, files: files.length, symbols: symbolCount, topSymbols, dependsOn: [...deps] };
  }

  async diagnostics(absPath: string): Promise<readonly CodeDiagnostic[]> {
    if (!this.lsp) return [];
    return this.lsp.diagnostics(absPath);
  }

  async dependents(absPath: string): Promise<readonly string[]> {
    // A FileId IS the absolute path, so this is a lookup rather than a conversion —
    // but it goes through asFileId anyway so the branded type is honored in one place
    // and a future change to that encoding cannot silently break the ripple check.
    return this.graph.dependents(asFileId(absPath)) as readonly string[];
  }

  status(): ChassisStatus {
    const c = this.graph.counts();
    return {
      ready: this.ready,
      files: c.files,
      symbols: c.symbols,
      resolvedLanguages: this.lsp ? [...this.langs] : [],
    };
  }

  /**
   * Stop background reconciling and shut language servers down gracefully
   * (LSP `shutdown` then `exit`, then the kill as a backstop). Use this whenever
   * there is still an event loop: session swap, removing a root, `/continue`.
   */
  async dispose(): Promise<void> {
    this.stopTimer();
    await this.lsp?.shutdown();
  }

  /**
   * The same teardown with no awaiting anywhere, for a process-exit handler.
   * Node runs no async work during `exit`, so the graceful path cannot be used
   * there and would silently do nothing.
   */
  disposeSync(): void {
    this.stopTimer();
    this.lsp?.dispose();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The underlying graph (used by the lane's watcher). */
  graphRef(): CodeGraph {
    return this.graph;
  }
}

/** The directory of a forward-slashed file id (as a FileId), or null at the root. */
function parentDir(file: FileId): FileId | null {
  const at = file.lastIndexOf("/");
  return at > 0 ? (file.slice(0, at) as FileId) : null;
}

/**
 * Every caller of every definition of a name, from a language server.
 *
 * Asks about ALL the definitions the server found, not just the first. A name
 * defined in several places (two classes with a `render`, a helper duplicated per
 * module) has several distinct sets of callers, and answering for an arbitrary one
 * while still claiming `resolved` is worse than the name-level answer it replaces:
 * it is both narrower AND more confident, and `resolved` is what suppresses the
 * "verify with grep" caveat. Deduped by file:line, since two definitions can share
 * a call site (an overload, a re-export).
 *
 * Pure apart from the injected lookup, so the fan-out is testable without a live
 * language server.
 */
export async function collectLspReferences(
  hits: readonly { file: string; line: number; character: number }[],
  lookup: (file: string, line: number, character: number) => Promise<readonly { file: string; line: number }[]>,
): Promise<Ref[]> {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    for (const l of await lookup(h.file, h.line, h.character)) {
      const key = `${l.file}:${l.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ file: asFileId(l.file), line: l.line, confidence: "resolved" });
    }
  }
  return refs;
}

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];

// TS ESM imports carry a `.js` extension that actually resolves to a `.ts` file
// (`import "./x.js"` → `x.ts`), so a `.js` specifier must also try its TS twin —
// otherwise a TypeScript project (like Mindweave's own) resolves zero import edges.
const JS_TS_TWIN: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Resolve a relative import spec to an existing in-repo file, or null. Bare
 *  package specifiers and unresolved paths return null — we only draw edges we
 *  can trust. */
async function resolveImportTarget(fromAbs: string, spec: string): Promise<string | null> {
  if (!spec.startsWith(".")) return null; // package / absolute module — skip
  const base = resolvePath(dirname(fromAbs), spec);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;

  const candidates: string[] = [];
  for (const twin of JS_TS_TWIN[ext] ?? []) candidates.push(stem + twin); // ./x.js → x.ts
  candidates.push(base); // a literal existing file (real .js/.py, or an exact path)
  if (!ext) for (const e of IMPORT_EXTS) candidates.push(base + e); // extensionless → try all
  for (const e of IMPORT_EXTS) candidates.push(resolvePath(base, "index" + e)); // directory index

  for (const c of candidates) {
    try {
      if ((await fs.stat(c)).isFile()) return c;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/** A no-op chassis used until the lane has built a real one (degrades to grep/read). */
export const NULL_CHASSIS: Chassis = {
  async outline() {
    return [];
  },
  async definition() {
    return { symbols: [], confidence: "name-level" };
  },
  async references() {
    return { refs: [], confidence: "name-level" };
  },
  async relevant() {
    return [];
  },
  async span() {
    return [];
  },
  async directorySummary() {
    return null;
  },
  async diagnostics() {
    return [];
  },
  async dependents() {
    return [];
  },
  status() {
    return { ready: false, files: 0, symbols: 0, resolvedLanguages: [] };
  },
};
