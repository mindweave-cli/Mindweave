/**
 * editFreshness.test.ts — editing against a file that moved under you.
 *
 * The situation was never unsafe: an edit is matched against the file's CURRENT bytes, so
 * a stale `old_string` simply fails to match. It was mis-DIAGNOSED. The model was told
 * "old_string not found, copy the target text precisely", which reads as "you mistyped",
 * so the sensible response to that message — retype it more carefully — is exactly the
 * one that cannot work. Naming the real cause is what makes the recovery correct.
 *
 * The quieter case these tests also pin: when the external change lands somewhere the
 * model is NOT editing, the old code applied the edit cleanly against content nobody had
 * looked at. That is the only path where a confident edit rests on a stale understanding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatches } from "./editCore.js";
import { writeFile } from "./writeFile.js";
import { replaceSymbolBody } from "./replaceSymbol.js";
import { CodeChassis } from "../alternator/chassis/index.js";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edit } from "./edit.js";
import { changedSinceRead } from "./editTarget.js";
import type { ToolContext } from "./types.js";

/** The single-edit case, spelled the way it reads: `edit` takes an edits[] array,
 *  and a lone change is an array of one. */
function editOne(
  args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ctx: ToolContext,
) {
  const { path, ...one } = args;
  return edit.execute({ path, edits: [one] }, ctx);
}

const SOURCE = `import logging


def handler(request):
    ip = request.META.get("REMOTE_ADDR")
    return ip


def other(request):
    return 42
`;

async function project(): Promise<{ root: string; path: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "mw-fresh-"));
  const path = join(root, "app.py");
  await fs.writeFile(path, SOURCE);
  const st = await fs.stat(path);
  const reads = new Map([[path, { mtimeMs: st.mtimeMs, size: st.size, full: true }]]);
  return { root, path, ctx: { cwd: root, roots: [root], reads, todos: [] } as unknown as ToolContext };
}

/** Rewrite the file the way a formatter or another process would. */
async function externallyChange(path: string, body: string): Promise<void> {
  // Push the timestamp clearly past the recorded one; some filesystems are coarse.
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path, body);
  const t = new Date(Date.now() + 2000);
  await fs.utimes(path, t, t);
}

test("changedSinceRead needs BOTH signals, because either alone misses real cases", () => {
  // Same size, different mtime: a rename, a flipped boolean, a changed constant.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 9000, size: 500 }), true);
  // Same mtime, different size: coarse filesystem timestamps hide a fast rewrite.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 1000, size: 640 }), true);
  // Untouched.
  assert.equal(changedSinceRead({ mtimeMs: 1000, size: 500 }, { mtimeMs: 1000, size: 500 }), false);
  // Sub-millisecond jitter is not a change; refusing on it would block ordinary edits.
  assert.equal(changedSinceRead({ mtimeMs: 1000.4, size: 500 }, { mtimeMs: 1000.9, size: 500 }), false);
  // A record with no bookkeeping is trusted rather than blocked on our own gap.
  assert.equal(changedSinceRead({}, { mtimeMs: 9000, size: 640 }), false);
});

test("an edit after an external change is refused, and says WHY", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));

  const r = await editOne(
    { path: "app.py", old_string: '    ip = request.META.get("REMOTE_ADDR")', new_string: "    ip = client_ip(request)" },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /changed on disk since you read it/);
  assert.match(r.output, /Read it again/, "the recovery has to be named, or it retypes the same string");
  assert.ok(!/old_string not found/.test(r.output), "the old message sent it down the wrong path");
});

test("the refusal is quiet — it is the agent's own bookkeeping, not the user's problem", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  const r = await editOne({ path: "app.py", old_string: "return 42", new_string: "return 44" }, ctx);
  assert.equal(r.quiet, true);
});

