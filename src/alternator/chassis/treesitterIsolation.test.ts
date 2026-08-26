/**
 * treesitterIsolation.test.ts — the crash that used to be fatal is now a null.
 *
 * The original failure was `Fatal process out of memory: Zone` while compiling the
 * OCaml grammar's WASM: a V8 fatal, not a catchable exception, previously contained
 * by giving the whole process more heap. These tests reproduce that condition in
 * miniature — the REAL OCaml grammar fed to a worker whose resource limits are too
 * small to compile it — and assert the two things the fix promises:
 *
 *   1. the host process survives the worker's death, and the call resolves to
 *      null (the fallback tier's normal "can't help" answer), and
 *   2. with sane limits the same grammar works end-to-end through the worker,
 *      so isolation costs correctness nothing.
 *
 * Run serially (this file manipulates process-wide isolation state and env).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { treeSitterExtract, treeSitterSpan } from "./treesitter.js";
import { isolationStats, resetIsolationForTests } from "./isolation.js";
import { extractMarkup } from "./markup.js";

const OCAML_SAMPLE = `let add a b = a + b

let greeting = "hello"

let twice x = add x x
`;

/**
 * There is no longer a grammar that parses in the host, and this is the test that used
 * to say the opposite ("small grammars never touch the worker", asserting zero spawns
 * for a .ts file). It was pinning a rule that measurement disproved: the old gate
 * exempted any grammar under 4.5 MB of wasm, and tsx (2.41 MB) and typescript (2.34 MB)
 * — the two most-used grammars in the product — sat under it while a single parse
 * retained tens of megabytes that `tree.delete()` never returns.
 */
test("EVERY grammar goes through the worker, including the small common ones", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const result = await treeSitterExtract(
    "/ok/sample.ts",
    "export function hello(): string { return 'hi'; }\n",
  );
  assert.ok(result && result.defs.some((d) => d.name === "hello"), "extraction must still work");
  assert.ok(isolationStats.spawns >= 1, "a small grammar must ALSO be isolated now");
  resetIsolationForTests();
});

test("the markup tier is isolated too — it had no guard of any kind before", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const html = `<html><body><div id="nav" class="hero">hi</div></body></html>`;
  const result = await extractMarkup("/ok/page.html", html);
  assert.ok(result, "HTML extraction must still work through the worker");
  assert.ok(
    result!.defs.some((d) => d.name === "nav"),
    `id= must still become a definition, got: ${result!.defs.map((d) => d.name).join(", ")}`,
  );
  assert.ok(isolationStats.spawns >= 1, "markup must not parse in the host process");
  resetIsolationForTests();
});

/**
 * Whether a worker capped at a tiny heap actually died.
 *
 * These tests force a fatal out-of-memory inside the worker to prove the HOST survives
 * it. That premise is a fact about V8, not about this code, and it does not hold
 * everywhere: Node 22 cannot compile the OCaml grammar inside an 8 MB heap and dies,
 * which is the condition being contained, while Node 20 fits it and returns a result.
 * The same commit therefore passes on one runtime and fails on the other.
 *
 * Where the crash does not happen there is nothing to contain, and asserting the
 * containment anyway tests the runtime rather than the code. So the premise is checked
 * and the test skips with its reason instead of failing on a difference it does not own.
 */
function crashDidNotHappen(): boolean {
  return isolationStats.crashes === 0;
}

