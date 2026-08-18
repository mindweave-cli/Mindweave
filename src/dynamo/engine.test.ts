/**
 * engine.test.ts — stopReasonNote (pure) + the pause paths' one structural rule.
 *
 * The full agent loop isn't unit-tested here (it needs a live session and tool
 * context), but the wording shown to the user when a turn ends early is pure and
 * worth pinning: every non-"end" StopReason must produce a distinct, honest
 * explanation, so a truncated reply is never confused with a refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stopReasonNote } from "./engine.js";
import type { StopReason } from "../drivers/types.js";

test("every early-stop reason gets its own, distinct explanation", () => {
  const reasons: Exclude<StopReason, "end">[] = ["truncated", "refused", "overflow", "overloaded"];
  const notes = reasons.map(stopReasonNote);
  assert.equal(new Set(notes).size, reasons.length, "two different reasons produced the same wording");
  for (const note of notes) assert.ok(note.length > 0);
});

test("truncated and overloaded both read as incomplete, but name a different cause", () => {
  const truncated = stopReasonNote("truncated");
  const overloaded = stopReasonNote("overloaded");
  assert.match(truncated, /incomplete/);
  assert.match(overloaded, /incomplete/);
  assert.notEqual(truncated, overloaded);
});

// ---------------------------------------------------------------------------
// Every pause must reach the SCREEN, not just the transcript.
//
// A source scan, which is unusual, and deliberate. This bug cannot fail loudly:
// a pause helper that only pushes to the transcript type-checks, passes every
// test, and returns a perfectly good string — the turn just ends with a blank
// screen and the user reads it as a crash. That happened. The only mechanical way
// to catch the next one is to check the shape of the code, the same approach
// promptAssembly.test.ts and providerNeutrality.test.ts take for their own
// silent failures.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("endTurnWith puts the pause message on the wire, not only in the transcript", () => {
  const body = engineSource.match(/function endTurnWith\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "endTurnWith not found — did it get renamed?");
  assert.match(body, /transcript\.push/, "the pause must be recorded for the next model turn");
  assert.match(body, /onEvent\?\.\(\s*\{\s*type:\s*"text"/, "the pause must also be emitted to the UI");
});

test("no pause helper ends a turn without going through endTurnWith", () => {
  const helpers = [...engineSource.matchAll(/\nfunction (pause\w*)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
  assert.ok(helpers.length >= 4, `expected the known pause helpers, found ${helpers.length}`);
  for (const [, name, body] of helpers) {
    assert.match(
      body!,
      /endTurnWith\(/,
      `${name} composes a message the user never sees — route it through endTurnWith`,
    );
  }
});

test("session memory is swept at turn END, not only at turn start", () => {
  // The turn-start check works one turn behind: it can only see what happened BEFORE
  // this turn ran. A session whose last turn did the real work therefore ended with
  // notes that never mentioned it, and a later read_session found nothing useful.
  // This bug cannot fail loudly — the notes are just quietly thinner — so it is pinned
  // structurally, the same way endTurnWith is.
  const sweeps = [...engineSource.matchAll(/sweepSessionMemory\(session, options\)/g)];
  assert.ok(sweeps.length >= 2, `expected a sweep at turn start AND turn end, found ${sweeps.length}`);
  assert.match(
    engineSource,
    /if \(!options\.signal\?\.aborted\) await sweepSessionMemory/,
    "the end-of-turn sweep must be skipped on abort — Esc should not buy a background model call",
  );
});

test("the end-of-turn sweep is not in the finally block", () => {
  // `finally` also runs on throw and on abort. A model call there would fire on paths
  // the user never paid for and cannot see.
  const finallyBody = engineSource.match(/\} finally \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(finallyBody, "the turn's finally block not found — did it get restructured?");
  assert.doesNotMatch(finallyBody, /sweepSessionMemory/);
});

test("the turn's MCP tools come from ONE snapshot, not two live reads", () => {
  // Reading live state twice let a server die between advertising a tool and
  // dispatching it, so the model could be refused a tool it had just been offered.
  // Silent when broken — the tool list still looks right — so it is pinned structurally.
  assert.match(engineSource, /mcp\?\.snapshot\(/, "the turn must take a snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.toolSchemas\(/, "the advertised list must come from the snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.asTool\(/, "dispatch must come from the same snapshot");
});

test("compaction counts the whole prompt, not just the transcript", () => {
  // Everything sent every turn but living outside the transcript — the system prompt,
  // every tool schema, the working-set block, the relevance map — used to be invisible
  // to the bars, so they fired that much too late. Also silent when broken.
  // The arithmetic lives in ONE place now, because the user-facing compaction bars are
  // drawn from the same figure the thresholds fire on. Two copies could drift, and the
  // display would then contradict the decision it is meant to explain.
  const body = engineSource.match(/function contextUsed\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "contextUsed not found — did it get renamed?");
  assert.match(body, /estimateEntriesTokens\(session\.transcript\)/, "the transcript is part of the budget");
  assert.match(body, /\+ overhead/, "and so is everything outside the transcript");
  // Both halves of the overhead must survive: the MEASURED prompt size once a call has
  // reported one, and the catalog estimate as the fallback before that. Lose either and
  // the bars go blind again to whichever is missing.
  assert.match(body, /const overhead =/, "the overhead term not found — did it get renamed?");
  assert.match(body, /contextOverhead/, "the measured prompt size is preferred");
  assert.match(body, /estimatedTokens\(\)/, "with the MCP catalog as the fallback");
  // A measurement from ANOTHER model must not be reused: switching provider changes the
  // tool-schema serialisation and the prompt shape, so the figure stops being about this
  // request. Without this comparison the first call after a /provider switch sizes its
  // bars from the old provider's prompt.
  assert.match(body, /\.model === session\.modelConfig\.model/, "a measurement from another model must not be reused");

  // And the thresholds must actually USE it rather than keeping their own copy.
  const compactBody = engineSource.match(/async function maybeCompact\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(compactBody, "maybeCompact not found — did it get renamed?");
  assert.match(compactBody, /contextUsed\(session\)/, "the bars must fire on the shared figure");
  // As must the report the user is shown, or the bars become a second opinion.
  assert.match(engineSource, /before,\s*\n\s*after: contextUsed\(session\)/, "the report must use it too");
  // And the measured branch must actually be fed, or it is dead code that reads as safety.
  assert.match(
    engineSource,
    /contextOverhead = \{/,
    "reported usage must be recorded as the overhead",
  );
  assert.match(engineSource, /tokens: measuredOverhead\(/, "…with the measured figure");
  assert.match(engineSource, /model: session\.modelConfig\.model/, "…and the model it belongs to");
  assert.doesNotMatch(body, /estimateEntriesTokens\(session\.transcript\) >=/, "no bar may be compared against the transcript alone");
});

test("the tool list is rebuilt per STEP, so a searched tool is callable at once", () => {
  // A large MCP catalog is held behind find_mcp_tools. If the tool list were fixed at
  // turn start, the model would search, be told a tool was loaded, and then still not
  // be able to call it until the next user message — a lie it cannot diagnose.
  // Silent when broken: the search still reports success.
  assert.match(engineSource, /const stepTools = \(\) =>/, "the tool list must be a per-step function");
  // Match to the end of the argument list rather than to the first `)`, so an argument
  // that is itself a call (or a reformat onto several lines) doesn't silently truncate
  // the match and turn this into a test that passes by finding nothing.
  const call = engineSource.match(/const request = buildRequest\([\s\S]*?\n\s*\);/)?.[0];
  assert.ok(call, "buildRequest call not found — did the signature change?");
  assert.match(call, /stepTools\(\)/, "each step must send the CURRENT tool list");
});

test("the summarizer's reply is gated before it can replace the transcript", () => {
  // Silent when broken: an accepted bad summary looks identical to a good one, and
  // the conversation it replaced is already gone.
  const body = engineSource.match(/async function autocompact\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "autocompact not found — did it move?");
  assert.match(body, /usableSummary\(turn\.content, turn\.stop\)/, "the stop reason must be part of the decision");
  assert.doesNotMatch(body, /const \{ content \}/, "destructuring content alone discards the stop reason");
});

test("EVERY summarizer rejection counts toward the circuit breaker", () => {
  // A rejection that doesn't count means a doomed summarizer is called on every step
  // forever, which is the runaway the breaker exists to stop.
  const body = engineSource.match(/async function autocompact\([\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  // Pin the property, not a count: BOTH ways out — a thrown error and a reply that
  // came back unusable — have to go through the same failure path.
  assert.match(body, /if \(!usable\) return void fail\(\);/, "an unusable reply must count as a failure");
  assert.match(body, /\} catch \{\s*\n\s*return void fail\(\);/, "a thrown error must count as a failure");
  assert.doesNotMatch(body, /if \(!summary\) return;/, "a bare return skips the breaker");
});

test("microcompaction's result is never discarded on a counter nobody remembered", () => {
  // Gating the write on a hand-picked subset meant a pass that only cleared edit inputs
  // or only evicted images did the work and threw it away.
  const body = engineSource.match(/if \(used\(\) >= microBar\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(body, "microcompact block not found");
  // Matched loosely on the ASSIGNMENT rather than on an exact call, so adding an
  // argument to microcompact does not read as removing the guarantee. What must hold is
  // that the result is assigned unconditionally, not that the call has a fixed shape.
  assert.match(body, /session\.transcript = microcompact\(/, "the result must still be taken");
  assert.match(body, /\)\.entries;/, "and assigned, not inspected first");
  assert.doesNotMatch(body, /cleared > 0 \|\| recapsCleared > 0/, "no counter subset may gate the write");
  assert.doesNotMatch(body, /if \([a-z]+\.cleared/i, "nor any single counter");
});

test("nothing is pushed to the transcript between tool_calls and their results", () => {
  // A shipped 400 from DeepSeek: "An assistant message with 'tool_calls' must be
  // followed by tool messages responding to each 'tool_call_id'." The narration nudge
  // was pushed as a `user` message the moment the fault was judged — which is right
  // after the assistant's tool_calls and before any result. Every turn that called a
  // tool failed instantly.
  //
  // Pinned structurally because the unit tests around it all passed: they covered the
  // pure detector and never the transcript SHAPE. Any future nudge judged at that spot
  // has to queue and land after the results, like the batching and verify nudges do.
  const start = engineSource.indexOf('push({ role: "assistant", content, toolCalls: records })');
  assert.ok(start > 0, "the tool_calls append moved — re-anchor this test");
  const end = engineSource.indexOf("phase: \"start\"", start);
  assert.ok(end > start, "the tool announcement loop moved — re-anchor this test");

  const between = engineSource.slice(start, end);
  assert.doesNotMatch(
    between,
    /transcript\.push/,
    "something is appended between tool_calls and the tool results — that request is invalid",
  );
});

test("the reply-style rules sit at the BOUNDARY, not in the cached prefix", () => {
  // They were in the system prompt and were reliably ignored by turn three — the same
  // burying the standing rules were moved out of the prefix to escape.
  const promptSource = readFileSync(fileURLToPath(new URL("./prompt.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(promptSource, /FOUR LINES OR FEWER/, "the rule must not live in the cached prefix");
  assert.match(engineSource, /parts\.push\(REPLY_STYLE\)/, "it belongs in the volatile tail");
});

test("the reply gate fires at the turn-end boundary and can only fire once", () => {
  // Prose asked for this budget in three wordings and was ignored each time; this is
  // the version that holds, so the wiring is worth pinning.
  assert.match(engineSource, /const fault = replyFault\(content, mutatedThisTurn\)/, "gated on the turn's own work flag");
  assert.match(engineSource, /if \(!replyRegated\)/, "one retry per turn — a gate that can fire twice is a loop");
  assert.match(engineSource, /options\.onEvent\?\.\(\{ type: "replyReset" \}\)/, "the draft must be dropped from the UI buffer");
});

test("a rejected draft is spliced out of history, so what is saved is what was shown", () => {
  // Otherwise a resumed session replays the wall of text the gate just removed.
  assert.match(engineSource, /session\.transcript\.splice\(overlongReplyAt, 2\)/);
});
