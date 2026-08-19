/**
 * prefixStability.test.ts — the system prompt must not change while a session runs.
 *
 * This is the single most expensive property in the whole request. Changing the system
 * prompt invalidates the tools cache, the system cache AND the message cache — the full
 * rebuild, not a partial miss — so a prefix that varies re-bills the entire conversation
 * on the turn it varies.
 *
 * The defect this pins was live and invisible: the skill catalog rendered into the
 * system prompt was FILTERED by the working set, so a glob-scoped skill appeared the
 * moment the model read a matching file. Reading one file therefore re-billed the whole
 * prefix, and nothing in the output said so — the only symptom was a turn costing far
 * more than the work in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSkillCatalog } from "../governor/index.js";
import type { SkillMeta } from "../governor/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skill = (name: string, globs?: string[]): SkillMeta =>
  ({ name, description: `does ${name}`, whenToUse: "", dir: `/skills/${name}`, ...(globs ? { globs } : {}) }) as SkillMeta;

const SKILLS: SkillMeta[] = [skill("deploy"), skill("css-audit", ["**/*.css"])];

test("the skill catalog is identical no matter what has been read", () => {
  // Called with no working set, which is how the engine renders it for the prefix.
  const cold = renderSkillCatalog(SKILLS);
  const afterCss = renderSkillCatalog(SKILLS);
  assert.equal(cold, afterCss);
  assert.match(cold, /deploy/);
  assert.match(cold, /css-audit/, "a glob-scoped skill must be listed unconditionally in the prefix");
});

test("glob filtering still exists — it is the CALLER that must not use it here", () => {
  // The capability is not removed; the engine simply does not apply it to the cached
  // half. Kept as a test so a future change that re-introduces filtering at the prefix
  // has to delete this comment deliberately rather than by accident.
  const filtered = renderSkillCatalog(SKILLS, ["src/app.ts"]);
  assert.doesNotMatch(filtered, /css-audit/, "with a working set, globs still narrow the list");
  assert.notEqual(filtered, renderSkillCatalog(SKILLS), "which is exactly why the prefix must not pass one");
});

test("the engine renders the catalog WITHOUT a working set", () => {
  // Structural, because the cost of getting this wrong is invisible at runtime: the
  // request still succeeds, it just quietly costs a full prefix rebuild.
  const src = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  assert.match(src, /skills: renderSkillCatalog\(g\.skills\)/, "the prefix catalog must be unfiltered");
  assert.doesNotMatch(
    src,
    /skills: renderSkillCatalog\(g\.skills, workingSet\)/,
    "filtering the prefix catalog by the working set invalidates the entire cache",
  );
});
