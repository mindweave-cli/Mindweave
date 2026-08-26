/**
 * toolReveal.test.tsx — what a tool block actually PUTS ON SCREEN, frame by frame.
 *
 * This renders through Ink into a fake stdout and reads the text back, because
 * typecheck and reducer tests say nothing about what the user sees — the whole
 * defect this file exists to pin was a header that rendered without its body.
 *
 * The rule under test, in one line: a tool block appears ONCE, already complete,
 * and the only thing that ever changes afterwards is its verb.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box } from "ink";
import { BlockView } from "./components/BlockView.js";
import { Picker } from "./components/Picker.js";
import { ApprovalBox } from "./components/ApprovalBox.js";
import { clipRows } from "./wrap.js";
import { initialState, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { resultQueued, isGroupMember, groupSettled, planGroupReveal } from "./groupReveal.js";
import { narrationPending } from "./revealPace.js";

/** A stdout Ink will happily write frames into. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/** Render blocks and return the visible text of the final frame, ANSI stripped. */
function frameOf(blocks: Block[]): string {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  const app = render(
    <Box flexDirection="column">
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} columns={stdout.columns} />
      ))}
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false, interactive: true, exitOnCtrlC: false, debug: true },
  );
  const text = stdout.frames.join("").replace(ANSI, "");
  app.unmount();
  return text;
}

