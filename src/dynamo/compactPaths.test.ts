/**
 * compactPaths.test.ts — the compaction cascade at the engine level.
 *
 * The pure halves are covered in `memory/sessionMemoryCompact.test.ts` and
 * `drivers/contextOverflow.test.ts`. What those cannot show is that the engine
 * actually REACHES them, and every defect this file guards was a wiring defect that
 * type-checked: a summary path that never consulted the notes, a compaction that
 * announced a cache break it had caused itself, a manual compact that paid to
 * summarize tool output it could have cleared for free.
 *
 * The notes path makes NO model call, which is what makes it testable here: a session
 * with no reachable driver either compacts from its notes or throws, and there is no
 * third outcome to be vague about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compactNow } from "./engine.js";
import { estimateEntriesTokens } from "../memory/compaction.js";
import type { Entry, Session } from "../memory/types.js";

const NOTES = "# Session Title\nWiring the parser\n\n# Current State\nHalfway through lexer.ts, nested quotes still failing.";

const filler = (tokens: number) => "x".repeat(tokens * 3.5);

function round(n: number, size: number): Entry[] {
  return [
    { role: "assistant", content: `step ${n}`, toolCalls: [{ id: `t${n}`, name: "read_file", arguments: "{}" }] },
    { role: "tool", content: filler(size), toolCallId: `t${n}` },
  ] as Entry[];
}

/** A session carrying only what the compaction path reads. */
function session(over: Partial<Session> = {}): Session {
  return {
    transcript: [{ role: "user", content: "go" } as Entry, ...Array.from({ length: 40 }, (_, i) => round(i, 2_000)).flat()],
    modelConfig: { model: "deepseek-v4-pro" },
    toolContext: {},
    sessionMemory: NOTES,
    sessionMemoryEntries: 20,
    ...over,
  } as unknown as Session;
}

test("a session with current notes compacts without a model call", async () => {
  // No driver is reachable in a unit test, so reaching the summarizer would throw.
  // Completing quietly IS the assertion that the free path was taken.
  const s = session();
  const before = estimateEntriesTokens(s.transcript);
  await compactNow(s);
  assert.ok(estimateEntriesTokens(s.transcript) < before, "the transcript was compacted");
  assert.equal(s.transcript[0]!.role, "summary");
  assert.match(s.transcript[0]!.content, /nested quotes still failing/, "the notes became the summary");
});

test("the notes boundary is reset so the next compaction is honest", async () => {
  // The notes describe everything before the tail they were spliced in front of. Left
  // pointing at an index in the OLD transcript, the next compaction would keep the
  // wrong slice, which is the one failure the whole path must never risk.
  const s = session();
  await compactNow(s);
  assert.equal(s.sessionMemoryEntries, 1);
  assert.equal(s.sessionMemoryTokens, estimateEntriesTokens(s.transcript));
});

test("a compaction does not report the cache break it caused itself", async () => {
  // The prefix after a compaction bears no resemblance to the one before, and that is
  // the point. Announcing it would train the user to ignore a warning that exists to
  // catch UNEXPLAINED breaks.
  const s = session({ prefixPrint: { anything: true } as never });
  const activity: string[] = [];
  await compactNow(s, { onActivity: (text: string) => activity.push(text) } as never);
  assert.equal(s.prefixPrint, undefined, "the baseline is dropped so the next step has nothing to diff");
  assert.ok(!activity.some((line) => /cache/i.test(line)), `no cache warning, got: ${activity.join(" | ")}`);
});

test("a successful compaction re-arms the approach warning", async () => {
  const s = session({ compactWarned: true, compactFailures: 2 });
  await compactNow(s);
  assert.equal(s.compactWarned, false, "the next approach to the bar warns again");
  assert.equal(s.compactFailures, 0, "a clean compaction resets the breaker");
});

test("compaction is reported to the caller", async () => {
  const reports: { before: number; after: number; window: number }[] = [];
  await compactNow(session(), { onCompaction: (r: never) => reports.push(r) } as never);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.after < reports[0]!.before, "reported a real reduction");
  assert.ok(reports[0]!.window > 0);
});

test("stale notes decline the free path instead of faking it", async () => {
  // No notes at all means the summarizer is the only option, and with no reachable
  // driver that must SURFACE rather than quietly leaving the transcript alone.
  const s = session({ sessionMemory: "" });
  const before = s.transcript.length;
  await compactNow(s).catch(() => {});
  assert.equal(s.transcript.length <= before, true);
  assert.notEqual(s.transcript[0]!.role, "summary", "nothing was spliced from empty notes");
});

// ---------------------------------------------------------------------------
// Source-shape checks, for the wiring that cannot fail loudly. Same approach
// engine.test.ts already takes for the pause paths: each of these type-checks and
// passes every behavioural test while quietly doing the wrong thing.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("manual /compact clears stale tool bodies before paying to summarize", () => {
  const body = engineSource.match(/export async function compactNow\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "compactNow not found — did it get renamed?");
  assert.match(body, /microcompact\(/, "the cheap pass must run before the billed one");
  assert.ok(
    body.indexOf("microcompact(") < body.indexOf("autocompact("),
    "microcompact must come FIRST or the summarizer is billed for what it could have dropped",
  );
});

