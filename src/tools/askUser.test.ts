/**
 * askUser.test.ts — the ask_user clarification tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import type { Session } from "../memory/types.js";
import { askUserTool } from "./askUser.js";
import { APPROVAL_DISMISSED } from "./approval.js";
import { spawnSubagent } from "./subagent.js";
import { forkSession } from "../memory/session.js";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/proj", reads: new Map(), todos: [], ...over };
}

test("ask_user returns the user's choice via the approval channel", async () => {
  const asked: { q: string; o: string[] }[] = [];
  const res = await askUserTool.execute(
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    ctx({
      requestApproval: async (q, o) => {
        asked.push({ q, o });
        return "SQLite";
      },
    }),
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /The user chose: SQLite/);
  assert.deepEqual(asked, [{ q: "Which database?", o: ["Postgres", "SQLite"] }]);
});

test("ask_user without an approval channel tells the model to proceed on a default", async () => {
  const res = await askUserTool.execute(
    { question: "Which?", options: ["A", "B"] },
    ctx(),
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /best judgment|default/i);
});

test("dismissing the question is never reported as a choice", async () => {
  // Esc used to resolve with options[1], which is right for Yes/No/Defer and wrong for
  // arbitrary options: dismissing "Postgres or SQLite?" told the model the user had
  // chosen SQLite. A decision was attributed to someone who declined to make one.
  const res = await askUserTool.execute(
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    ctx({ requestApproval: async () => APPROVAL_DISMISSED }),
  );
  assert.equal(res.isError, undefined, "declining to answer is not a failure");
  assert.doesNotMatch(res.output, /The user chose/i, "no option may be reported as picked");
  assert.doesNotMatch(res.output, /SQLite/, "least of all the second one");
  assert.match(res.output, /dismissed/i);
  assert.match(res.output, /do not continue the work/i, "it must say to stop, not to carry on");
});

test("dismissing the question STOPS the turn", async () => {
  // Seen live: the user pressed Esc because none of the options fitted, and the model
  // answered "I'll go with the most reasonable default…" and kept working. It was obeying
  // this tool, which used to end its dismissal message with exactly that instruction.
  //
  // Wording could never have fixed it — nothing was stopping the model from continuing.
  // Someone dismissing a question is reaching for the keyboard, so the turn has to end
  // the way Esc ends it, and this asserts the stop rather than the sentence.
  let stopped = false;
  const res = await askUserTool.execute(
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    ctx({ requestApproval: async () => APPROVAL_DISMISSED, interrupt: () => void (stopped = true) }),
  );
  assert.equal(stopped, true, "the turn kept running after the question was dismissed");
  assert.doesNotMatch(res.output, /proceed with/i, "and it must not invite the model to carry on");
});

test("an ANSWERED question does not stop anything", async () => {
  // The other side. Interrupting on a real answer would end the turn the answer was
  // given to enable, which is the same fault pointing the other way.
  let stopped = false;
  const res = await askUserTool.execute(
    { question: "Which database?", options: ["Postgres", "SQLite"] },
    ctx({ requestApproval: async () => "Postgres", interrupt: () => void (stopped = true) }),
  );
  assert.equal(stopped, false, "answering the question stopped the turn");
  assert.match(res.output, /Postgres/);
});

test("a sub-agent cannot reach the user, and ask_user degrades instead of stalling", async () => {
  // forkSession spread the parent's context, which carried the approval channel, so a
  // read-only child could put a question on screen from an agent the user never saw
  // start. spawn_subagent's briefing advice depends on this being impossible.
  const parent = {
    id: "p", createdAt: 0, transcript: [], cwd: "/proj",
    toolContext: ctx({ requestApproval: async () => "Postgres" }),
  } as unknown as Session;
  const child = forkSession(parent, "go and look", { readOnly: true });
  assert.equal(child.toolContext.requestApproval, undefined, "the child inherited a way to ask");

  const res = await askUserTool.execute({ question: "Which?", options: ["A", "B"] }, child.toolContext);
  assert.equal(res.isError, undefined, "a child with no channel must not fail, it must proceed");
  assert.match(res.output, /best judgment|default/i);
  assert.match(spawnSubagent.description, /cannot ask the user anything/i);
});

test("ask_user requires a question and at least two options", async () => {
  assert.equal((await askUserTool.execute({ question: "", options: ["A", "B"] }, ctx())).isError, true);
  assert.equal((await askUserTool.execute({ question: "Q", options: ["only one"] }, ctx())).isError, true);
});