function run(actions: Action[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

/** Everything currently on screen, in order. */
function blocks(s: TranscriptState): Block[] {
  return [...s.committed, ...s.tail];
}

/**
 * The pacer's reveal decision, replayed here as the pure functions App.pump()
 * calls, so the sequence of FRAMES a real turn produces can be asserted without
 * mounting the whole app.
 *
 * The batching matters as much as the holding: Ink runs a legacy React root, so
 * each dispatch flushes synchronously and IS a frame. A batch therefore snapshots
 * once, at its end — mirroring applyBatch. A replay that snapshotted per action
 * would report intermediate frames the terminal never shows, and one that never
 * snapshotted mid-turn would miss the bare-header bug entirely.
 */
function screensDuring(queue: Action[]): string[] {
  let s = initialState();
  const frames: string[] = [];
  const q = [...queue];
  let groupOpen = false;
  let last = "";
  const apply = (batch: Action[]) => {
    for (const a of batch) s = reduce(s, a);
    const f = frameOf(blocks(s));
    if (f !== last) {
      frames.push(f);
      last = f;
    }
  };
  while (q.length > 0) {
    const head = q[0]!;
    // Narration in front of a tool call is sealed on its own beat, so the sentence
    // reaches the screen in its own frame. `toolStart` would otherwise seal it as
    // part of its own action and the two would land in one paint.
    if (head.type === "toolStart" && narrationPending(s)) {
      apply([{ type: "sealNarration" }]);
      groupOpen = false;
      continue;
    }
    // A new group's opening call is held until the model has moved past the burst,
    // then the whole burst lands as one frame.
    if (head.type === "toolStart" && head.group && !groupOpen) {
      if (planGroupReveal(groupSettled(q.slice(1)), false) === "hold") {
        // Nothing can advance until more actions arrive; in this replay the queue
        // is already complete, so a permanent hold would be a bug in the test.
        assert.fail("group held with a complete queue — it can never be revealed");
      }
      let n = 0;
      while (n < q.length && isGroupMember(q[n]!)) n++;
      apply(q.splice(0, n));
      groupOpen = false;
      continue;
    }
    // A standalone call is held until its own result is queued behind it, then the
    // pair lands as one frame.
    if (head.type === "toolStart" && !head.group) {
      const end = q.findIndex((x) => x.type === "toolEnd" && x.toolId === head.toolId);
      assert.notEqual(end, -1, "standalone tool held with a complete queue — it can never be revealed");
      apply(q.splice(0, end + 1));
      groupOpen = false;
      continue;
    }
    const a = q.shift()!;
    if (a.type === "toolStart" && a.group) groupOpen = true;
    else if (a.type !== "toolEnd") groupOpen = false;
    apply([a]);
  }
  return frames;
}

test("a discovery group is never on screen without its list — one frame, then only the verb moves", () => {
  // One read, exactly the case in the bug report: it used to show "Reading 1 file…"
  // with nothing under it, then a second later became "Read 1 file" plus the list.
  const turn: Action[] = [
    { type: "user", text: "look at runCommand" },
    { type: "toolStart", toolId: "t1", name: "Read", arg: "runCommand.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t1", ok: true, summary: "read src/tools/runCommand.ts (195 lines)" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  const withTool = frames.filter((f) => /Read/.test(f));
  assert.ok(withTool.length > 0, "the group must reach the screen");

  // THE regression guard: no frame may ever show the header alone. Every frame that
  // names the group also carries what it found.
  for (const f of withTool) {
    assert.match(f, /Reading 1 file|Read 1 file/);
    assert.match(f, /195 lines/, `header rendered without its body:\n${f}`);
  }

  // While the turn runs: present tense, list already there.
  const live = withTool[0]!;
  assert.match(live, /Reading 1 file/);
  assert.doesNotMatch(live, /Read 1 file/);

  // Turn ends: the SAME block, one word different.
  const ended = frameOf(blocks(reduce(run(turn), { type: "endTurn" })));
  assert.match(ended, /Read 1 file/);
  assert.doesNotMatch(ended, /Reading 1 file/);
  assert.match(ended, /195 lines/);

  // And nothing else moved — strip the verb and the two frames are identical.
  const norm = (f: string) => f.replace(/Reading 1 file|Read 1 file/, "<verb> 1 file");
  assert.equal(norm(ended), norm(live), "the block changed by more than its verb");
});

test("a group row prints its result once, not twice", () => {
  const s = run([
    { type: "toolStart", toolId: "t1", name: "Read", arg: "a.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t1", ok: true, summary: "read src/a.ts (195 lines)" },
  ]);
  const frame = frameOf(blocks(s));
  assert.equal(frame.match(/195 lines/g)?.length, 1, `result duplicated on the row:\n${frame}`);
});

test("a standalone tool arrives with its diff already under it, then settles its verb", () => {
  const turn: Action[] = [
    { type: "user", text: "fix the guard" },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "runCommand.ts", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, detail: "- if (ctx.backgroundShells) {\n+ if (isInteractive(cmd)) {" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  // No frame shows the row before its diff — the bare-header state is gone here too.
  for (const f of frames.filter((x) => /Updat/.test(x))) {
    assert.match(f, /isInteractive/, `edit row rendered without its diff:\n${f}`);
  }
  const live = frames.filter((f) => /Updat/.test(f))[0]!;
  assert.match(live, /Updating\(runCommand\.ts\)/);

  const ended = frameOf(blocks(reduce(run(turn), { type: "endTurn" })));
  assert.match(ended, /Update\(runCommand\.ts\)/);
  assert.doesNotMatch(ended, /Updating/);
  assert.match(ended, /isInteractive/);
});

test("a sentence and the tool row it introduces never land in the same frame", () => {
  // Streamed text renders nothing until it seals, and `toolStart` seals it as part
  // of its own action — so without a beat of its own the sentence and the row appear
  // in ONE paint and read as a single clump. The whole point of the tempo is that a
  // block arrives, is read, and then the next one arrives.
  const turn: Action[] = [
    { type: "user", text: "fix the guard" },
    { type: "token", delta: "The guard rejects before it looks. " },
    { type: "token", delta: "Reading the call site." },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "runCommand.ts", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, summary: "1 line changed" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  const said = /rejects before it looks/;
  const row = /Updat/;
  const together = frames.filter((f) => said.test(f) && row.test(f));
  const alone = frames.filter((f) => said.test(f) && !row.test(f));

  assert.ok(alone.length > 0, `the sentence never got a frame to itself:\n${frames.join("\n---\n")}`);
  // It stays on screen afterwards, of course — what must not exist is a frame where
  // it ARRIVES together with the row, i.e. the first frame showing it also has one.
  assert.ok(!together.includes(frames.find((f) => said.test(f))!), "the sentence arrived in the row's paint");
});

test("endTurn settles rows that already scrolled into committed, not just the live tail", () => {
  // The flip has to reach committed blocks, because every block is re-rendered each
  // frame (there is no <Static>) — a row that scrolled up mid-turn would otherwise
  // sit reading "Reading" forever.
  const s = run([
    { type: "toolStart", toolId: "e1", name: "Update", arg: "a.ts", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, summary: "1 line changed" },
    { type: "note", text: "moving on" }, // forces the drain into committed
  ]);
  assert.ok(s.committed.some((b) => b.kind === "tool"), "the row should have committed");
  assert.match(frameOf(blocks(s)), /Updating/);
  assert.match(frameOf(blocks(reduce(s, { type: "endTurn" }))), /Update\(a\.ts\)/);
  assert.doesNotMatch(frameOf(blocks(reduce(s, { type: "endTurn" }))), /Updating/);
});

test("a new turn's rows are live again while the previous turn's stay settled", () => {
  const first = reduce(
    run([
      { type: "toolStart", toolId: "e1", name: "Update", arg: "a.ts", action: "edit" },
      { type: "toolEnd", toolId: "e1", ok: true, summary: "1 line changed" },
    ]),
    { type: "endTurn" },
  );
  const second = run2(first, [
    { type: "user", text: "now b.ts" },
    { type: "toolStart", toolId: "e2", name: "Update", arg: "b.ts", action: "edit" },
    { type: "toolEnd", toolId: "e2", ok: true, summary: "2 lines changed" },
  ]);
  const frame = frameOf(blocks(second));
  assert.match(frame, /Update\(a\.ts\)/, "the finished turn's row must stay past-tense");
  assert.match(frame, /Updating\(b\.ts\)/, "the running turn's row must be present-tense");
});

function run2(s: TranscriptState, actions: Action[]): TranscriptState {
  return actions.reduce(reduce, s);
}

// ── the overlay's height, which is what made the app look hung ────────────────

/** Render a component and return its frame text, ANSI stripped. */
function renderFrame(node: React.ReactElement): string {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  const app = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
    exitOnCtrlC: false,
  });
  const text = stdout.frames.join("").replace(ANSI, "");
  app.unmount();
  return text;
}

test("a picker never grows past its row budget, however long its title", () => {
  // THE HANG. exit_plan passed a whole 40-step plan as the picker's title. The item
  // list was windowed; the title was not. The picker renders in the footer, so the
  // frame grew taller than the terminal, Ink switched to clearTerminal-and-redraw and
  // stopped tracking what it had written, and the screen tore — header stranded, no
  // input box, scrolling moving a sliver. From the outside it looked like a freeze.
  const plan = Array.from({ length: 40 }, (_, i) => `${i + 1}. do the thing number ${i + 1}`).join("\n");
  const frame = renderFrame(
    <Picker
      title={plan}
      items={[{ label: "Approve" }, { label: "Reject" }]}
      onSelect={() => {}}
      onCancel={() => {}}
      width={80}
      active={false}
    />,
  );
  const rows = frame.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(rows.length < 20, `overlay must stay small, rendered ${rows.length} rows:\n${frame}`);
  // And it must SAY it was cut, rather than quietly hiding what is being agreed to.
  assert.match(frame, /more lines above/);
  // The options still have to be usable — that is the whole point of the prompt.
  assert.match(frame, /Approve/);
  assert.match(frame, /Reject/);
});

// ── the approval box ─────────────────────────────────────────────────────────

function approvalFrame(question: string, options: string[], width = 74): string {
  return renderFrame(
    <ApprovalBox
      question={question}
      options={options}
      width={width}
      onSelect={() => {}}
      onCancel={() => {}}
      active={false}
    />,
  );
}

test("the approval box is bordered, spaced, and numbered", () => {
  const frame = approvalFrame("Start on this?", ["Approve", "Reject", "Change something"]);
  const lines = frame.split("\n").filter((l) => l.trim());

  // Bordered: it interrupts the user's work, so it must read as a stop, not as output.
  assert.match(frame, /┌.*┐/s);
  assert.match(frame, /└.*┘/s);
  // Numbered, so the decision can be made in one keystroke.
  assert.match(frame, /\[1\] Approve/);
  assert.match(frame, /\[3\] Change something/);
  assert.match(frame, /↑\/↓ or 1-3/);
  // The selected answer is marked, and only one is.
  assert.equal((frame.match(/›/g) ?? []).length, 1);
  // SPACING: a blank row between the question and the answers, and between the answers
  // and the hint — the thing being agreed to must not blur into the thing agreeing.
  const inner = lines.filter((l) => l.startsWith("│"));
  const blanks = inner.filter((l) => l.replace(/[│\s]/g, "") === "").length;
  assert.equal(blanks, 2, `expected two blank rows inside the border:\n${frame}`);
});

test("the approval box stays small when a caller passes a long question", () => {
  // Same failure mode as the picker: this draws in the footer, so unbounded height
  // tears the screen. Bounded here too rather than trusting every caller.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} of a question that should not be here`).join("\n");
  const frame = approvalFrame(long, ["Yes", "No"]);
  const rows = frame.split("\n").filter((l) => l.trim()).length;
  assert.ok(rows < 16, `overlay must stay small, rendered ${rows} rows`);
  assert.match(frame, /more lines above/);
  assert.match(frame, /\[1\] Yes/, "the answers must survive the clipping");
});

test("a notice renders as facts on a rail, verbatim, not as assistant prose", () => {
  // The permission block. It must not carry the assistant's plain ● or go through
  // markdown: these are literal commands, and `--force` or a backtick must appear
  // exactly as it will be run.
  const body = "Action: Shell execution\nCommand: $ git push origin main --force\nTool: run_command";
  const s = run([{ type: "notice", title: "Permission Request", body }]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /Permission Request/);
  assert.match(frame, /│ Action: Shell execution/);
  assert.match(frame, /│ Command: \$ git push origin main --force/, "the command must survive verbatim");
});

test("a command in a notice is never markdown-mangled", () => {
  const body = "Command: $ rm -rf _build && echo `date` *.log";
  const frame = frameOf(blocks(run([{ type: "notice", title: "Permission Request", body }])));
  assert.match(frame, /rm -rf _build && echo `date` \*\.log/, "backticks, asterisks and underscores stay literal");
});

// ── sub-agent topology ───────────────────────────────────────────────────────

test("one worker keeps its full rail", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "find every authFetch call site", readOnly: true },
    { type: "subToolStart", agentId: "a", toolId: "1", name: "Read", arg: "login.ts", action: "read" },
    { type: "subToolEnd", agentId: "a", toolId: "1", ok: true, summary: "Read login.ts (88 lines)" },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "3 steps · read-only" },
  ]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /◆ Subagent · read-only/);
  assert.match(frame, /Read login\.ts \(88 lines\)/, "with one worker there is room for its calls");
  assert.match(frame, /3 steps · read-only/);
});

