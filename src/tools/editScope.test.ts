/**
 * editScope.test.ts — the edit tool's contract: several places, ONE file.
 *
 * The scope is a deliberate design choice, not a limitation, so it is pinned here.
 * A call that spanned several files was built and reverted: it worked, but it collapsed
 * a whole task into one UI row, one merged diff and one undo point, which is the
 * difference between a change a person can review and one they have to trust.
 *
 * So the rules under test are: many edits to one file land together or not at all, a
 * refusal leaves the file exactly as it was, and an attempt to reach a SECOND file is
 * refused with instructions rather than silently applied to the wrong one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edit } from "./edit.js";
import type { ToolContext } from "./types.js";

const GET_IP = `    @staticmethod
    def _get_ip(request):
        return request.META.get("REMOTE_ADDR")
`;

/** Two byte-identical helpers in one file — the ambiguity case that must refuse. */
const MIDDLEWARE = `import logging


class Honeypot:
    def __call__(self, request):
        ip = self._get_ip(request)
        return ip

${GET_IP}

class Fingerprint:
    def write(self, request):
        ip = self._get_ip(request)
        return ip

${GET_IP}`;

async function project(files: Record<string, string>): Promise<{ root: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "mw-scope-"));
  const reads = new Map();
  for (const [name, body] of Object.entries(files)) {
    const p = join(root, name);
    await fs.writeFile(p, body);
    const st = await fs.stat(p);
    // Pre-seed the read ledger: these tests are about the edit, not the read gate.
    reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: true });
  }
  return { root, ctx: { cwd: root, roots: [root], reads, todos: [] } as unknown as ToolContext };
}

test("several places in one file land in a single call", async () => {
  const { root, ctx } = await project({ "middleware.py": MIDDLEWARE });
  const r = await edit.execute(
    {
      path: "middleware.py",
      edits: [
        { old_string: "import logging", new_string: "import logging\nfrom core.middleware import client_ip" },
        { old_string: "        ip = self._get_ip(request)", new_string: "        ip = client_ip(request)", replace_all: true },
        { old_string: GET_IP, new_string: "", replace_all: true },
      ],
    },
    ctx,
  );
  assert.ok(!r.isError, r.output);
  const text = await readFile(join(root, "middleware.py"), "utf8");
  assert.equal((text.match(/_get_ip/g) ?? []).length, 0, "the duplicated helper is gone");
  assert.equal((text.match(/client_ip\(request\)/g) ?? []).length, 2, "both call sites migrated");
  assert.match(text, /from core\.middleware import client_ip/);
  // The numbered window is what keeps the model from re-reading after every edit.
  assert.match(r.output, /line-numbered/);
});

test("edits apply in order, each seeing the last one's result", async () => {
  const { root, ctx } = await project({ "a.txt": "one\n" });
  const r = await edit.execute(
    {
      path: "a.txt",
      edits: [
        { old_string: "one", new_string: "two" },
        { old_string: "two", new_string: "three" }, // only matches if the first applied
      ],
    },
    ctx,
  );
  assert.ok(!r.isError, r.output);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "three\n");
});

test("one failing edit leaves the file completely untouched", async () => {
  // Atomicity within the file: a later edit failing must not leave the earlier ones
  // applied, or the file is in a state the model never intended and cannot predict.
  const { root, ctx } = await project({ "middleware.py": MIDDLEWARE });
  const r = await edit.execute(
    {
      path: "middleware.py",
      edits: [
        { old_string: "import logging", new_string: "import logging\nimport os" }, // fine
        { old_string: GET_IP, new_string: "" }, // ambiguous: 2 matches, no replace_all
      ],
    },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /No changes were written/);
  const text = await readFile(join(root, "middleware.py"), "utf8");
  assert.ok(!text.includes("import os"), "the earlier edit was written despite the refusal");
  assert.equal((text.match(/def _get_ip/g) ?? []).length, 2, "the file is exactly as it was");
});

test("a refusal is quiet, and tells the model where the candidates are", async () => {
  const { ctx } = await project({ "middleware.py": MIDDLEWARE });
  const r = await edit.execute({ path: "middleware.py", edits: [{ old_string: GET_IP, new_string: "" }] }, ctx);
  assert.ok(r.isError, "the model must still be told");
  assert.equal(r.quiet, true, "but it is not a red row on the user's screen");
  assert.match(r.output, /matches 2 places/);
  assert.match(r.output, /1\. line \d+/);
  assert.match(r.output, /2\. line \d+/);
  assert.match(r.output, /replace_all: true/, "and both ways out are named");
  assert.ok(!/\.\. /.test(r.output), "no doubled full stops in the assembled message");
});

test("an edit naming a DIFFERENT file is refused, not applied to the wrong one", async () => {
  // The dangerous failure mode if per-edit paths were merely ignored: the edit would
  // silently land in the top-level file instead. Refuse, and say what to do.
  const { root, ctx } = await project({ "a.py": "alpha\n", "b.py": "beta\n" });
  const r = await edit.execute(
    {
      path: "a.py",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { path: "b.py", old_string: "beta", new_string: "BETA" },
      ],
    },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /One edit call changes one file/);
  assert.match(r.output, /separate call for each file/, "the model is told what to do instead");
  // Neither file changed: the refusal happens before anything is opened.
  assert.equal(await readFile(join(root, "a.py"), "utf8"), "alpha\n");
  assert.equal(await readFile(join(root, "b.py"), "utf8"), "beta\n");
});

test("a redundant path matching the top-level one is accepted", async () => {
  // Naming the same file it is already editing is harmless, so it should not be a
  // pointless refusal the model has to recover from.
  const { root, ctx } = await project({ "a.py": "alpha\n" });
  const r = await edit.execute(
    { path: "a.py", edits: [{ path: "a.py", old_string: "alpha", new_string: "ALPHA" }] },
    ctx,
  );
  assert.ok(!r.isError, r.output);
  assert.equal(await readFile(join(root, "a.py"), "utf8"), "ALPHA\n");
});

test("path is required", async () => {
  const { ctx } = await project({ "a.py": "alpha\n" });
  const r = await edit.execute({ edits: [{ old_string: "alpha", new_string: "ALPHA" }] }, ctx);
  assert.ok(r.isError);
  assert.match(r.output, /`path` is required/);
});

test("the tool tells the model when to use it, and when not to", async () => {
  // The routing lives in the description, and getting it wrong costs a wasted call
  // every time. Pin the three branches so an edit to this prose is a deliberate one.
  const d = edit.description;
  assert.match(d, /ONE FILE PER CALL/, "scope stated up front");
  assert.match(d, /one entry for a single change/i, "the single-edit case is spelled out, not implied");
  assert.match(d, /several entries/i, "and so is batching, which is the cheaper shape");
  assert.match(d, /separate call for each file/i, "and how to handle several files");
});
