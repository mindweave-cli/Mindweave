/**
 * sessionMemoryCompact.test.ts — compacting from the notes instead of paying for a
 * summary.
 *
 * The thing that must never happen here is a compaction that LOOKS like it worked:
 * notes that were never written, a boundary that does not describe this transcript, or
 * a result still over the bar. Each of those has to come back as a decline, because a
 * decline costs one summarizer call and the alternative costs the user their session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactFromSessionMemory, hasRealNotes, recentRoundsWithin, SM_KEEP_MIN_TOKENS } from "./sessionMemoryCompact.js";
import { SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import { estimateEntriesTokens } from "./compaction.js";
import type { Entry } from "./types.js";

/** Roughly 3.5 chars per token, so this is about `tokens` tokens of filler. */
const filler = (tokens: number) => "x".repeat(tokens * 3.5);

const NOTES = "# Session Title\nWiring the parser\n\n# Current State\nHalfway through lexer.ts, tests failing on nested quotes.";

/** One round: an assistant turn plus the tool result it produced. */
function round(n: number, size: number): Entry[] {
  return [
    { role: "assistant", content: `step ${n}`, toolCalls: [{ id: `t${n}`, name: "read_file", arguments: "{}" }] },
    { role: "tool", content: filler(size), toolCallId: `t${n}` },
  ] as Entry[];
}

function transcript(rounds: number, sizeEach: number): Entry[] {
  return [{ role: "user", content: "go" } as Entry, ...Array.from({ length: rounds }, (_, i) => round(i, sizeEach)).flat()];
}

test("the untouched template is not real notes", () => {
  assert.equal(hasRealNotes(SESSION_MEMORY_TEMPLATE), false, "the skeleton alone says nothing");
  assert.equal(hasRealNotes(""), false);
  assert.equal(hasRealNotes(undefined), false);
  assert.equal(hasRealNotes("# Current State\n_What is being worked on?_"), false, "headers and italics are template");
  assert.equal(hasRealNotes(NOTES), true);
});

test("whole rounds are taken from the end, never split", () => {
  const entries = transcript(6, 2_000);
  const kept = recentRoundsWithin(entries, 9_000);
  // A round is assistant + tool. An odd length would mean a tool result severed from
  // the call that produced it, which is a malformed request rather than a short one.
  assert.equal(kept.length % 2, 0, `kept ${kept.length} entries, so a round was split`);
  assert.equal(kept[0]!.role, "assistant", "a kept run starts at an assistant turn");
  assert.ok(estimateEntriesTokens(kept) <= 9_000 + 5_000, "stays near the budget");
  assert.ok(kept.length > 0);
});

test("the newest round is kept even when it alone busts the budget", () => {
  // Returning nothing would hand the model a summary and no working context at all.
  const kept = recentRoundsWithin(transcript(3, 50_000), 1_000);
  assert.ok(kept.length > 0, "never returns an empty tail");
});

test("a healthy session compacts from the notes with no model call", () => {
  const entries = transcript(40, 2_000);
  const result = compactFromSessionMemory(entries, NOTES, 20, 100_000, 0);
  assert.ok(result, "expected the notes path to take it");
  assert.equal(result.entries[0]!.role, "summary");
  assert.match(result.entries[0]!.content, /Halfway through lexer\.ts/, "the notes ARE the summary");
  assert.match(result.entries[0]!.content, /never happened/, "carries the resume prefix");
  assert.ok(estimateEntriesTokens(result.entries) < estimateEntriesTokens(entries), "actually smaller");
  assert.ok(estimateEntriesTokens(result.entries) <= 100_000, "under the bar it was given");
});

test("it declines rather than approximating", () => {
  const entries = transcript(40, 2_000);
  const target = 100_000;
  // No notes at all, and notes that are still the shipped skeleton.
  assert.equal(compactFromSessionMemory(entries, undefined, 20, target, 0), null, "no notes");
  assert.equal(compactFromSessionMemory(entries, SESSION_MEMORY_TEMPLATE, 20, target, 0), null, "template only");
  // No boundary: we cannot say which half of the transcript the notes describe, and
  // keeping the wrong half is the one failure this must never risk.
  assert.equal(compactFromSessionMemory(entries, NOTES, undefined, target, 0), null, "no boundary");
  assert.equal(compactFromSessionMemory(entries, NOTES, 0, target, 0), null, "zero boundary");
  // A boundary from a different, longer transcript.
  assert.equal(compactFromSessionMemory(entries, NOTES, entries.length + 5, target, 0), null, "boundary past the end");
});

test("it declines when the result would not get under the bar", () => {
  // The decisive check. A path that reported success while leaving the session over
  // its bar would suppress the summarizer AND the recovery behind it.
  const entries = transcript(40, 2_000);
  assert.equal(compactFromSessionMemory(entries, NOTES, 20, SM_KEEP_MIN_TOKENS - 1, 0), null, "bar below the minimum tail");
  // Same transcript, same notes, but everything outside the transcript eats the room.
  assert.equal(compactFromSessionMemory(entries, NOTES, 20, 60_000, 59_000), null, "overhead leaves no budget");
});

test("only the uncovered tail is kept, so nothing is paid for twice", () => {
  // The notes already describe entries 0..boundary. Keeping those verbatim as well
  // would mean the compaction reclaimed far less than it appears to.
  const entries = transcript(40, 2_000);
  const late = compactFromSessionMemory(entries, NOTES, entries.length - 4, 100_000, 0);
  const early = compactFromSessionMemory(entries, NOTES, 4, 100_000, 0);
  assert.ok(late && early);
  assert.ok(
    estimateEntriesTokens(late.entries) < estimateEntriesTokens(early.entries),
    "fresher notes leave less tail to keep",
  );
});
