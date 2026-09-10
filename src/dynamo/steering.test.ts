/**
 * steering.test.ts — a message typed mid-turn reaches THAT turn, not the next one.
 *
 * `messageQueue.test.ts` proves which messages are eligible and `engine.test.ts` pins
 * the framing and the placement in source. Neither can prove the thing that actually
 * matters: that the message is on the wire of the NEXT model call of the SAME turn. The
 * whole feature is that timing, and the timing is only observable from the request.
 *
 * So this drives a real turn against a local stand-in provider and reads what it was
 * sent. There is no driver stub in this codebase; pointing a real driver at a server
 * that answers immediately is the honest way to run the loop.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptedMessage, respond, steeredMessage, type SteeredMessage } from "./engine.js";
import type { Session } from "../memory/types.js";

/** Every request body the provider saw, in order. */
let requests: { messages: { role: string; content?: string }[] }[] = [];
/** How many rounds should carry a tool call before the model answers. */
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
      // A tool call for the first `toolRounds` requests, then a plain answer. The tool
      // is one that fails harmlessly: what this test needs from a round is a well-formed
      // tool RESULT to append a user message after, not a successful one.
      const call = toolRounds-- > 0;
      const frames = call
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: "call_1", type: "function", function: { name: "not_a_real_tool", arguments: "" } },
                    ],
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

function session(): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-steer-")));
  return {
    cwd: root,
    transcript: [{ role: "user", content: "go" }],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false },
  } as unknown as Session;
}

/** A `steer` that hands over `texts` the first time it is asked, and nothing after. */
function steerOnce(texts: string[]): { steer: () => Promise<SteeredMessage[]>; calls: () => number } {
  let calls = 0;
  return {
    steer: async () => {
      calls++;
      return calls === 1 ? texts.map((content) => ({ content })) : [];
    },
    calls: () => calls,
  };
}

/** The user messages of one request, in order. */
function userTexts(request: { messages: { role: string; content?: string }[] }): string[] {
  return request.messages.filter((m) => m.role === "user").map((m) => m.content ?? "");
}

test("a message typed mid-turn is on the wire of the NEXT call of the SAME turn", async () => {
  requests = [];
  toolRounds = 2;
  const s = session();
  const { steer } = steerOnce(["actually use the other file"]);

  await respond(s, { steer });

  // Three calls: the first two carried tool calls, the third answered. The message was
  // handed over after the first round, so it must be in the second request — the whole
  // point being that it did NOT wait for the turn to end.
  assert.ok(requests.length >= 2, `expected at least two model calls, saw ${requests.length}`);
  const second = userTexts(requests[1]!).join("\n");
  assert.match(second, /actually use the other file/, "the message did not reach the running turn");
});

test("it goes out FRAMED, so the model knows it arrived mid-work", async () => {
  requests = [];
  toolRounds = 1;
  const s = session();
  const { steer } = steerOnce(["skip the tests"]);

  await respond(s, { steer });

  const sent = userTexts(requests[1]!);
  assert.ok(
    sent.some((t) => t === steeredMessage("skip the tests")),
    "a steered message reached the model as bare text, with nothing saying when it arrived",
  );
});

test("the transcript keeps what was TYPED, not the framing", async () => {
  requests = [];
  toolRounds = 1;
  const s = session();
  const { steer } = steerOnce(["skip the tests"]);

  await respond(s, { steer });

  const steered = s.transcript.filter((e) => e.role === "user" && e.arrival === "steered");
  assert.equal(steered.length, 1, "the entry is missing or was not marked as steered");
  assert.equal(
    (steered[0] as { content: string }).content,
    "skip the tests",
    "the framing was stored, so /continue would replay it as something the user typed",
  );
});

