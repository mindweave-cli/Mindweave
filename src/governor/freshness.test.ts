/**
 * freshness.test.ts — governance is re-read when its files change, and a reload never
 * costs the session something only the session knew.
 *
 * The bug this closes: governance was read once at session start, so a person editing
 * `rules/use-pnpm.md` in their editor changed nothing until they restarted — silently,
 * with the old rule still being enforced.
 *
 * The trap it must not open: a reload rebuilds the deny-list FROM DISK, and a forbidden
 * pattern the user lifted for this session was never written to disk. A naive reload
 * therefore un-allows something the user explicitly allowed, which is worse than the
 * staleness it fixes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGovernance, reloadGovernance, governanceStamp } from "./index.js";
import { projectDir } from "../memory/store.js";

/** A project whose governance state dir we can write to, isolated per test. */
async function project(): Promise<{ cwd: string; state: string }> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-fresh-")));
  process.env.MINDWEAVE_HOME = home;
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-proj-")));
  const state = projectDir(cwd);
  await fs.mkdir(join(state, "rules"), { recursive: true });
  return { cwd, state };
}

async function rule(state: string, file: string, body: string): Promise<void> {
  await fs.writeFile(join(state, "rules", file), body);
}

test("the stamp moves when a rule is edited, added, or deleted", async () => {
  const { cwd, state } = await project();
  await rule(state, "a.md", "---\nname: a\n---\nOne.");
  const first = await governanceStamp(cwd);

  // Unchanged files, unchanged stamp — this is what stops every turn reloading.
  assert.equal(await governanceStamp(cwd), first, "an idle stamp must be stable");

  // Edited. Size differs, so this holds even where mtime resolution is coarse.
  await rule(state, "a.md", "---\nname: a\n---\nOne, revised at length.");
  const edited = await governanceStamp(cwd);
  assert.notEqual(edited, first, "an edited rule did not move the stamp");

  // Added.
  await rule(state, "b.md", "---\nname: b\n---\nTwo.");
  const added = await governanceStamp(cwd);
  assert.notEqual(added, edited, "a new rule did not move the stamp");

  // Deleted — the case a content-only stamp misses, and the one where staleness means
  // still enforcing a rule the user removed.
  await fs.rm(join(state, "rules", "b.md"));
  assert.notEqual(await governanceStamp(cwd), added, "a deleted rule did not move the stamp");
});

test("a forbidden file and a skill body both count as governance changing", async () => {
  const { cwd, state } = await project();
  const start = await governanceStamp(cwd);

  await fs.writeFile(join(state, "forbidden.md"), "secrets/**\n");
  const withForbidden = await governanceStamp(cwd);
  assert.notEqual(withForbidden, start, "a new forbidden list did not move the stamp");

  // A skill is a DIRECTORY, so its body changing is one level down. A stamp that only
  // listed the skills dir would call an edited SKILL.md unchanged.
  await fs.mkdir(join(state, "skills", "ship"), { recursive: true });
  await fs.writeFile(join(state, "skills", "ship", "SKILL.md"), "---\nname: ship\n---\nbump");
  const withSkill = await governanceStamp(cwd);
  assert.notEqual(withSkill, withForbidden, "a new skill did not move the stamp");

  await fs.writeFile(join(state, "skills", "ship", "SKILL.md"), "---\nname: ship\n---\nbump, tag, publish");
  assert.notEqual(await governanceStamp(cwd), withSkill, "an edited skill body did not move the stamp");
});

test("a reload picks up the edit", async () => {
  const { cwd, state } = await project();
  await rule(state, "a.md", "---\nname: a\n---\nUse pnpm.");
  const before = await loadGovernance(cwd);
  assert.equal(before.rules.length, 1);

  await rule(state, "b.md", "---\nname: b\n---\nEvery component gets a test.");
  const after = await reloadGovernance(cwd, before);
  assert.equal(after.rules.length, 2, "the hand-added rule was not picked up");
  assert.ok(after.rules.some((r) => r.body.includes("component")));
});

test("a reload does NOT resurrect a pattern the user lifted for this session", async () => {
  const { cwd, state } = await project();
  await fs.writeFile(join(state, "forbidden.md"), "src/legacy/**\nsecrets/**\n");
  const loaded = await loadGovernance(cwd);
  assert.equal(loaded.forbidden.patterns.length, 2);

  // What approval.ts does when the user says yes: drop it from the live list and
  // remember that they said so. Nothing is written to disk, deliberately.
  const lifted = {
    ...loaded,
    forbidden: {
      ...loaded.forbidden,
      patterns: loaded.forbidden.patterns.filter((p) => p !== "src/legacy/**"),
    },
    lifted: ["src/legacy/**"],
  };

  const after = await reloadGovernance(cwd, lifted);
  assert.ok(
    !after.forbidden.patterns.includes("src/legacy/**"),
    "the reload re-blocked a path the user had explicitly allowed",
  );
  assert.ok(after.forbidden.patterns.includes("secrets/**"), "the rest of the deny-list was lost");
  assert.deepEqual(after.lifted, ["src/legacy/**"], "the lift must survive further reloads too");
});

test("a reload keeps notices the UI has not shown yet", async () => {
  const { cwd } = await project();
  const loaded = await loadGovernance(cwd);
  const withNotice = { ...loaded, notices: ["Approval lifted: 'x' → session scope → ALLOWED"] };
  const after = await reloadGovernance(cwd, withNotice);
  assert.deepEqual(after.notices, withNotice.notices, "an undrained notice was dropped by the reload");
});

test("a reload returns FRESH arrays, so the compiled deny-list cannot be stale", async () => {
  const { cwd, state } = await project();
  await fs.writeFile(join(state, "forbidden.md"), "a/**\n");
  const before = await loadGovernance(cwd);
  const after = await reloadGovernance(cwd, before);
  // forbidden.ts caches compiled patterns in a WeakMap keyed on ARRAY IDENTITY. Reusing
  // the array would keep enforcing the old list however the file changed.
  assert.notEqual(after.forbidden.patterns, before.forbidden.patterns);
});
