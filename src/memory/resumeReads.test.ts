/**
 * resumeReads.test.ts — /continue remembers what the model has already read.
 *
 * The ledger lives on the tool context, so a resumed session began with it empty while
 * the transcript still carried whole files the model could see. Everything downstream
 * then disagreed with the screen: the write gate refused a file whose contents were three
 * messages up, and the model re-read it — appending a SECOND full copy to the transcript.
 *
 * That compounds. Each resume added another copy, so every `/continue` replayed a larger
 * transcript than the last, with a cold cache, and took longer than the last. These pin
 * the fix and the safety rule that keeps it honest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullReadPaths, writtenPaths } from "./presence.js";
import type { Entry } from "./types.js";

/** A transcript in which the model read `path` in full, as the store records it. */
function transcriptReading(path: string, content: string): Entry[] {
  return [
    { role: "user", content: "look at it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }],
    },
    { role: "tool", toolCallId: "c1", content, fullContentOf: [path] },
  ] as unknown as Entry[];
}

test("a file read in the previous session is recognised from the transcript", () => {
  // The evidence was always there — it simply was not being read on resume.
  const entries = transcriptReading("C:/proj/page.html", "<html>…</html>");
  const found = fullReadPaths(entries, (p) => p);
  assert.ok(found.has("C:/proj/page.html"), "the transcript's own record of the read was ignored");
});

test("a partial read does NOT count as having seen the file", () => {
  // The write gate exists to stop a blind overwrite. A ranged read is not the file.
  const entries = [
    { role: "user", content: "peek" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "C:/proj/page.html", offset: 1, limit: 5 }) },
        },
      ],
    },
    { role: "tool", toolCallId: "c1", content: "five lines" },
  ] as unknown as Entry[];
  assert.equal(fullReadPaths(entries, (p) => p).size, 0);
});

test("the freshness rule: a file touched while away must not be trusted", async () => {
  // The one case that makes restoring dangerous rather than merely helpful. The copy in
  // the transcript is a snapshot; if the file moved on since, opening the gate would let
  // the model replace something it has an out-of-date view of.
  const dir = await mkdtemp(join(tmpdir(), "mw-resume-"));
  const file = join(dir, "page.html");
  await writeFile(file, "<html>original</html>");

  const savedAt = Date.now();
  // Edited after the session was saved.
  const later = new Date(savedAt + 60_000);
  await utimes(file, later, later);

  const { stat } = await import("node:fs/promises");
  const st = await stat(file);
  assert.ok(st.mtimeMs > savedAt, "the fixture did not actually age the file");

  // The rule restoreReadLedger applies, stated here so it cannot drift: newer than the
  // save means re-read it.
  const trusted = st.mtimeMs <= savedAt;
  assert.equal(trusted, false, "a file changed while away would have been trusted");
});

test("an untouched file IS trusted, which is the whole point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-resume-"));
  const file = join(dir, "steady.html");
  await writeFile(file, "<html>unchanged</html>");

  const { stat } = await import("node:fs/promises");
  const st = await stat(file);
  const savedAt = st.mtimeMs + 60_000; // the session was saved after the file was written
  assert.equal(st.mtimeMs <= savedAt, true, "an untouched file would still be re-read");
});

// ── The three gaps found by reading a real implementation ────────────────────

test("a file the model WROTE last session counts as seen", () => {
  // The gap that was still open after the first cut: only reads were restored, so a file
  // the model itself created was refused by the write gate on the next /continue and
  // re-read — appending another whole copy, which is the cost this exists to remove.
  const entries = [
    { role: "user", content: "make it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "C:/proj/new.html", content: "<html>" }) },
      ],
    },
    { role: "tool", toolCallId: "w1", content: "wrote 40 lines" },
  ] as unknown as Entry[];
  assert.ok(writtenPaths(entries, (p) => p).has("C:/proj/new.html"));
});

test("an edit counts too — it could only have followed a read", () => {
  const entries = [
    { role: "user", content: "tweak it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "e1", name: "edit", arguments: JSON.stringify({ path: "C:/proj/a.css" }) },
      ],
    },
    { role: "tool", toolCallId: "e1", content: "1 edit applied" },
  ] as unknown as Entry[];
  assert.ok(writtenPaths(entries, (p) => p).has("C:/proj/a.css"));
});

test("a write that FAILED is not a file the model has seen", () => {
  // Claiming it would open the write gate on a file nobody ever saw.
  const entries = [
    { role: "user", content: "make it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "C:/proj/nope.html" }) },
      ],
    },
    { role: "tool", toolCallId: "w1", content: "Error: refused", isError: true },
  ] as unknown as Entry[];
  assert.equal(writtenPaths(entries, (p) => p).size, 0);
});

test("a read is not mistaken for a write", () => {
  const entries = transcriptReading("C:/proj/page.html", "<html>…</html>");
  assert.equal(writtenPaths(entries, (p) => p).size, 0);
});

test("entries carry a stamp, so freshness is judged per file", () => {
  // Without a per-entry time everything is compared against one session-wide moment, and
  // a file touched after the model read it but before the session closed looks fresh.
  const stamped = { role: "user", content: "hi", ts: 1_700_000_000_000 } as unknown as Entry;
  assert.equal(stamped.ts, 1_700_000_000_000);
  // Absent on older sessions, and that must remain loadable rather than reading as zero.
  const old = { role: "user", content: "hi" } as unknown as Entry;
  assert.equal(old.ts, undefined);
});

test("saving stamps every entry, once, and never rewrites an existing stamp", async () => {
  // The stamp is what makes freshness per-file. Done at the single serialize point rather
  // than at the eighteen places that append to a transcript, and FIRST SAVE WINS so the
  // time recorded is when the entry was written, not when it was last persisted.
  const { saveSession, loadTranscript } = await import("./store.js");
  const { mkdtemp: make, rm } = await import("node:fs/promises");
  const dir = await make(join(tmpdir(), "mw-stamp-"));
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    const older = 1_700_000_000_000;
    const session = {
      id,
      cwd: dir,
      createdAt: Date.now(),
      transcript: [
        { role: "user", content: "already stamped", ts: older },
        { role: "assistant", content: "fresh" },
      ],
      toolContext: { cwd: dir },
      projectMemory: "",
      memoryDir: join(dir, "memory"),
      memoryIndex: "",
      priorSessions: 0,
      projectContext: "",
      governance: { rules: [], skills: [], forbidden: [] },
      modelConfig: { model: "test-model" },
    } as unknown as Parameters<typeof saveSession>[0];

    await saveSession(session);
    const back = await loadTranscript(dir, id);
    assert.ok(back, "the transcript did not come back");
    assert.equal(back[0]?.ts, older, "an existing stamp was overwritten");
    assert.equal(typeof back[1]?.ts, "number", "a new entry was saved without a stamp");

    // Saving again must not move anything.
    const second = back[1]!.ts;
    await saveSession(session);
    const again = await loadTranscript(dir, id);
    assert.equal(again?.[1]?.ts, second, "re-saving rewrote history");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