test("it lands after the round's tool result, never between a call and its result", async () => {
  // The wire rule every provider enforces. Read from the request itself rather than from
  // the source, because this is the one that fails as a rejected request in production.
  requests = [];
  toolRounds = 1;
  const s = session();
  const { steer } = steerOnce(["and skip the tests"]);

  await respond(s, { steer });

  const roles = requests[1]!.messages.map((m) => m.role);
  const lastTool = roles.lastIndexOf("tool");
  const steeredAt = requests[1]!.messages.findIndex((m) => (m.content ?? "").includes("and skip the tests"));
  assert.ok(lastTool >= 0, "the round did not produce a tool result to place it after");
  assert.ok(steeredAt > lastTool, "the steered message was placed among the tool results");
});

test("two messages typed together stay two messages, in order", async () => {
  requests = [];
  toolRounds = 1;
  const s = session();
  const { steer } = steerOnce(["stop editing that", "look at the parser instead"]);

  await respond(s, { steer });

  const steered = s.transcript.filter((e) => e.role === "user" && e.arrival === "steered") as { content: string }[];
  assert.deepEqual(
    steered.map((e) => e.content),
    ["stop editing that", "look at the parser instead"],
    "messages were merged, reordered, or dropped",
  );
});

test("nothing is appended when nothing was typed", async () => {
  // Every round asks. A round that appended an empty message would put a blank user turn
  // between every pair of tool rounds, and pay for it on each call.
  requests = [];
  toolRounds = 2;
  const s = session();
  const before = s.transcript.length;

  await respond(s, { steer: async () => [] });

  const added = s.transcript.slice(before).filter((e) => e.role === "user" && e.arrival === "steered");
  assert.deepEqual(added, []);
});

test("a steer that throws does not take the turn down with it", async () => {
  // The caller resolves attachments against the disk to answer, so this can fail for
  // reasons that have nothing to do with the turn — a dropped file deleted since it was
  // typed. The work in flight must survive it.
  requests = [];
  toolRounds = 1;
  const s = session();

  const reply = await respond(s, {
    steer: async () => {
      throw new Error("the file is gone");
    },
  });

  assert.equal(reply, "done", "a failure in the caller's resolver ended the turn");
});

test("the turn is not asked to steer on the round it answers", async () => {
  // A round with no tool calls returns before the drain: the turn is over, and what is
  // queued then is the next request rather than a steer. Asking anyway would append a
  // message to a conversation that is about to be handed back to the caller, and the
  // caller would send it a second time.
  requests = [];
  toolRounds = 2;
  const { steer, calls } = steerOnce([]);

  await respond(session(), { steer });

  assert.equal(calls(), 2, `asked ${calls()} times for ${2} tool rounds`);
});

// ── the interrupt tier: sent AFTER Esc, so it opens a turn instead of joining one ──

test("a message sent after an interrupt is put to the model as an interrupt", async () => {
  // The turn it follows was cut off half way through a round of tools. Without this the
  // message reads as if it had always been the request, and the model resumes the work
  // the user pressed a key to stop.
  requests = [];
  toolRounds = 1;
  const s = session();
  s.transcript.push({ role: "user", content: "no, leave that alone", arrival: "interrupting" });

  await respond(s);

  const sent = requests[0]!.messages.filter((m) => m.role === "user").map((m) => m.content ?? "");
  assert.ok(
    sent.some((t) => t === interruptedMessage("no, leave that alone")),
    "an interrupting message reached the model bare, so nothing said the work was stopped",
  );
  assert.ok(
    !sent.some((t) => t === steeredMessage("no, leave that alone")),
    "it was framed as a steer, which tells the model to finish what it was stopped from doing",
  );
});

test("its transcript entry is the raw text too", async () => {
  requests = [];
  toolRounds = 0;
  const s = session();
  s.transcript.push({ role: "user", content: "start over", arrival: "interrupting" });

  await respond(s);

  const entry = s.transcript.find((e) => e.role === "user" && e.arrival === "interrupting") as { content: string };
  assert.equal(entry.content, "start over", "the framing was stored rather than applied on the wire");
});
