/**
 * backgroundNotes.test.ts — a finished background shell is announced ONCE.
 *
 * The bug this pins was found by reading a real 293-entry session. One `cargo check`
 * exited 101; the model then spent 19 of the next 37 steps re-explaining that same
 * finished command, while doing unrelated work in between. It was not looping — 71 of
 * its 71 commands were distinct — it was answering the same news over and over because
 * the harness kept re-delivering it.
 *
 * The cause was consumer-side. `drainEvents()` is carefully one-shot at the PRODUCER, so
 * the event was only ever produced once; but the drained array was captured before the
 * step loop and re-attached to the END of every request inside it. A message sitting last
 * in the conversation reads as "the user just said this" — every step, forever.
 *
 * What makes this testable is POSITION, not count: both before and after the fix a given
 * request contains the note once. The difference is whether it stays pinned to the end.
 * So these assertions are about where it sits on the second and later calls of one turn,
 * which is the only place the defect was ever visible.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { BackgroundShells } from "../tools/backgroundShells.js";
import type { Session } from "../memory/types.js";

let requests: { messages: { role: string; content?: string }[] }[] = [];
let toolRounds = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push({ messages: [] });
      }
      // A harmlessly-failing tool call for the first `toolRounds` rounds, then an answer.
      // What a round needs to contribute here is a well-formed tool RESULT, so the turn
      // takes another step; whether the tool succeeded is irrelevant.
      const call = toolRounds-- > 0;
      const frames = call
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "not_a_real_tool", arguments: "" } }],
                  },
                },
              ],
            },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ]
        : [
            { choices: [{ delta: { content: "done" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${port}`;
});

after(() => void server.close());

const NODE = process.execPath;
const DETACH = process.platform !== "win32";

function session(shells: BackgroundShells): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-bgnote-")));
  return {
    cwd: root,
    transcript: [{ role: "user", content: "go" }],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false, backgroundShells: shells },
  } as unknown as Session;
}

/** Run a command to completion in the background, so a real event is pending. */
async function finishedShell(): Promise<BackgroundShells> {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('BUILD_OUTPUT'); process.exit(101)"], { detached: DETACH });
  mgr.adopt(child, { command: "cargo check", cwd: process.cwd() });
  const start = Date.now();
  while (mgr.list()[0]!.status === "running") {
    if (Date.now() - start > 5000) throw new Error("the shell never finished");
    await new Promise((r) => setTimeout(r, 20));
  }
  return mgr;
}

/** Every message of a request, as `role:content`, so position is visible. */
function shape(request: { messages: { role: string; content?: string }[] }): string[] {
  return request.messages.map((m) => `${m.role}:${(m.content ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
}

const isNote = (m: { role: string; content?: string }): boolean =>
  m.role === "user" && (m.content ?? "").includes("Background shell #");

test("the note is delivered once and does not stay pinned to the end of every call", async () => {
  requests = [];
  toolRounds = 3;
  const mgr = await finishedShell();
  const s = session(mgr);

  await respond(s, {});

  assert.ok(requests.length >= 3, `expected several model calls, saw ${requests.length}`);

  // It reached the model at all.
  const carrying = requests.filter((r) => r.messages.some(isNote));
  assert.ok(carrying.length > 0, "the finished shell was never reported to the model");

  // THE REGRESSION: on every call after the one that introduced it, the note must have
  // conversation after it — the assistant's reply and the tool result. Pinned last on
  // each call is what made the model answer it again and again.
  for (let i = 1; i < requests.length; i++) {
    const msgs = requests[i]!.messages;
    const at = msgs.findIndex(isNote);
    if (at === -1) continue;
    assert.ok(
      at < msgs.length - 1,
      `call ${i}: the background note is the LAST message again — it will read as fresh news.\n${shape(requests[i]!).join("\n")}`,
    );
  }

  // And it is never duplicated within one call.
  for (const [i, r] of requests.entries()) {
    const count = r.messages.filter(isNote).length;
    assert.ok(count <= 1, `call ${i} carried the same background note ${count} times`);
  }

  mgr.dispose(true);
});

test("it becomes part of the conversation, not a per-request attachment", async () => {
  // Pushing it into the transcript is what makes delivery exactly-once at the consumer
  // as well as the producer: it is carried forward like any other message instead of
  // being re-attached, and it survives for the model to refer back to.
  requests = [];
  toolRounds = 2;
  const mgr = await finishedShell();
  const s = session(mgr);

  await respond(s, {});

  const inTranscript = s.transcript.filter(
    (e) => e.role === "user" && typeof e.content === "string" && e.content.includes("Background shell #"),
  );
  assert.equal(inTranscript.length, 1, "the note should be exactly one transcript entry");
  assert.equal(
    (inTranscript[0] as { synthetic?: boolean }).synthetic,
    true,
    "it is harness-generated, so it must be marked synthetic like the ripple note",
  );
  assert.match(String(inTranscript[0]!.content), /BUILD_OUTPUT/, "the output tail rode along with it");

  mgr.dispose(true);
});

test("a turn with nothing in the background adds no notes at all", async () => {
  requests = [];
  toolRounds = 1;
  const mgr = new BackgroundShells();
  const s = session(mgr);

  await respond(s, {});

  assert.equal(
    s.transcript.filter((e) => e.role === "user" && String(e.content).includes("Background shell #")).length,
    0,
    "a quiet session must not grow synthetic entries",
  );
  mgr.dispose(true);
});
