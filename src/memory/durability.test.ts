/**
 * durability.test.ts — the user's own data is never written the tearing way.
 *
 * `fs.writeFile` truncates its destination and then streams the new bytes in, so
 * between those two moments the file on disk is empty or half-written. The project
 * already understood this for the user's SOURCE files (see tools/atomicWrite.ts); what
 * it had not applied it to was the user's CONVERSATION, which is rewritten whole on
 * every persist — before each tool batch, after each result, after each reply.
 *
 * This is a source-shape check on purpose. A torn write cannot fail in a test: the
 * happy path is byte-identical either way, and the damage only appears when a process
 * dies inside a window measured in milliseconds. The only mechanical guard is to check
 * that the unsafe call is not there, which is the same approach engine.test.ts takes
 * for its own silent failures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Everything that persists something the user would be upset to lose. */
const GUARDED: [string, string][] = [
  ["the session transcript, meta and notes", "./store.ts"],
  ["cross-session memory and its index", "./autoMemory.ts"],
  ["an approved plan", "../dynamo/planArtifact.ts"],
  // The recovery path itself. A torn write here destroys the file during the one
  // operation whose whole purpose is to save it.
  ["a file restored by /undo", "../tools/checkpoints.ts"],
];

for (const [what, file] of GUARDED) {
  test(`${what} is written atomically`, () => {
    const source = read(file);
    assert.match(source, /writeFileAtomic\(/, `${file} should persist through the atomic path`);
    // The point of the check. A single reintroduced `fs.writeFile` puts one of these
    // back in the window, and nothing else in the suite would notice.
    assert.doesNotMatch(
      source,
      /\bfs\.writeFile\(/,
      `${file} still writes straight onto the destination, which truncates it first`,
    );
  });
}

test("the atomic path really is write-temp-then-rename", () => {
  // Guarding the call sites is worthless if the thing they call is not atomic. The
  // fsync matters as much as the rename: without it a power loss can land a renamed
  // file full of zeroes, because the rename outlives the data it points at.
  const source = read("../tools/atomicWrite.ts");
  assert.match(source, /\.rename\(/, "must land by rename, the only atomic replace");
  assert.match(source, /sync\(/i, "must flush before renaming");
});
