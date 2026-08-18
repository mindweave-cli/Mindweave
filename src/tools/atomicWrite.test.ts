/**
 * atomicWrite.test.ts — the destination is never observed half-written.
 *
 * The point of these tests is the TEAR, not the happy path. `fs.writeFile` also
 * puts the right bytes on disk when nothing goes wrong, so a test that only
 * checks the final content passes just as well against the bug this module was
 * written to fix. The load-bearing test here is "concurrent readers never see a
 * partial file": it fails against a bare fs.writeFile and passes against the
 * rename, which is the entire difference between the two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./atomicWrite.js";

const IS_WINDOWS = process.platform === "win32";

async function freshDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "mw-atomic-"));
}

test("writes a new file", async () => {
  const dir = await freshDir();
  const path = join(dir, "new.txt");
  await writeFileAtomic(path, "hello\n");
  assert.equal(await fs.readFile(path, "utf8"), "hello\n");
});

test("replaces existing content wholesale, leaving nothing of the old file", async () => {
  const dir = await freshDir();
  const path = join(dir, "existing.txt");
  await fs.writeFile(path, "the old content, which is longer than the new\n", "utf8");
  await writeFileAtomic(path, "new\n");
  assert.equal(await fs.readFile(path, "utf8"), "new\n");
});

test("leaves no temp files behind on success", async () => {
  const dir = await freshDir();
  const path = join(dir, "clean.txt");
  await writeFileAtomic(path, "one\n");
  await writeFileAtomic(path, "two\n");
  assert.deepEqual(await fs.readdir(dir), ["clean.txt"], "only the destination should remain");
});

test("a failed write leaves the original file and no litter", async () => {
  const dir = await freshDir();
  // A directory where the file should be: the rename cannot replace it, so the
  // write fails at the last step — after the temp file already exists, which is
  // exactly the window where litter and destruction would happen.
  const path = join(dir, "blocked");
  await fs.mkdir(path);
  await fs.writeFile(join(path, "canary.txt"), "still here\n", "utf8");

  await assert.rejects(() => writeFileAtomic(path, "should not land\n"));

  assert.equal(
    await fs.readFile(join(path, "canary.txt"), "utf8"),
    "still here\n",
    "the destination must be untouched by a failed write",
  );
  assert.deepEqual(await fs.readdir(dir), ["blocked"], "the temp file must be cleaned up");
});

test("CONTRACT: a concurrent reader never observes a partial file", async () => {
  const dir = await freshDir();
  const path = join(dir, "big.txt");
  // Big enough that a non-atomic write needs many syscalls to finish, which is the
  // window a reader can catch it in. Verified by red-check: against a bare
  // fs.writeFile this test sees the destination truncated to 16KB mid-write.
  const OLD = "A".repeat(8_000_000);
  const NEW = "B".repeat(8_000_000);
  await fs.writeFile(path, OLD, "utf8");

  let reading = true;
  const observed = new Set<string>();
  const reader = (async () => {
    while (reading) {
      try {
        const seen = readFileSync(path, "utf8");
        // A fingerprint, not the 8MB body. Length plus both ends catches a
        // truncated file, an empty file, and a half-A-half-B blend alike.
        observed.add(`${seen.length}:${seen[0] ?? ""}:${seen[seen.length - 1] ?? ""}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows refuses a read while the rename holds the name; that is the OS
        // serializing us, not a torn file. A destination that does not EXIST is a
        // real tear, on any platform.
        if (code === "ENOENT") observed.add("MISSING");
      }
      // Sample, don't hammer. A tight loop keeps the file open essentially always,
      // which on Windows blocks the rename indefinitely (MoveFileEx cannot replace
      // a file another handle holds) and tests the reader's aggression rather than
      // this module's atomicity.
      await new Promise((r) => setTimeout(r, 1));
    }
  })();

  try {
    await writeFileAtomic(path, NEW);
  } finally {
    // Always release the reader, or a failed write hangs the whole suite.
    reading = false;
    await reader;
  }

  const legal = new Set([`${OLD.length}:A:A`, `${NEW.length}:B:B`]);
  for (const fingerprint of observed) {
    assert.ok(
      legal.has(fingerprint),
      `reader saw a state that is neither the old nor the new file: ${fingerprint}`,
    );
  }
  assert.ok(observed.size > 0, "the reader must actually have sampled the file");
  assert.equal(await fs.readFile(path, "utf8"), NEW);
});

test("concurrent writers cannot interleave: the winner's content is intact", async () => {
  const dir = await freshDir();
  const path = join(dir, "contended.txt");
  const bodies = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(100_000));

  await Promise.all(bodies.map((body) => writeFileAtomic(path, body)));

  const final = await fs.readFile(path, "utf8");
  assert.ok(
    bodies.includes(final),
    "the file must be exactly one writer's content, not a blend of several",
  );
  assert.deepEqual(await fs.readdir(dir), ["contended.txt"], "every writer cleaned up after itself");
});

test(
  "an existing file's permission bits survive the replace",
  { skip: IS_WINDOWS ? "POSIX permission bits" : false },
  async () => {
    const dir = await freshDir();
    const path = join(dir, "script.sh");
    await fs.writeFile(path, "#!/bin/sh\necho old\n", "utf8");
    await fs.chmod(path, 0o755);

    await writeFileAtomic(path, "#!/bin/sh\necho new\n");

    const mode = (await fs.stat(path)).mode & 0o777;
    assert.equal(mode, 0o755, "replacing an executable script must not strip its execute bit");
  },
);