test(
  "REPRODUCTION: compiling OCaml under a too-small limit kills the worker, not the host",
  { timeout: 60_000 },
  async (t) => {
    resetIsolationForTests();
    // Shrink the worker until the real grammar cannot compile inside it. This is
    // the original crash condition, relocated to somewhere it is allowed to happen.
    // Reproduce the failure CLASS, relocated: fatal V8 resource exhaustion inside
    // the thread doing grammar work. An 8 MB heap cannot even finish setting up to
    // compile a 5 MB grammar — the worker dies the way the host process used to.
    process.env.MINDWEAVE_TS_WORKER_HEAP_MB = "8";
    process.env.MINDWEAVE_TS_WORKER_TIMEOUT_MS = "30000";
    try {
      const result = await treeSitterExtract("/repro/crash.ml", OCAML_SAMPLE);
      if (crashDidNotHappen()) {
        t.skip(
          "this runtime compiled the grammar inside an 8 MB worker heap, so the crash " +
            "this test exists to contain never happened",
        );
        return;
      }
      // The host reaching THIS line is the fix: previously this was process death.
      assert.equal(result, null, "a crashed worker must resolve to null, never throw");
      assert.ok(isolationStats.crashes >= 1, "the worker must actually have died");

      // The grammar is poisoned now: the retry must not spawn-and-crash forever.
      const spawnsAfterCrash = isolationStats.spawns;
      const again = await treeSitterExtract("/repro/crash2.ml", OCAML_SAMPLE);
      assert.equal(again, null);
      assert.equal(
        isolationStats.spawns,
        spawnsAfterCrash,
        "a poisoned grammar must not respawn a worker just to crash it again",
      );
    } finally {
      delete process.env.MINDWEAVE_TS_WORKER_HEAP_MB;
      delete process.env.MINDWEAVE_TS_WORKER_TIMEOUT_MS;
      resetIsolationForTests();
    }
  },
);

test("CURE HOLDS: with sane limits, OCaml extraction works end-to-end through the worker", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const result = await treeSitterExtract("/ok/sample.ml", OCAML_SAMPLE);
  assert.ok(result, "extraction through the isolation worker must succeed");
  const names = result!.defs.map((d) => d.name);
  assert.ok(names.includes("add"), `defs must include 'add', got: ${names.join(", ")}`);
  assert.ok(isolationStats.spawns >= 1, "a worker must have been used for a heavy grammar");
  resetIsolationForTests();
});

test("CURE HOLDS: span lookup for a heavy grammar goes through the worker too", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const span = await treeSitterSpan("/ok/sample.ml", OCAML_SAMPLE, "twice");
  assert.ok(span, "span for 'twice' must resolve through the worker");
  assert.equal(span!.start, 5, "let twice is on line 5");
  resetIsolationForTests();
});


/**
 * THE CASE THE ORIGINAL TESTS MISSED.
 *
 * Every test above passed while the host was still being killed. The gap was that they
 * only exercised a two-line OCaml snippet and a deliberately-undersized HEAP, and those
 * are the two conditions under which the old worker_thread version looked fine:
 *
 *  - a heap overrun is thread-local, so the "reproduction" really did stay contained;
 *  - a two-line parse was small enough not to exhaust a V8 Zone.
 *
 * A Zone overrun is a different allocator with a different failure mode — it calls
 * FatalProcessOutOfMemory, which aborts the PROCESS and cannot be contained by any
 * thread-level mechanism. MEASURED against the old version, in the compiled build, with
 * no teardown requested: this parse returned a correct result and then killed the host
 * with exit code 3.
 *
 * So the contract worth pinning is not "a worker died politely" but "the host is still
 * running afterwards, having parsed something real".
 */
test("HOST SURVIVES a realistically sized OCaml module, not just a two-liner", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const body = Array.from(
    { length: 60 },
    (_, i) => `let f${i} x y =\n  let z = x + y * ${i} in\n  match z with\n  | 0 -> None\n  | n -> Some (n, x, y)\n`,
  ).join("\n");
  const src = `open Printf\n\ntype t = { a : int; b : string }\n\n${body}`;

  const result = await treeSitterExtract("/ok/big.ml", src);
  assert.ok(result, "a real OCaml module must still extract");
  assert.ok(result!.defs.length > 50, `expected many defs, got ${result!.defs.length}`);

  // Reaching this line at all is the assertion that matters: the old implementation
  // aborted the process somewhere above it.
  const span = await treeSitterSpan("/ok/big.ml", src, "f42");
  assert.ok(span, "and span lookup must work on the same module");
  resetIsolationForTests();
});

/**
 * THE MEMORY BUDGET — the containment for the leak, as opposed to for the crash.
 *
 * A parse retains memory that `tree.delete()` does not give back (~57-70 MB for one
 * 54 KB JSX file, in WASM linear memory, which never shrinks). Nothing in the host can
 * see that or stop it, so the child is watched and replaced instead.
 *
 * The budget is set to 1 MB here, which every real child exceeds immediately — that is
 * the point: it makes "over budget" reachable in a test without needing to actually leak
 * a gigabyte first.
 */
