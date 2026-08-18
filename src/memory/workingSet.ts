/**
 * workingSet.ts — the live "working set": the files the model is actively working on,
 * kept CURRENT in the volatile context tail every turn.
 *
 * This is the fix for the re-read storm. Instead of leaving file reads in the
 * transcript (where they go stale after an edit and get cleared by compaction — so the
 * model re-reads and "forgets"), we keep the files the model is working on re-read
 * fresh from disk each turn, at the END of the context (the boundary — best against
 * lost-in-the-middle). The model therefore always has the current content of what it's
 * editing and never needs to re-read it.
 *
 * The working CYCLE is the same for a 1-file task and a 50-file one: bounded ONLY by a
 * token budget, not an arbitrary file count. Within that budget the most-recent files
 * are shown in FULL; any that don't fit whole are LOCALIZED (outline + the regions the
 * model has focused on) rather than dropped — so a big task keeps every touched file's
 * structure, and full reads are reserved for what's actively being edited.
 *
 * The pure parts (selection, budgeting, rendering, line-numbering) are unit-tested;
 * `buildWorkingSet` does the disk/chassis I/O around them.
 */
import { promises as fs } from "node:fs";
import type { ReadRecord, ToolContext } from "../tools/types.js";
import type { FocusSpan } from "../tools/focus.js";
import type { OutlineEntry } from "../alternator/chassis/types.js";
import { chassisForPath } from "../tools/chassisMux.js";
import { relativize } from "../tools/paths.js";
import { estimateTokens } from "./compaction.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

/** Safety cap on how many touched files we even consider — NOT a "keep N" limit. The
 *  token budget + localization decide what actually fits; this only bounds work on a
 *  huge ledger so a long session doesn't stat hundreds of files each turn. */
export const WORKING_SET_MAX_CANDIDATES = env("MINDWEAVE_WORKINGSET_MAX_FILES", 40);
/**
 * Total token budget for the working-set block — the ONLY real limit on how many
 * files it holds (large ones are localized to fit, not dropped).
 *
 * WHY 8K AND NOT 20K. This block lives in the volatile tail, which is rebuilt on every
 * model STEP rather than once per turn, and sits after the newest content so none of it
 * is cache-eligible. At 20K a near-full working set was the single largest recurring
 * cost in a session: an eight-step turn re-sent it eight times at full price, which on a
 * premium provider outweighed the entire tool-schema question.
 *
 * Cutting it is safe because of what the budget does NOT govern. The most recently
 * touched file is admitted regardless of the budget (`firstFile` below), so the file
 * actually being worked on is never the one squeezed out. Files past the budget are not
 * forgotten either — they stay in the read ledger and a read of them still works; they
 * just stop being carried for free on every step.
 */
// Raised from 8,000 to 12,000 for one reason: a 300-400 line source or page file
// measures 8,900-9,900 tokens once line-numbered, so at 8,000 the single file being
// actively edited could not fit even with the whole budget to itself. The step-cost
// argument above still holds and is why this is 12,000 rather than the 20,000 it once
// was — it buys exactly one real file and no more. For comparison: Codex CLI restores
// 5 files at 5,000 each (50,000) after a compaction, and OpenCode protects a 40,000
// token zone outright, so this remains the tightest budget of the three by a wide margin.
export const WORKING_SET_TOKENS = env("MINDWEAVE_WORKINGSET_TOKENS", 12_000);
/** Above this many tokens, a single file is localized (outline + focus) not shown whole. */
const PER_FILE_MAX_TOKENS = env("MINDWEAVE_WORKINGSET_FILE_TOKENS", 6_000);

/**
 * Room held back from the most-recent file's LOCALIZED form when other files are active.
 *
 * The active file is exempt from the per-file cap so it can be held whole, and that
 * exemption is right — it is what stops every edit re-reading it. What was wrong was
 * that the exemption also applied to its localized form, which was itself unbounded, so
 * one big file could spend the entire budget on an outline plus regions: measured on a
 * real session, a 2,045-line stylesheet localized to 15,400 tokens against a 12,000
 * budget and the component being edited vanished from the block, silently.
 *
 * So the FULL form still gets the whole budget (nothing about holding the active file
 * whole changes), and only the localized fallback leaves a floor behind it.
 */
const RUNNER_UP_RESERVE = env("MINDWEAVE_WORKINGSET_RESERVE", 3_000);

/**
 * Outline entries one localized file may carry.
 *
 * A stylesheet's outline ran to 439 entries — 3,151 tokens, a quarter of the whole
 * budget, re-sent every step — because markup extraction emitted one symbol per selector
 * OCCURRENCE. That is fixed at the source in the chassis; this is the guard that keeps
 * any single file's structure from crowding out the content it exists to index.
 */