test("the dangerous case: a change ELSEWHERE no longer slips through", async () => {
  // The edit's own target still matches perfectly here, so before this gate the write
  // went ahead — against a file whose other half the model had never seen.
  const { root, path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("def other(request):\n    return 42", "def other(request):\n    raise RuntimeError('gone')"));

  const r = await editOne(
    { path: "app.py", old_string: '    ip = request.META.get("REMOTE_ADDR")', new_string: "    ip = client_ip(request)" },
    ctx,
  );
  assert.ok(r.isError, "the edit matched, but the file is not what the model thinks it is");
  assert.match(r.output, /changed on disk/);
  const after = await readFile(path, "utf8");
  assert.ok(!after.includes("client_ip"), "nothing was written");
  assert.ok(after.includes("RuntimeError"), "and the external change is intact");
});

test("a batched edit is gated the same way — the check lives in the shared gauntlet", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  const r = await edit.execute(
    { path: "app.py", edits: [{ old_string: "import logging", new_string: "import logging\nimport os" }] },
    ctx,
  );
  assert.ok(r.isError);
  assert.match(r.output, /changed on disk/);
});

test("re-reading clears it, and the edit then goes through", async () => {
  const { path, ctx } = await project();
  await externallyChange(path, SOURCE.replace("return 42", "return 43"));
  // What read_file does: refresh the ledger from the file's current state.
  const st = await fs.stat(path);
  ctx.reads.set(path, { mtimeMs: st.mtimeMs, size: st.size, full: true });

  const r = await editOne({ path: "app.py", old_string: "return 43", new_string: "return 44" }, ctx);
  assert.ok(!r.isError, r.output);
  assert.match(await readFile(path, "utf8"), /return 44/);
});

test("the agent's OWN writes never trip the gate", async () => {
  // recordWrite re-stats after every edit. If it did not, the second edit of any pair
  // would refuse, which would make the whole gate unusable.
  const { path, ctx } = await project();
  const first = await editOne({ path: "app.py", old_string: "return 42", new_string: "return 43" }, ctx);
  assert.ok(!first.isError, first.output);
  const second = await editOne({ path: "app.py", old_string: "return 43", new_string: "return 44" }, ctx);
  assert.ok(!second.isError, second.output);
  assert.match(await readFile(path, "utf8"), /return 44/);
});

// ── the description has to match the matcher ──────────────────────────────────
// The edit tool's description claims the matcher forgives indentation and line endings
// but not skipped or reordered lines. Those are behaviours in editCore, and a
// description that oversells leniency invites the sloppy input that makes a
// wrong-place edit possible, while one that undersells it costs whole-file re-reads
// to recover bytes the tool never needed.

test("indentation really is forgiven, as the description promises", () => {
  const file = "function a() {\n    return 1;\n}\n";
  // Same lines, different leading whitespace: the line-trimmed tier must find it.
  const r = findMatches(file, "function a() {\nreturn 1;\n}");
  assert.equal(r.matches.length, 1, "a differently-indented block must still match");
  assert.equal(r.tier, "line-trimmed");
  assert.match(edit.description, /leading and trailing whitespace ignored/i);
});

test("an exact match still wins over the looser tier", () => {
  const file = "const a = 1;\n";
  const r = findMatches(file, "const a = 1;");
  assert.equal(r.tier, "exact", "strictest tier first, or a loose match could win wrongly");
});

test("a skipped line is NOT forgiven, as the description warns", () => {
  const file = "one\ntwo\nthree\n";
  const r = findMatches(file, "one\nthree");
  assert.equal(r.matches.length, 0, "skipping a line must not match");
  assert.match(edit.description, /skipped, reordered, or extra line/i);
});