test("a child over its memory budget is retired, and the work still completes", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  process.env.MINDWEAVE_TS_WORKER_RSS_MB = "1";
  try {
    const src = "export function a(): number { return 1; }\n";
    for (let i = 0; i < 3; i++) {
      const r = await treeSitterExtract(`/ok/m${i}.ts`, src);
      assert.ok(r && r.defs.some((d) => d.name === "a"), `extraction ${i} must still succeed`);
    }
    assert.ok(isolationStats.retirements >= 2, `expected retirements, got ${isolationStats.retirements}`);
    assert.ok(isolationStats.spawns >= 3, "each retirement must be followed by a fresh child");
    // The distinction the whole design rests on: a planned retirement is NOT a crash.
    // If it were counted as one it would burn the respawn budget and poison grammars,
    // and code intelligence would switch itself off after a few files.
    assert.equal(isolationStats.crashes, 0, "retirement must never be recorded as a crash");
  } finally {
    delete process.env.MINDWEAVE_TS_WORKER_RSS_MB;
    resetIsolationForTests();
  }
});

/**
 * Crashes must not ACCUMULATE across a whole session.
 *
 * Once the respawn budget is exhausted, extraction returns null for everything until
 * restart — which used to cost only the exotic languages and now costs all of them,
 * because every grammar depends on this worker. Two unrelated crashes hours apart are
 * not a crash loop, so a child that has served real work clears the history.
 *
 * The cap is shrunk to 1 so exhaustion is actually reachable here, and the two crashes
 * use DIFFERENT grammars because the first one poisons its own.
 */
test("crashes separated by healthy work do not accumulate into a dead session", { timeout: 90_000 }, async (t) => {
  resetIsolationForTests();
  process.env.MINDWEAVE_TS_MAX_RESPAWNS = "1";
  const crashHeap = () => (process.env.MINDWEAVE_TS_WORKER_HEAP_MB = "8");
  const sane = () => delete process.env.MINDWEAVE_TS_WORKER_HEAP_MB;
  try {
    crashHeap();
    const firstCrash = await treeSitterExtract("/x/a.ml", OCAML_SAMPLE);
    if (crashDidNotHappen()) {
      t.skip("this runtime does not die under an 8 MB worker heap, so there is no crash to recover from");
      return;
    }
    assert.equal(firstCrash, null, "first crash");
    sane();

    // Real work in between: this is what makes the child healthy again.
    const ts = "export function b(): number { return 2; }\n";
    for (let i = 0; i < 6; i++) {
      assert.ok(await treeSitterExtract(`/ok/h${i}.ts`, ts), `healthy extraction ${i}`);
    }

    // The heap limit is applied when a child is FORKED, so the healthy child now
    // running would happily parse anything. Retire it first (budget of 1 MB, which any
    // real child exceeds) so the next request forks a fresh one under the small heap.
    process.env.MINDWEAVE_TS_WORKER_RSS_MB = "1";
    assert.ok(await treeSitterExtract("/ok/retire.ts", ts), "retiring extraction still succeeds");
    delete process.env.MINDWEAVE_TS_WORKER_RSS_MB;

    crashHeap();
    assert.equal(await treeSitterExtract("/x/b.cpp", "int main() { return 0; }\n"), null, "second crash");
    sane();

    // Without the reset, two crashes exceed a cap of 1 and this returns null forever.
    const after = await treeSitterExtract("/ok/after.ts", ts);
    assert.ok(after && after.defs.some((d) => d.name === "b"), "extraction must still work after both");
  } finally {
    sane();
    delete process.env.MINDWEAVE_TS_MAX_RESPAWNS;
    resetIsolationForTests();
  }
});

test("one child serves many requests, and the host outlives all of them", { timeout: 60_000 }, async () => {
  resetIsolationForTests();
  const src = "let add a b = a + b\n\nlet twice x = add x x\n";
  for (let i = 0; i < 4; i++) {
    const r = await treeSitterExtract(`/ok/m${i}.ml`, src);
    assert.ok(r, `extraction ${i} must succeed`);
  }
  assert.equal(isolationStats.spawns, 1, "the child is reused, not respawned per request");
  assert.equal(isolationStats.crashes, 0, "and nothing died along the way");
  resetIsolationForTests();
});
