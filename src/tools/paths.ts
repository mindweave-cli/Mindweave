/**
 * paths.ts — the one place tools turn a model-supplied path into a real one.
 *
 * Every file tool takes a path from the model that may be absolute or relative,
 * and must resolve it against the *session* working directory (`ctx.cwd`), not
 * Node's `process.cwd()` — because `run_command` can move the session's cwd with
 * `cd`, and a later read/edit must follow it. Keeping this in one helper means
 * every tool resolves paths the same way.
 */
import { promises as fs, realpath as realpathCb } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolContext } from "./types.js";

/**
 * The OS's own realpath, not Node's JS reimplementation, and the difference is
 * load-bearing on Windows.
 *
 * `fs.realpath` resolves symlinks but leaves an 8.3 SHORT path exactly as it found
 * it, so `C:\Users\RUNNER~1\...` and `C:\Users\runneradmin\...` both survive as
 * distinct strings for one directory. The native call expands short names to their
 * real on-disk form (and fixes the casing), which is what makes the two comparable.
 *
 * This is not exotic: Windows generates a short name for any component over eight
 * characters, so it happens to every user whose account name is longer than that.
 * An eleven-character account name such as a CI runner's `runneradmin` hits it on the
 * first path it builds, while a short one never can — which is exactly the kind of
 * difference between two machines that this function exists to erase.
 *
 * There is no `.native` on the promises API, so the callback form is promisified.
 */
const realpathNative = promisify(realpathCb.native);
import { addFocus } from "./focus.js";
import { noteScopePath } from "../governor/scope.js";

/**
 * Resolve a directory to its PHYSICAL path, following symlinks.
 *
 * Every root and every recorded cwd goes through this once, on the way in, so the
 * whole session speaks one form of every path.
 *
 * Why it has to exist: `run_command` records where a command ended up using
 * `pwd -P`, which is physical. macOS puts a great deal behind symlinks — `/tmp` is
 * `/private/tmp`, and `os.tmpdir()` sits under `/private/var` — so a session opened
 * at a logical path and a cwd read back as a physical one describe the same
 * directory with different strings. Nothing compares equal after that: the session
 * appears to have moved on a command that never ran `cd`, and because the recorded
 * cwd is then no longer under the session root, `relativize` gives up and every path
 * the model sees turns absolute.
 *
 * Canonicalising both sides is the fix, and it belongs here rather than at the call
 * site: this module is already the one place a path becomes real.
 *
 * Degrades to the input when the path cannot be resolved (it may not exist yet), so
 * this can be applied unconditionally.
 */
export async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpathNative(path);
  } catch {
    return path;
  }
}

/**
 * The session's roots, primary first. A single-root session is the common case;
 * `/include` adds more (e.g. a backend + a frontend). Falls back to the live cwd
 * when none are set (bare test contexts), so single-root behavior is unchanged.
 */
export function rootsOf(ctx: ToolContext): string[] {
  return ctx.roots && ctx.roots.length > 0 ? ctx.roots : [ctx.cwd];
}

/**
 * The immutable session anchor — the primary root, which never moves. `run_command`
 * shifts `ctx.cwd` with `cd`, but the anchor stays put, so file tools resolve relative
 * paths against a fixed base instead of a shell cwd that may have wandered into a
 * subdirectory. File tools never follow the shell cwd;
 * without it, a `cd src-tauri` before a build makes a later `edit("App.css")`
 * resolve to `…/src-tauri/App.css` and fail "file not found" on a file that plainly
 * exists — the exact bug this decoupling kills.
 */
export function anchorOf(ctx: ToolContext): string {
  return rootsOf(ctx)[0]!;
}

/** True when more than one root is in play — the only time paths carry a label. */
export function isMultiRoot(ctx: ToolContext): boolean {
  return rootsOf(ctx).length > 1;
}

/**
 * A short, unique label for a root — its folder name, disambiguated with the
 * parent folder if two roots share a name (`api/server` vs `web/server`). Labels
 * are how a path stays collision-proof across roots: every displayed path is
 * `label/relative`, and that exact string resolves back to the right root.
 */
export function rootLabel(roots: string[], root: string): string {
  const base = basename(root) || root;
  const collides = roots.some((r) => r !== root && (basename(r) || r) === base);
  return collides ? `${basename(dirname(root))}/${base}` : base;
}

/** The root that contains `abs`, or null when it's outside every root. */
function containingRoot(roots: string[], abs: string): string | null {
  for (const root of roots) {
    const rel = relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return root;
  }
  return null;
}

/**
 * Resolve a model-supplied path to an absolute path. Absolute paths pass through;
 * a relative path resolves against the fixed session anchor (NOT the shell cwd, which
 * `run_command` may have moved with `cd`) — UNLESS it's `label/…` for a known added
 * root, which resolves under that root (so the model can reach any root by name without
 * juggling absolute paths).
 */
