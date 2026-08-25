/**
 * subagentCost.test.ts — what a sub-agent must NOT spend on the user's behalf.
 *
 * A child runs the same turn loop as its parent, so anything the loop does at the end
 * of a turn, it does too. That is right for the work and wrong for the bookkeeping: a
 * child's transcript is discarded the moment it reports back, so anything written to
 * describe it is paid for and thrown away.
 *
 * The one that mattered is the session notes, which cost a real model call with the
 * child's recent transcript as input. Measured: a 20-step research worker reaches the
 * threshold at ~9.8K tokens, so it fired on any substantial child — and a five-way
 * fan-out paid it five times, invisibly, for notes nothing kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "../dynamo/engine.js";
import { forkSession } from "./session.js";
import { estimateEntriesTokens } from "./compaction.js";
import { shouldUpdateSessionMemory } from "./sessionMemory.js";
import type { Session } from "./types.js";

/** Every request the provider receives, so an EXTRA call is visible as a count. */
const bodies: string[] = [];
let server: Server;

test("start the stand-in provider", async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const SEP = String.fromCharCode(10, 10);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "done" } }] }) + SEP);
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }) +
          SEP,
      );
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.MINDWEAVE_GEMINI_URL = `http://127.0.0.1:${port}`;
});

/** A transcript long enough that the notes would fire on it. */
function longTranscript() {
  const entries: unknown[] = [{ role: "user", content: "find every call site" }];
  for (let i = 0; i < 20; i++) {
    entries.push({ role: "assistant", content: "" });
    entries.push({ role: "tool", toolCallId: `c${i}`, content: "src/a.ts:12 hit\n".repeat(120) });
  }
  return entries;
}

function parent(root: string): Session {
  return {
    id: "parent",
    cwd: root,
    createdAt: Date.now(),
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    transcript: longTranscript(),
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [] },
  } as unknown as Session;
}

test("the transcript used here really would trigger the notes", () => {
  // If this stops being true the test below passes for the wrong reason.
  const tokens = estimateEntriesTokens(longTranscript() as never);
  assert.ok(
    shouldUpdateSessionMemory(tokens, 0, false),
    `a ${tokens}-token child no longer crosses the notes threshold — this test proves nothing`,
  );
});

test("a sub-agent does not spend a model call writing notes nobody keeps", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-subcost-")));
  const child = forkSession(parent(root), "find every call site");
  // A fork starts the child with ONE entry — its task. The state that matters is the
  // child PART WAY THROUGH its own run, with its own tool results piled up, which is
  // where the threshold is actually crossed. Seeded directly, because getting there via
  // the stand-in provider would mean scripting twenty tool rounds to prove one call.
  child.transcript = longTranscript() as never;

  bodies.length = 0;
  await respond(child);

  // One call for the turn itself. A second would be the notes.
  assert.equal(bodies.length, 1, `the child made ${bodies.length} model calls; the extra one is the notes`);
  assert.equal(child.sessionMemory ?? "", "", "a child wrote session notes that are discarded with it");
});

test("the MAIN session still writes its notes", async () => {
  // The guard must be about being a CHILD, not about the notes being switched off.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-subcost-main-")));
  bodies.length = 0;
  await respond(parent(root));
  assert.ok(bodies.length >= 2, "the main session stopped maintaining its notes");
});

test("stop the stand-in provider", () => void server.close());