const OUTLINE_MAX_ENTRIES = env("MINDWEAVE_WORKINGSET_OUTLINE_ENTRIES", 120);

/** Room set aside for a localized block's own header, which is composed last (it has to
 *  report what actually fit) and so cannot be measured while the budget is being spent. */
const HEADER_ALLOWANCE = 80;

/** Below this many lines a trimmed focus region is not worth carrying — a handful of
 *  lines out of the middle of a file tells the model less than the outline already did. */
const MIN_REGION_LINES = 20;

export interface PreparedFile {
  path: string; // absolute (ledger key)
  display?: string; // project-relative label, for anything the model is told about
  block: string; // the rendered block for this file
  tokens: number;
  full: boolean; // true when the WHOLE current file is included (drives read short-circuit)
  /** The line ranges this block actually PUTS ON SCREEN. The whole file when `full`,
   *  otherwise the focus regions localizeBig chose. Derived from what was rendered, so
   *  a tool can prove the model is already looking at a span rather than assume it from
   *  the ledger — the ledger records what was read once, not what is visible now. */
  shown: FocusSpan[];
}

/** The most-recently-touched files, most-recent first, capped at `max`. Pure. */
export function selectActiveFiles(reads: Map<string, ReadRecord>, max: number): { path: string; record: ReadRecord }[] {
  return [...reads.entries()]
    .map(([path, record]) => ({ path, record }))
    .sort((a, b) => (b.record.touchedAt ?? 0) - (a.record.touchedAt ?? 0))
    .slice(0, max);
}