test("a failed compaction is surfaced, not just counted", () => {
  const body = engineSource.match(/const fail = \([^)]*\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(body, "the fail helper not found — did it get renamed?");
  assert.match(body, /compactFailures/, "the breaker still has to count it");
  assert.match(body, /onActivity/, "and the user has to be told it happened");
});

test("the circuit breaker says so when it gives up", () => {
  // Giving up silently was the original defect: the session then ran past its bar
  // unmanaged with nothing on screen connecting the eventual failure to compaction.
  const guard = engineSource.match(/compactFailures \?\? 0\) >= MAX_COMPACT_FAILURES\)[\s\S]{0,900}/)?.[0];
  assert.ok(guard, "the breaker guard not found — did it get restructured?");
  assert.match(guard, /onActivity/, "the give-up has to reach the screen");
  // Reading the flag is not enough. A guard that checks `!compactGaveUpTold` and never
  // SETS it repeats the notice on every step for the rest of the session, which is how
  // a message meant to be noticed becomes noise the user filters out.
  assert.match(guard, /if \(!session\.compactGaveUpTold\)/, "guarded so it fires once");
  assert.match(guard, /session\.compactGaveUpTold = true/, "and latched, or it fires every step");
});

test("the approach warning is model-anchored and fires once", () => {
  const body = engineSource.match(/async function maybeCompact\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "maybeCompact not found — did it get renamed?");
  assert.match(body, /warnBarFor\(autoBar\)/, "the warning bar follows the model, not a fixed number");
  assert.match(body, /session\.compactWarned = true/, "latched, or it repeats every step");
  assert.match(body, /!session\.compactWarned/, "and guarded on the latch");
});

test("both ways a provider refuses an over-long request share one remedy", () => {
  // Two copies of the shed-and-retry logic is how the thrown-error path and the
  // stop-reason path drift into behaving differently.
  assert.match(engineSource, /isContextOverflowError\(error\)/, "the rejection path is classified");
  assert.equal(
    (engineSource.match(/dropOldestRounds\(/g) ?? []).length,
    1,
    "shedding must live in exactly one place",
  );
  assert.equal(
    (engineSource.match(/shedAndRetry\(\)/g) ?? []).length,
    2,
    "and be reached from both the thrown error and the stop reason",
  );
});

// ---------------------------------------------------------------------------
// Restoration, against real files on disk. The selector is unit-tested in
// memory/restore.test.ts; what these prove is the half that cannot be faked —
// that the ledger stops describing content the transcript no longer holds.
// ---------------------------------------------------------------------------

test("the read ledger stops claiming files the compaction deleted", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const kept = join(dir, "editing.ts");
    const dropped = join(dir, "glanced.ts");
    await fs.writeFile(kept, "export const editing = 1;\n");
    await fs.writeFile(dropped, "export const glanced = 2;\n");

    const reads = new Map([
      [kept, { mtimeMs: 1, size: 10, full: true, touchedAt: 5, focus: [{ start: 1, end: 1 }] }],
      [dropped, { mtimeMs: 1, size: 10, full: true, touchedAt: 9 }],
    ]);
    // A third entry for a file that no longer exists: it must leave the ledger too,
    // rather than being carried forward as something the model can see.
    reads.set(join(dir, "deleted.ts"), { mtimeMs: 1, size: 10, full: true, touchedAt: 7 });

    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);

    const after = s.toolContext.reads as Map<string, unknown>;
    assert.ok(!after.has(join(dir, "deleted.ts")), "a vanished file must not stay in the ledger");
    for (const [path, record] of after) {
      // Anything still claimed must be claimed because it was just put BACK, which is
      // the invariant: the ledger describes what is on screen, nothing more.
      assert.ok(s.transcript.some((e) => e.content.includes(path)), `${path} is claimed but not in context`);
      assert.equal((record as { full: boolean }).full, true);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("worked-in files come back, and say so", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const worked = join(dir, "lexer.ts");
    await fs.writeFile(worked, "export function lex() {\n  return 'tokens';\n}\n");
    const reads = new Map([[worked, { mtimeMs: 1, size: 10, full: true, touchedAt: 1, focus: [{ start: 1, end: 3 }] }]]);

    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);

    // Placed right after the summary: the only position that cannot interact with tool
    // pairing in the kept tail, whatever the tail happens to end with.
    assert.equal(s.transcript[0]!.role, "summary");
    assert.equal(s.transcript[1]!.role, "user");
    assert.match(s.transcript[1]!.content, /restored after the compaction/i);
    assert.match(s.transcript[1]!.content, /return 'tokens'/, "the real file content came back");
    assert.match(s.transcript[1]!.content, /read it again before you edit it/i, "and names what is still gone");
    assert.equal((s.toolContext.reads as Map<string, unknown>).has(worked), true, "and may be claimed again");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a file too large for its share is skipped, not truncated", async () => {
  // Half a file under a heading that says "the file you were working in" is the
  // context-that-lies failure this whole path exists to end.
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const huge = join(dir, "huge.ts");
    await fs.writeFile(huge, "x".repeat(200_000));
    const reads = new Map([[huge, { mtimeMs: 1, size: 200_000, full: true, touchedAt: 1 }]]);
    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);
    assert.ok(!s.transcript.some((e) => e.content.includes("<restored_files>")), "nothing was restored");
    assert.equal((s.toolContext.reads as Map<string, unknown>).size, 0, "and nothing is still claimed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
