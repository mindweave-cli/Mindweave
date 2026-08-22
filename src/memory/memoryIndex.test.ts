/**
 * memoryIndex.test.ts — MEMORY.md survives two instances saving at once.
 *
 * The index is read, edited and written back. Two Mindweave instances open on one
 * project both read the same index, and the second write drops the first one's line.
 * Nothing looks broken: the topic FILE is on disk either way. But MEMORY.md is the only
 * listing ever loaded into the prompt, and nothing rebuilds it, so that memory is
 * invisible from then on. Permanently.
 *
 * Atomic writes do not help. Both writes are individually complete; they just describe
 * different pasts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyIndexUpsert, indexLists, loadMemoryIndex, memoryDir, saveMemory } from "./autoMemory.js";
import { sanitizeProjectPath } from "./store.js";

test("the pure merge replaces one pointer and leaves the rest alone", () => {
  const start = "# Memory Index\n\n- [A](a.md) — first\n- [B](b.md) — second\n";
  const next = applyIndexUpsert(start, "a.md", "- [A](a.md) — rewritten");
  assert.match(next, /- \[A\]\(a\.md\) — rewritten/);
  assert.match(next, /- \[B\]\(b\.md\) — second/, "the other memory is untouched");
  assert.equal((next.match(/\(a\.md\)/g) ?? []).length, 1, "no duplicate pointer");
});

test("a cross-reference in another memory's prose is not mistaken for a pointer", () => {
  // The pointer test is anchored to the start of the line. Matching anywhere would
  // delete an entry whose prose merely mentions another memory.
  const start = "# Memory Index\n\n- [B](b.md) — supersedes (a.md), see there\n";
  const next = applyIndexUpsert(start, "a.md", "- [A](a.md) — new");
  assert.match(next, /- \[B\]\(b\.md\) — supersedes \(a\.md\), see there/, "B survived");
  assert.match(next, /- \[A\]\(a\.md\) — new/);
});

test("the first memory creates the index", () => {
  assert.match(applyIndexUpsert("", "a.md", "- [A](a.md) — first"), /^# Memory Index/);
  assert.ok(indexLists(applyIndexUpsert("", "a.md", "- [A](a.md) — x"), "a.md"));
});

test("concurrent saves all reach the index", async () => {
  // The real thing, against a real directory. Without the verify-and-retry some of
  // these lines are lost, and the memory behind them can never be found again.
  const cwd = await fs.mkdtemp(join(tmpdir(), "mw-memidx-"));
  const COUNT = 12;
  try {
    await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        saveMemory(cwd, {
          name: `fact ${i}`,
          description: `d${i}`,
          type: "project",
          body: `body ${i}`,
          indexLine: `hook ${i}`,
        }),
      ),
    );

    const index = await loadMemoryIndex(cwd);
    const missing: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const file = `fact-${i}.md`;
      // The topic file always survives; it is the POINTER that gets lost, and a memory
      // with no pointer is one the next session will never load.
      assert.ok(
        await fs.stat(join(memoryDir(cwd), file)).then(() => true).catch(() => false),
        `${file} should exist on disk`,
      );
      if (!indexLists(index, file)) missing.push(file);
    }
    assert.deepEqual(missing, [], `${missing.length} of ${COUNT} memories became unfindable`);

    // And they keep the prose they were saved with. Reconciling can recover a lost
    // pointer, but only by rebuilding it from the file's frontmatter, so the model's
    // own one-line hook is replaced by the flatter description. Serialising writes
    // inside the process is what stops that happening on every parallel save: without
    // it the index still lists everything, just worse.
    const degraded: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      if (!index.includes(`hook ${i}`)) degraded.push(`fact-${i}`);
    }
    assert.deepEqual(degraded, [], `${degraded.length} entries lost their original wording to a recovery`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("two PROCESSES saving at once both reach the index", async () => {
  // The half a queue cannot cover. Serialising index writes fixes collisions inside one
  // instance, but two Mindweave instances open on the same project are two processes,
  // and they can only converge by each checking that its own line actually survived.
  //
  // Spawned for real rather than simulated: an in-process fake would share the very
  // queue this is meant to bypass, and would prove nothing.
  const cwd = await fs.mkdtemp(join(tmpdir(), "mw-memidx-x-"));
  const state = await fs.mkdtemp(join(tmpdir(), "mw-state-x-"));
  const child = join(state, "child.mjs");
  const PER_CHILD = 6;

  await fs.writeFile(
    child,
    [
      `import { saveMemory } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/memory/autoMemory.ts")).href)};`,
      `const [cwd, tag] = process.argv.slice(2);`,
      `for (let i = 0; i < ${PER_CHILD}; i++) {`,
      `  await saveMemory(cwd, { name: tag + "-" + i, description: "d", type: "project", body: "b", indexLine: "h" });`,
      `}`,
    ].join("\n"),
    "utf8",
  );

  const run = (tag: string) =>
    new Promise<number>((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", "tsx", child, cwd, tag], {
        env: { ...process.env, MINDWEAVE_STATE_DIR: state },
        stdio: "ignore",
      });
      p.on("error", reject);
      p.on("exit", (code) => resolve(code ?? 1));
    });

  try {
    const codes = await Promise.all([run("alpha"), run("beta")]);
    assert.deepEqual(codes, [0, 0], "both writers finished");

    // Read the way a real session does. Between two PROCESSES a line can still be
    // dropped, and the index repairs itself from the topic files on read rather than
    // relying on a retry budget or a lock timeout being generous enough.
    process.env.MINDWEAVE_STATE_DIR = state;
    const index = await loadMemoryIndex(cwd);
    const missing: string[] = [];
    for (const tag of ["alpha", "beta"]) {
      for (let i = 0; i < PER_CHILD; i++) {
        if (!indexLists(index, `${tag}-${i}.md`)) missing.push(`${tag}-${i}.md`);
      }
    }
    assert.deepEqual(missing, [], `${missing.length} of ${PER_CHILD * 2} were unrecoverable across processes`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
});