/** Line-numbered slice of `lines` for [from..to] (1-based, clamped). Pure. */
export function numberedRange(lines: string[], from: number, to: number): string {
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) out.push(`${String(i).padStart(width)}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

/**
 * Assemble the `<working_files>` block from prepared per-file blocks (most-recent
 * first) within a token budget. Returns the text and the set of paths whose FULL
 * content is included. Pure.
 *
 * Whatever is not shown is NAMED. The header tells the model these are the files it is
 * working on and not to re-read them, so a file missing from the block without a word is
 * a claim that is not true — and the model obeys it by not re-reading a file it cannot
 * see. The old count could not express that: it was `prepared.length - kept.length`, and
 * a file skipped for lack of room never reached `prepared`, so the block reported zero
 * omissions while the file being edited was absent from it.
 */
export function renderWorkingFiles(
  prepared: PreparedFile[],
  budget: number,
  omitted: readonly string[] = [],
): { text: string; fullPaths: Set<string>; shownSpans: Map<string, FocusSpan[]> } {
  const kept: PreparedFile[] = [];
  const missing = [...omitted];
  let used = 0;
  for (const f of prepared) {
    // The most-recent file is always kept; later ones are skipped rather than breaking
    // the loop, so a small file behind a large one still gets its place.
    if (kept.length > 0 && used + f.tokens > budget) {
      missing.push(f.display ?? f.path);
      continue;
    }
    kept.push(f);
    used += f.tokens;
  }
  // Built from KEPT only: a file prepared and then dropped for budget is not on screen,
  // and reporting it as visible is the one mistake that matters here.
  const shownSpans = new Map(kept.map((f) => [f.path, f.shown] as const));
  if (kept.length === 0) return { text: "", fullPaths: new Set(), shownSpans };

  const header =
    "These are the CURRENT contents of the files you're working on, kept up to date " +
    "automatically. Edit straight from them — do NOT re-read a file shown here.";
  const body = kept.map((f) => f.block).join("\n\n");
  const note = missing.length
    ? `\n\nNOT shown here, and not in your context — read ${missing.join(", ")} if you need ${
        missing.length === 1 ? "it" : "them"
      }.`
    : "";
  return {
    text: `${header}\n\n${body}${note}`,
    fullPaths: new Set(kept.filter((f) => f.full).map((f) => f.path)),
    shownSpans,
  };
}

/** The assembled block plus what it can prove about its own contents. */
export interface WorkingSetBlock {
  text: string;
  fullPaths: Set<string>;
  shownSpans: Map<string, FocusSpan[]>;
}

/**
 * A fingerprint of everything the block is derived from: which files are active, what
 * the model has focused on in each, and their state ON DISK right now.
 *
 * This is what lets the rebuild be skipped without giving up the freshness guarantee.
 * The block is assembled per model STEP so it can never go stale, and that matters more
 * than it looks: `run_command` can write files with no tool the engine could hook, so a
 * "was anything mutated?" flag would be wrong exactly when it counts. A stat of each
 * active file answers the same question from the filesystem instead, at a fraction of
 * the cost of re-reading and re-tokenizing them.
 */
async function diskKey(active: { path: string; record: ReadRecord }[]): Promise<string> {
  const parts = await Promise.all(
    active.map(async ({ path, record }) => {
      const focus = (record.focus ?? []).map((f) => `${f.start}-${f.end}`).join(",");
      try {
        const st = await fs.stat(path);
        return `${path}:${st.mtimeMs}:${st.size}:${focus}`;
      } catch {
        return `${path}:gone`;
      }
    }),
  );
  return parts.join("|");
}

/**
 * Build this turn's working-set block: read the current content of the active files
 * fresh from disk, keeping the freshest stat on the ledger (so read_file's
 * short-circuit compares correctly), localizing any file too big for its share.
 */
export async function buildWorkingSet(ctx: ToolContext): Promise<WorkingSetBlock> {
  const active = selectActiveFiles(ctx.reads, WORKING_SET_MAX_CANDIDATES);

  const key = await diskKey(active);
  const cached = ctx.workingSetCache;
  if (cached && cached.key === key) return cached.value;

  const prepared: PreparedFile[] = [];
  // Files that had to be left out. Threaded through to the block so the model is told,
  // rather than left to infer their absence from a header that says otherwise.
  const omitted: string[] = [];
  let used = 0;
  const contended = active.length > 1;

  for (const { path, record } of active) {
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      continue; // file gone since it was touched — skip
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = await fs.readFile(path, "utf8");
    } catch {
      continue;
    }
    if (looksBinary(content)) continue;

    // Keep the ledger's stat current so a later read of this file is recognized as
    // unchanged (the read short-circuit relies on matching mtime/size).
    ctx.reads.set(path, { ...record, mtimeMs: stat.mtimeMs, size: stat.size });

    const lines = content.split(/\r?\n/);
    const display = relativize(ctx, path);
    const fullBlock = `### ${display} (${lines.length} line${lines.length === 1 ? "" : "s"})\n${numberedRange(lines, 1, lines.length)}`;
    const fullTokens = estimateTokens(fullBlock);
    const firstFile = prepared.length === 0;
    const remaining = Math.max(0, WORKING_SET_TOKENS - used);
    // The active file may spend the whole budget on its FULL content; everything after it
    // pays the per-file cap. Its localized fallback is the one that leaves a floor.
    const share = firstFile ? remaining : Math.min(PER_FILE_MAX_TOKENS, remaining);
    const localShare = firstFile && contended ? Math.min(share, WORKING_SET_TOKENS - RUNNER_UP_RESERVE) : share;

    // Show the file's FULL content when it fits its share, LOCALIZED (outline + focused
    // regions) when it doesn't. Either way the file is REPRESENTED, so the cycle is the
    // same for a small task and a large one.
    if (fullTokens <= share) {
      prepared.push({
        path,
        display,
        block: fullBlock,
        tokens: fullTokens,
        full: true,
        shown: [{ start: 1, end: lines.length }],
      });
      used += fullTokens;
      continue;
    }

    // Localization is bounded by the share, and the share is by definition smaller than
    // the full form that failed to fit it — so localizing can no longer cost MORE than
    // showing the file whole. It used to: with nothing bounding it, a stylesheet whose
    // focus already spanned it localized to 15,354 tokens against a 12,060-token file,
    // because the outline was added on top of regions that already covered it. That is
    // prevented structurally here rather than detected afterwards.
    const local = await localizeBig(ctx, path, display, lines, record.focus, localShare);
    const localTokens = estimateTokens(local.block);

    if (used + localTokens <= WORKING_SET_TOKENS) {
      prepared.push({ path, display, block: local.block, tokens: localTokens, full: false, shown: local.shown });
      used += localTokens;
      continue;
    }
    omitted.push(display);
  }

  const block = renderWorkingFiles(prepared, WORKING_SET_TOKENS, omitted);
  ctx.workingSetCache = { key, value: block };
  return block;
}

/**
 * A large file's block: its structure, plus as many of the model's focused regions as
 * `budget` allows, and an honest statement of what that adds up to.
 *
 * Everything here is bounded, because an unbounded localization is what let one file
 * take the whole block. What does not fit is named rather than dropped in silence, and
 * the header reports the exact ranges held — without that the model cannot tell which
 * lines it already has, so it guesses an offset and reads blind.
 */
