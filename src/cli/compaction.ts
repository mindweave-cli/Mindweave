/**
 * compaction.ts — how a compaction reports itself, as pure text (no React).
 *
 *   [████████████████████] 100%  context full
 *   ✔ Reclaimed 106K tokens (22K / 128K)
 *   [███░░░░░░░░░░░░░░░░░]  17%  context used
 *
 * Compaction is the one piece of background machinery worth showing. Everything else
 * Mindweave does to manage context is invisible on purpose, but a summarizing pass
 * REWRITES the conversation — the model will not remember the middle of it afterwards
 * — and a user who does not know that happened is left wondering why it forgot.
 *
 * ONE block, already settled. There is no "Compacting…" state that later fills in: the
 * before-figure is only interesting next to the after-figure, and a row that changes
 * under the reader is the exact transition the transcript design removes elsewhere.
 *
 * The numbers are the SAME arithmetic the compaction thresholds run on (transcript
 * estimate + measured overhead). That coupling is deliberate. If the estimate is off,
 * the bar is wrong in precisely the way the decision to compact was wrong, so what the
 * user sees is what the system actually believed — rather than a second, prettier
 * number that disagrees with the machinery.
 */
import { formatTokens } from "../dynamo/pricing.js";
import type { CompactionReport } from "../dynamo/contextWindow.js";

export type { CompactionReport };

/** Cells in a bar. Matches the reference design; shrinks only on a narrow terminal. */
const BAR_CELLS = 20;
const FULL = "█";
const EMPTY = "░";

/** A `[████░░░░]` bar for a fraction of the window (pure). Clamped, so a measurement
 *  that overshoots the window renders as full rather than overflowing the row. */
export function bar(used: number, window: number, cells = BAR_CELLS): string {
  const safeCells = Math.max(4, cells);
  const frac = window > 0 ? Math.min(1, Math.max(0, used / window)) : 0;
  // Round rather than floor, so a nearly-full context does not read as one cell short —
  // but never round UP to full while any room remains, which would say "full" wrongly.
  let filled = Math.round(frac * safeCells);
  if (frac < 1 && filled === safeCells) filled = safeCells - 1;
  if (frac > 0 && filled === 0) filled = 1; // and never show a used context as empty
  return `[${FULL.repeat(filled)}${EMPTY.repeat(safeCells - filled)}]`;
}

/** The percentage shown beside a bar (pure), right-aligned to three columns so the
 *  before/after pair line up whatever the digits. */
export function percent(used: number, window: number): string {
  const pct = window > 0 ? Math.round((used / window) * 100) : 0;
  return `${Math.min(100, Math.max(0, pct))}%`.padStart(4);
}

/**
 * The finished block, one string per row (pure).
 *
 * `width` shrinks the bars on a narrow terminal rather than letting a row wrap, since
 * a wrapped bar reads as two broken bars.
 */
export function compactionLines(r: CompactionReport, width = 80): string[] {
  // Row overhead: the two-space indent, the brackets, a space, four percent columns,
  // two spaces, and the label. Leave the bar whatever is left, within reason.
  const cells = Math.max(4, Math.min(BAR_CELLS, width - 26));
  const reclaimed = Math.max(0, r.before - r.after);
  // Labelled "before"/"after" rather than the reference's "Context Full"/"Context
  // Used". That wording only reads correctly when the pass ran at 100%, and `/compact`
  // can be typed at any moment — a bar showing 75% next to the words "context full"
  // is a caption contradicting the picture directly above it.
  return [
    `${bar(r.before, r.window, cells)} ${percent(r.before, r.window)}  before`,
    `✔ Reclaimed ${formatTokens(reclaimed)} tokens (${formatTokens(r.after)} / ${formatTokens(r.window)})`,
    `${bar(r.after, r.window, cells)} ${percent(r.after, r.window)}  after`,
  ];
}