test("the description no longer claims an exact-bytes match is required", () => {
  // The claim that cost the re-reads.
  assert.doesNotMatch(edit.description, /must match the file's text/i);
});

// ── write_file's description promises three services; they must exist ─────────
// Each one exists to stop the model doing work by hand: shelling out to mkdir,
// hand-matching line endings it cannot see, or doing a redundant full read before
// overwriting a file it already read one symbol of.

test("write_file creates missing parent directories, as promised", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-wf-"));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await writeFile.execute({ path: "a/b/c/new.ts", content: "export const x = 1;\n" }, ctx);
  assert.ok(!r.isError, `nested write should succeed, got: ${r.output}`);
  assert.equal(await readFile(join(dir, "a/b/c/new.ts"), "utf8"), "export const x = 1;\n");
  assert.match(writeFile.description, /parent directories are created/i);
});

test("an existing file keeps its own line endings, as promised", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-wf-"));
  const p = join(dir, "crlf.ts");
  await fs.writeFile(p, "a\r\nb\r\n");
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  // Satisfy the read gate the way the description says it can be satisfied.
  ctx.reads.set(p, { mtimeMs: 0, size: 0, full: true, touchedAt: 1 });
  // The model only ever emits LF.
  await writeFile.execute({ path: "crlf.ts", content: "x\ny\n" }, ctx);
  assert.ok((await readFile(p, "utf8")).includes("\r\n"), "CRLF must be preserved, not converted");
  assert.match(writeFile.description, /existing file keeps its own/i);
});

test("the read gate is satisfied by ctx.reads, not specifically by read_file", async () => {
  // The description says read_symbol counts too. It counts because the gate looks at
  // ctx.reads, which read_symbol also fills.
  const dir = await mkdtemp(join(tmpdir(), "mw-wf-"));
  const p = join(dir, "e.ts");
  await fs.writeFile(p, "old\n");
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  const refused = await writeFile.execute({ path: "e.ts", content: "new\n" }, ctx);
  assert.equal(refused.isError, true, "an unread existing file must not be clobbered");
  ctx.reads.set(p, { mtimeMs: 0, size: 0, full: false, touchedAt: 1 });
  const allowed = await writeFile.execute({ path: "e.ts", content: "new\n" }, ctx);
  assert.ok(!allowed.isError, "any recorded read satisfies the gate");
  assert.match(writeFile.description, /read_file or read_symbol both count/i);
});

// ── replace_symbol_body: the ambiguity escape hatch, and the numbered result ──
// The old description said to pass `path` when a name is defined more than once. For
// two definitions in ONE file that is unactionable advice: no path narrows it, so a
// model that believes the text retries the same call forever.

test("same-file ambiguity is refused and `path` cannot fix it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-rsb-"));
  const p = join(dir, "dup.ts");
  // Two functions with the same name in ONE file.
  await fs.writeFile(p, "function twice() { return 1; }\nexport const x = 1;\nfunction twice() { return 2; }\n");
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  const ctx = { cwd: dir, reads: new Map(), chassis, todos: [] } as unknown as ToolContext;
  ctx.reads.set(p, { mtimeMs: 0, size: 0, full: true, touchedAt: 1 });

  const r = await replaceSymbolBody.execute(
    { name: "twice", new_definition: "function twice() { return 3; }", path: "dup.ts" },
    ctx,
  );
  assert.equal(r.isError, true, "an ambiguous target must never be guessed");
  assert.match(r.output, /ambiguous/i);
  assert.match(r.output, /No changes were written/i);
  // The file must be untouched.
  assert.match(await readFile(p, "utf8"), /return 1/);
  // And the description must send the model somewhere that actually works.
  assert.match(replaceSymbolBody.description, /use edit with an exact old_string/i);
});

test("a successful replace returns the new definition WITH line numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-rsb2-"));
  const p = join(dir, "one.ts");
  await fs.writeFile(p, "export function only() {\n  return 1;\n}\n");
  const chassis = new CodeChassis(dir, { lsp: false });
  await chassis.build();
  const ctx = { cwd: dir, reads: new Map(), chassis, todos: [] } as unknown as ToolContext;
  // A REAL read record. With mtime/size left at 0 the freshness gate correctly refuses
  // the edit, which is the gate working rather than a bug: this fixture has to look
  // like a file the model actually read.
  const st = await fs.stat(p);
  ctx.reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: true, touchedAt: 1 });

  const r = await replaceSymbolBody.execute(
    { name: "only", new_definition: "export function only() {\n  return 42;\n}" },
    ctx,
  );
  assert.ok(!r.isError, `expected success, got: ${r.output}`);
  assert.match(r.output, /\b1\b.*export function only/, "the result must carry line numbers");
  assert.match(replaceSymbolBody.description, /WITH line numbers/i);
});