async function localizeBig(
  ctx: ToolContext,
  path: string,
  display: string,
  lines: string[],
  focus: FocusSpan[] | undefined,
  budget: number,
): Promise<{ block: string; shown: FocusSpan[] }> {
  const total = lines.length;
  const room = Math.max(0, budget - HEADER_ALLOWANCE);
  let used = 0;

  // Structure first: the cheapest thing that tells the model where to look.
  let outlineText = "";
  let outlineNote = "";
  const chassis = chassisForPath(ctx, path);
  if (chassis) {
    try {
      const entries = flattenOutline(await chassis.outline(path));
      if (entries.length > 0) {
        const kept = entries.slice(0, OUTLINE_MAX_ENTRIES);
        const text = "outline:\n" + kept.map((e) => e.text).join("\n");
        const cost = estimateTokens(text);
        if (cost <= room) {
          outlineText = text;
          used += cost;
          if (entries.length > kept.length) outlineNote += `, ${entries.length - kept.length} further symbols not listed`;
          // An outline that simply stops looks exactly like a complete one. A component
          // file's render body has no declarations in it, so the outline goes silent over
          // the part most likely to be edited — say where it actually reaches.
          const reach = kept[kept.length - 1]!.line;
          if (reach < total * 0.9) outlineNote += `, outline reaches L${reach} of ${total}`;
        }
      }
    } catch {
      /* no outline — fine */
    }
  }

  const render = (r: FocusSpan) => `lines ${r.start}-${r.end}:\n${numberedRange(lines, r.start, r.end)}`;

  // Each wanted region, and how far into it we ended up going. `held: null` means the
  // region is not on screen at all. Everything the header says is derived from this, so
  // the block's claims and its contents cannot drift apart however much trimming happens.
  const regions = (focus ?? []).map((s) => ({
    want: { start: Math.max(1, s.start - 2), end: Math.min(total, s.end + 2) },
    held: null as number | null,
  }));

  for (const r of regions) {
    const left = room - used;
    const cost = estimateTokens(render(r.want));
    if (cost <= left) {
      r.held = r.want.end;
      used += cost;
      continue;
    }
    // TRIM rather than drop. A region that does not fit whole is still worth its first
    // lines — dropping it left the block with a header and nothing in it, which is the
    // one outcome worse than showing less than was asked for.
    const perLine = Math.max(1, cost / (r.want.end - r.want.start + 1));
    const canFit = Math.floor(left / perLine);
    if (canFit < MIN_REGION_LINES) continue;
    r.held = Math.min(r.want.end, r.want.start + canFit - 1);
    used += estimateTokens(render({ start: r.want.start, end: r.held }));
  }

  const shownOf = () =>
    regions.filter((r) => r.held !== null).map((r) => ({ start: r.want.start, end: r.held! }));

  const compose = (): string => {
    const shown = shownOf();
    const missing = regions.flatMap((r) =>
      r.held === null ? [r.want] : r.held < r.want.end ? [{ start: r.held + 1, end: r.want.end }] : [],
    );
    const held = shown.length
      ? `holding lines ${shown.map((r) => `${r.start}-${r.end}`).join(", ")} of ${total}`
      : `structure only, no lines held`;
    const rest = missing.length
      ? ` Lines ${missing.map((r) => `${r.start}-${r.end}`).join(", ")} did not fit — read them if you need them.`
      : "";
    const body = [...(outlineText ? [outlineText] : []), ...shown.map(render)];
    const header =
      `### ${display} (${total} lines — too large to keep whole; ${held}${outlineNote}. ` +
      `Use read_symbol or a read_file range for anything else.)${rest}`;
    return [header, ...body].join("\n\n");
  };

  // Enforce the bound EXACTLY rather than trusting the allowance. The header cannot be
  // measured while the budget is being spent — it has to report what ended up fitting —
  // so any reserve for it is a guess, and overshooting by even seventy tokens meant the
  // whole file was dropped from the block. SHRINK, never drop: give back lines from the
  // last held region until it fits, and only let a region go once what is left of it is
  // too small to be worth carrying.
  let block = compose();
  for (let guard = 0; estimateTokens(block) > budget && guard < 24; guard++) {
    const last = [...regions].reverse().find((r) => r.held !== null);
    if (!last) {
      if (!outlineText) break; // nothing left to give back
      outlineText = "";
      outlineNote = "";
    } else {
      const over = estimateTokens(block) - budget;
      const lineCount = last.held! - last.want.start + 1;
      const perLine = Math.max(1, estimateTokens(render({ start: last.want.start, end: last.held! })) / lineCount);
      const give = Math.max(1, Math.ceil(over / perLine));
      const end = last.held! - give;
      last.held = end - last.want.start + 1 >= MIN_REGION_LINES ? end : null;
    }
    block = compose();
  }
  return { block, shown: shownOf() };
}

/** An outline flattened to one indented line per symbol, depth-first. */
function flattenOutline(entries: readonly OutlineEntry[], depth = 0): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (const e of entries) {
    out.push({ text: `${"  ".repeat(depth)}${e.kind} ${e.name} (L${e.line})`, line: e.line });
    if (e.children?.length) out.push(...flattenOutline(e.children, depth + 1));
  }
  return out;
}

/** A NUL byte in the first chunk is a cheap "not text" signal. */
function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 8192);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
  return false;
}