test("several workers become a tree, and each branch says how far along it is", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "find every authFetch call site", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "draft unit tests for runCommand.ts", readOnly: false },
    { type: "subToolStart", agentId: "b", toolId: "1", name: "Read", arg: "runCommand.ts", action: "read" },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "4 steps · read-only" },
  ]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /◆ Subagents/);
  assert.match(frame, /2 delegated/);
  assert.match(frame, /├──/, "a branch for each worker…");
  assert.match(frame, /└──/, "…and an elbow on the last");
  // The finished one reports its summary; the running one is described by what it has
  // done so far, or a running branch would say nothing and read as stalled.
  assert.match(frame, /4 steps · read-only/);
  assert.match(frame, /working · 1 step/);
  // Which one may write is on the branch: it is the difference that matters most.
  assert.match(frame, /#1 · read-only/);
  assert.doesNotMatch(frame, /#2 · read-only/);
});

test("the topology shows only what a sub-agent actually reports", () => {
  // The reference design labels each worker with a model and an "isolated 8k window".
  // A sub-agent carries neither, so putting them on screen would be decoration that
  // reads as fact.
  const s = run([
    { type: "subagentStart", agentId: "a", task: "one", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "two", readOnly: true },
  ]);
  const frame = frameOf(blocks(s));
  assert.doesNotMatch(frame, /window/i);
  assert.doesNotMatch(frame, /\d+k\b/i, "no invented context budget");
});

