/**
 * restore.ts — putting the model back where it was after a compaction.
 *
 * A compaction rewrites the transcript, so the file contents the model was working in
 * are gone from what it can see. Two separate things then go wrong, and only one of
 * them is about cost.
 *
 * THE CORRECTNESS ONE. The read ledger (`ctx.reads`) lives on the tool context, not in
 * the transcript, so it SURVIVES a compaction that deleted the contents it describes.
 * The read-before-edit gate consults it and cheerfully says "yes, you have read this
 * file" about a file the model can no longer see. The model then edits from whatever
 * snippet the summary happened to preserve. Nothing corrupts — a wrong `old_string`
 * fails to match — but the harness and the model disagree about what is on screen,
 * which is the same shape of defect as a working set that lists a file it dropped.
 * The fix is not to restore anything; it is to stop the ledger claiming what is no
 * longer true.
 *
 * THE SMOOTHNESS ONE. Having told the truth, the model must now re-read what it still
 * needs: one round trip per file, and a failed edit first if it guessed instead of
 * reading. Restoring a few files it was demonstrably mid-work in avoids that.
 *
 * WHY NOT SIMPLY THE MOST RECENT FILES. That is the obvious selector and it is a weak
 * one: a file opened once to check an import ranks equally with the file being edited.
 * This ledger carries better evidence — `focus` spans mark the regions the model has
 * been reading and editing, and `viaSearch` marks entries that were never really read
 * at all. Selecting on work rather than on recency is what lets a much smaller budget
 * pay for itself.
 *
 * Pure. Selection only: no file is opened here and no I/O is done.
 */
import type { ReadRecord } from "../tools/types.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Most files worth putting back. Past a handful this stops being "where I was" and
 *  becomes a second copy of the working set, which is what was removed for costing
 *  12K on every model call. */
export const RESTORE_MAX_FILES = env("MINDWEAVE_RESTORE_MAX_FILES", 5);

/** Per-file ceiling. A single large file must not spend the whole budget. */
export const RESTORE_MAX_TOKENS_PER_FILE = env("MINDWEAVE_RESTORE_FILE_TOKENS", 3_000);

/**
 * Total ceiling, before the model-anchored cap below is applied.
 *
 * 12K rather than the 50K a state-of-the-art client uses, and the difference is
 * arithmetic rather than taste. Restored content is written once and then carried in
 * the cached prefix for the rest of the session, so its cost is the write plus the
 * carry. At 50K that totals more than a dozen saved re-read round trips on every model
 * priced here — and since at most five files are restored, five round trips is the most
 * it can ever save. A 50K budget cannot break even at any hit rate. 12K breaks even at
 * roughly three of five.
 */
export const RESTORE_BUDGET_TOKENS = env("MINDWEAVE_RESTORE_BUDGET", 12_000);

/** Never let restoration take more than this share of the room compaction just made. */
const RESTORE_MAX_SHARE_OF_BAR = 0.15;

/** What restoration may spend for a given autocompact bar (pure). */
export function restoreBudgetFor(autoBar: number): number {
  return Math.min(RESTORE_BUDGET_TOKENS, Math.round(autoBar * RESTORE_MAX_SHARE_OF_BAR));
}

/** A file the model was working in, in the order it should be put back. */
export interface RestoreCandidate {
  readonly path: string;
  /** True when the ledger shows focused work (read or edited spans) in this file. */
  readonly worked: boolean;
}

/**
 * Choose which files to put back after a compaction (pure).
 *
 * `stillVisible` is what the kept tail already shows the model. Re-sending a file it
 * can see costs its full length and buys nothing; the same diff-against-what-survived
 * that a state-of-the-art client applies, and worth up to a whole budget on its own.
 */
export function selectForRestore(
  reads: ReadonlyMap<string, ReadRecord>,
  stillVisible: ReadonlySet<string> = new Set(),
  excluded: (path: string) => boolean = () => false,
  maxFiles: number = RESTORE_MAX_FILES,
): RestoreCandidate[] {
  const candidates: RestoreCandidate[] = [];
  for (const [path, record] of reads) {
    // A grep hit is not a read: it showed matching lines, never the file, so there is
    // no "content the model had" to put back.
    if (record.viaSearch) continue;
    // A ranged read never covered the whole file, so restoring it whole would hand the
    // model more than it ever had and quietly reset what it believes it has seen.
    if (!record.full) continue;
    if (stillVisible.has(path)) continue;
    if (excluded(path)) continue;
    candidates.push({ path, worked: (record.focus?.length ?? 0) > 0 });
  }

  const touchedAt = (path: string): number => reads.get(path)?.touchedAt ?? 0;
  // Worked-in files first, then by recency within each group. Recency alone is the
  // selector this deliberately avoids; it is used only to break ties.
  candidates.sort((a, b) => (a.worked === b.worked ? touchedAt(b.path) - touchedAt(a.path) : a.worked ? -1 : 1));
  return candidates.slice(0, maxFiles);
}

/** Wrap restored contents for the transcript (pure).
 *
 *  Says plainly that this is a restoration rather than something the model read, so it
 *  cannot mistake the block for its own earlier work, and states the one fact that
 *  makes the ledger reconciliation legible from the model's side: everything else it
 *  had open is gone and has to be read again. */
export function renderRestored(files: readonly { path: string; content: string }[]): string {
  const blocks = files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n\n");
  return (
    "The files you were working in, restored after the compaction above so you can " +
    "carry on without re-reading them. Any OTHER file you had open is no longer in " +
    "context: read it again before you edit it.\n\n" +
    `<restored_files>\n${blocks}\n</restored_files>`
  );
}