// ── An unread file earns its edit by matching ────────────────────────────────
// Measured on a real session: the model batched ONE identical nav edit across five
// pages. Four were refused for not having been read, so it read four whole files
// (~9,000 tokens each) and re-issued the same four edits, which all applied first try.
// Twelve calls where five would have done, and the reads proved nothing the match was
// not about to prove. An `old_string` is matched against the file's CURRENT bytes, so a
// unique match is itself the evidence — you cannot quote a line you have not seen.

const NAV_PAGE = [
  "<!DOCTYPE html>",
  "<html>",
  "<body>",
  "<nav>",
  '  <a href="cart.html" class="cart-link">',
  '    <i class="fa-solid fa-shopping-bag"></i>',
  "  </a>",
  "</nav>",
  "<main>content</main>",
  "</body>",
  "</html>",
].join("\n");

async function pageDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mw-unread-"));
  await fs.writeFile(join(dir, "home.html"), NAV_PAGE);
  return dir;
}

test("an edit that matches exactly is APPLIED to a file that was never read", () => {
  return (async () => {
    const dir = await pageDir();
    const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
    const res = await editOne(
      { path: "home.html", old_string: '  <a href="cart.html" class="cart-link">', new_string: '  <a href="wishlist.html" class="wishlist-link">' },
      ctx,
    );
    assert.ok(!res.isError, `should have applied, got: ${res.output}`);
    const after = await readFile(join(dir, "home.html"), "utf8");
    assert.match(after, /wishlist-link/);
  })();
});

test("an edit that does NOT match a never-read file is refused, and says to read it", () => {
  return (async () => {
    // This is the case the gate actually exists for: the model does not know what is
    // in the file. Now it costs a read only here, instead of on every unread edit.
    const dir = await pageDir();
    const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
    const res = await editOne(
      { path: "home.html", old_string: '<a href="basket.html" class="basket-link">', new_string: "<a>x</a>" },
      ctx,
    );
    assert.ok(res.isError, "a guessed old_string must not be allowed through");
    assert.match(res.output, /has not been read this session/);
    const after = await readFile(join(dir, "home.html"), "utf8");
    assert.equal(after, NAV_PAGE, "nothing may be written");
  })();
});

test("an AMBIGUOUS match on a never-read file is refused too", () => {
  return (async () => {
    // Matching twice is not evidence of knowing which one you meant.
    const dir = await mkdtemp(join(tmpdir(), "mw-unread-"));
    await fs.writeFile(join(dir, "dup.html"), "<li>item</li>\n<li>item</li>\n");
    const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
    const res = await editOne({ path: "dup.html", old_string: "<li>item</li>", new_string: "<li>x</li>" }, ctx);
    assert.ok(res.isError);
    assert.equal(await readFile(join(dir, "dup.html"), "utf8"), "<li>item</li>\n<li>item</li>\n");
  })();
});

test("a file that WAS read and then changed underneath still gets the freshness refusal", () => {
  return (async () => {
    // The unread path must not swallow the case this file was built for.
    const dir = await pageDir();
    const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
    const st = await fs.stat(join(dir, "home.html"));
    ctx.reads.set(join(dir, "home.html"), { mtimeMs: st.mtimeMs - 5000, size: st.size - 40, full: true });
    const res = await editOne(
      { path: "home.html", old_string: "<main>content</main>", new_string: "<main>new</main>" },
      ctx,
    );
    assert.ok(res.isError);
    assert.match(res.output, /changed on disk since you read it/);
  })();
});