export function resolvePath(ctx: ToolContext, raw: string): string {
  if (isAbsolute(raw)) return resolve(raw);
  const roots = rootsOf(ctx);
  if (roots.length > 1) {
    const norm = raw.split("\\").join("/");
    const slash = norm.indexOf("/");
    const head = slash >= 0 ? norm.slice(0, slash) : norm;
    const rest = slash >= 0 ? norm.slice(slash + 1) : "";
    for (const root of roots) {
      if (rootLabel(roots, root) === head) return resolve(root, rest);
    }
  }
  return resolve(anchorOf(ctx), raw);
}

/**
 * A short, display-friendly form of an absolute path. Single-root: relative to the
 * live cwd (or absolute when outside it). Multi-root: `label/relative` so a path is
 * never ambiguous between roots — and that string round-trips back through
 * `resolvePath`.
 */
export function relativize(ctx: ToolContext, abs: string): string {
  const roots = rootsOf(ctx);
  if (roots.length <= 1) {
    // Relative to the fixed anchor, not the moving shell cwd — so a path displays the
    // same regardless of where a `cd` left the shell, and run_command's "in <dir>" line
    // shows the shell's location as a clean subpath of the root (e.g. `src-tauri`).
    const rel = relative(anchorOf(ctx), abs);
    if (rel === "") return ".";
    return rel.startsWith("..") ? abs : rel.split("\\").join("/");
  }
  const root = containingRoot(roots, abs);
  if (!root) return abs; // outside all roots — show it absolute
  const rel = relative(root, abs);
  const label = rootLabel(roots, root);
  return rel === "" ? label : `${label}/${rel.split("\\").join("/")}`;
}

/** One place for a search tool to look: a root and an optional subpath within it
 *  (`""` = the whole root). */
export interface SearchUnit {
  root: string;
  /** Subpath relative to `root`, POSIX-separated; `""` means the whole root. */
  sub: string;
}

/**
 * Decide what a search tool should scan. With an explicit `path`, that one target
 * (resolved, then expressed as root + subpath so output can be labeled). Without
 * one: every root in a multi-root session (so "search" means "search everywhere"),
 * or just the live cwd in the single-root case (unchanged behavior).
 */
export function searchUnits(ctx: ToolContext, rawPath: string | undefined): SearchUnit[] {
  const roots = rootsOf(ctx);
  if (rawPath && rawPath !== ".") {
    const abs = resolvePath(ctx, rawPath);
    const root = containingRoot(roots, abs) ?? ctx.cwd;
    const rel = relative(root, abs);
    return [{ root, sub: rel === "" ? "" : rel.split("\\").join("/") }];
  }
  if (roots.length > 1) return roots.map((root) => ({ root, sub: "" }));
  return [{ root: ctx.cwd, sub: "" }];
}

/**
 * Tell the governor this session has worked in `absPath`, firing any glob-scoped rule
 * that matches it.
 *
 * Called wherever a file enters the read ledger, which is the definition of "the
 * session touched this". Deliberately separate from `ctx.reads` itself: the ledger is
 * cleared at a compaction and this must not be, so the two are written together and
 * forgotten apart.
 *
 * A no-op when the session has no governance or no scope (a sub-agent, a test), and
 * cheap when it has no glob-scoped rules — see scope.ts.
 */
export function markScope(ctx: ToolContext, absPath: string): void {
  const scope = ctx.ruleScope;
  const rules = ctx.governance?.rules;
  if (!scope || !rules || rules.length === 0) return;
  noteScopePath(scope, rules, ctx.governance!.forbidden.root, absPath);
}

/** Monotonic clock for read/edit recency (drives the working set's LRU ordering). */
let touchClock = 0;
export function nextTouch(): number {
  return ++touchClock;
}

/** Bump a tracked file's recency (and optionally record a focused line span) without
 *  changing its read state. Used by tools that re-touch a file they already track. */
export function touch(ctx: ToolContext, absPath: string, focus?: { start: number; end: number }): void {
  const rec = ctx.reads.get(absPath);
  if (!rec) return;
  rec.touchedAt = nextTouch();
  if (focus) rec.focus = addFocus(rec.focus, focus);
}

/**
 * Record that a file was just written/edited. It satisfies the read-before-edit gate
 * (the path is now tracked) and updates recency + the focused region. Marked
 * `full: false`: an edit hands the model only a WINDOW, not the whole file — the
 * working set, not this record, is the source of truth for "the model has the current
 * content." (Marking it `full: true` here is what caused the re-read storm: a later
 * full read got wrongly deduped, so the model paged the file in ranges instead.)
 */
export async function recordWrite(
  ctx: ToolContext,
  absPath: string,
  focus?: { start: number; end: number },
): Promise<void> {
  const prev = ctx.reads.get(absPath);
  markScope(ctx, absPath);
  const base = { full: false, touchedAt: nextTouch(), focus: addFocus(prev?.focus, focus) };
  try {
    const st = await fs.stat(absPath);
    ctx.reads.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, ...base });
  } catch {
    ctx.reads.set(absPath, { mtimeMs: 0, size: 0, ...base });
  }
}