test("clipRows counts rendered rows, not newlines", () => {
  // One long line is several rows on screen. Counting newlines would call this
  // single-line title "short" and let it blow the frame anyway.
  const oneLongLine = "x".repeat(1000);
  assert.ok(clipRows(oneLongLine, 40, 6).length <= 6);
  // A short title passes through untouched, with no "more lines" noise.
  assert.deepEqual(clipRows("Start on this?", 80, 6), ["Start on this?"]);
});

test("a resumed session opens with settled verbs, not work that looks in flight", () => {
  // showResumed replays a finished session through these same actions, so every row
  // it creates is born `live`. Seen for real: a resumed chat opened showing
  // "Updating(App.tsx)" over an edit that had completed in a previous process.
  const replayed: Action[] = [
    { type: "user", text: "add the pomodoro timer" },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "App.tsx", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, summary: "-3 +63" },
    { type: "sealNarration" },
  ];
  assert.match(frameOf(blocks(run(replayed))), /Updating/, "born live — this is what showResumed produces");
  // …which is why showResumed must finish with endTurn.
  const settled = frameOf(blocks(reduce(run(replayed), { type: "endTurn" })));
  assert.match(settled, /Update\(App\.tsx\)/);
  assert.doesNotMatch(settled, /Updating/);
});
