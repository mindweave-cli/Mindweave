/**
 * restore.test.ts — choosing what to put back after a compaction.
 *
 * The selector is the whole argument for this feature paying for itself. Recency alone
 * ranks a file opened once to check an import equally with the file being edited, and a
 * five-file restore selected that way cannot earn back its carry. Every assertion here
 * is about preferring evidence of WORK over evidence of recency, and about the three
 * kinds of ledger entry that describe content the model never actually had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_BUDGET_TOKENS,
  renderRestored,
  restoreBudgetFor,
  selectForRestore,
} from "./restore.js";
import type { ReadRecord } from "../tools/types.js";

const rec = (over: Partial<ReadRecord> = {}): ReadRecord => ({ mtimeMs: 1, size: 100, full: true, touchedAt: 1, ...over });

test("a file with focused work outranks a more recent casual read", () => {
  // The point of the whole selector. `imports.ts` was touched last; `editing.ts` is
  // where the model has actually been working.
  const reads = new Map<string, ReadRecord>([
    ["/p/editing.ts", rec({ touchedAt: 10, focus: [{ start: 40, end: 80 }] })],
    ["/p/imports.ts", rec({ touchedAt: 99 })],
  ]);
  assert.deepEqual(
    selectForRestore(reads).map((c) => c.path),
    ["/p/editing.ts", "/p/imports.ts"],
  );
});

test("recency only breaks ties within a group", () => {
  const reads = new Map<string, ReadRecord>([
    ["/p/old-work.ts", rec({ touchedAt: 1, focus: [{ start: 1, end: 9 }] })],
    ["/p/new-work.ts", rec({ touchedAt: 50, focus: [{ start: 1, end: 9 }] })],
    ["/p/old-read.ts", rec({ touchedAt: 2 })],
    ["/p/new-read.ts", rec({ touchedAt: 60 })],
  ]);
  assert.deepEqual(
    selectForRestore(reads).map((c) => c.path),
    ["/p/new-work.ts", "/p/old-work.ts", "/p/new-read.ts", "/p/old-read.ts"],
  );
});

test("entries describing content the model never had are excluded", () => {
  const reads = new Map<string, ReadRecord>([
    // A grep showed matching lines, never the file. Restoring it would hand the model
    // content it never saw and quietly satisfy a read-before-edit gate.
    ["/p/grepped.ts", rec({ viaSearch: true, focus: [{ start: 1, end: 2 }] })],
    // A ranged read never covered the whole file, so putting the whole thing back is
    // more than the model ever had.
    ["/p/ranged.ts", rec({ full: false, focus: [{ start: 1, end: 2 }] })],
    ["/p/real.ts", rec()],
  ]);
  assert.deepEqual(selectForRestore(reads).map((c) => c.path), ["/p/real.ts"]);
});

test("a file the kept tail still shows is not sent twice", () => {
  // Re-sending what survived the compaction costs its full length and buys nothing.
  const reads = new Map<string, ReadRecord>([["/p/a.ts", rec()], ["/p/b.ts", rec()]]);
  assert.deepEqual(
    selectForRestore(reads, new Set(["/p/a.ts"])).map((c) => c.path),
    ["/p/b.ts"],
  );
});

test("excluded paths are honoured", () => {
  // MINDWEAVE.md is reloaded from disk on the same path, so restoring it would put the
  // same bytes in twice.
  const reads = new Map<string, ReadRecord>([["/p/MINDWEAVE.md", rec()], ["/p/a.ts", rec()]]);
  const picked = selectForRestore(reads, new Set(), (p) => /MINDWEAVE\.md$/i.test(p));
  assert.deepEqual(picked.map((c) => c.path), ["/p/a.ts"]);
});

test("the file count is capped", () => {
  const reads = new Map<string, ReadRecord>(
    Array.from({ length: 30 }, (_, i) => [`/p/f${i}.ts`, rec({ touchedAt: i })] as const),
  );
  assert.equal(selectForRestore(reads).length, 5);
  assert.equal(selectForRestore(reads, new Set(), () => false, 2).length, 2);
});

test("an empty or unusable ledger selects nothing", () => {
  assert.deepEqual(selectForRestore(new Map()), []);
  assert.deepEqual(selectForRestore(new Map([["/p/a.ts", rec({ viaSearch: true })]])), []);
});

test("the budget never takes back a large share of the room compaction just made", () => {
  // Restoration exists to carry the model over the boundary, not to refill the context
  // it just cleared. On a small bar the share binds; on a large one the absolute cap does.
  assert.equal(restoreBudgetFor(20_000), 3_000, "a small bar gets a proportional budget");
  assert.equal(restoreBudgetFor(223_000), RESTORE_BUDGET_TOKENS, "a large bar is capped absolutely");
  for (const bar of [20_000, 107_000, 171_000, 223_000, 299_000]) {
    assert.ok(restoreBudgetFor(bar) <= bar * 0.15 + 1, `budget must stay a minority of the bar (${bar})`);
    assert.ok(restoreBudgetFor(bar) > 0);
  }
});

test("the restored block says what it is and what is still missing", () => {
  // Without the second half the model has no way to know that the files NOT listed are
  // gone, which is the exact ambiguity the ledger reconciliation exists to remove.
  const text = renderRestored([{ path: "/p/a.ts", content: "export const a = 1;" }]);
  assert.match(text, /restored after the compaction/i);
  assert.match(text, /read it again before you edit it/i);
  assert.match(text, /<file path="\/p\/a\.ts">/);
  assert.match(text, /export const a = 1;/);
});
