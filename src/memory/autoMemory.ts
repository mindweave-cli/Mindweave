/**
 * autoMemory.ts — Mindweave's cross-session memory store.
 *
 * This is the persistence layer for what Mindweave learns and is asked to remember:
 * facts about the user, feedback on how to work, project context, and pointers
 * to external systems. It is the personal-memory layer, SEPARATE from two things
 * it must not duplicate:
 *   - MINDWEAVE.md          — the project's own knowledge file (read each session).
 *   - the governor      — standing rules / skills / forbidden paths.
 *
 * Layout (under the same per-project state dir as sessions and the governor):
 *   ~/.mindweave/projects/<slug>/memory/
 *     MEMORY.md      — the index: one line per memory, ALWAYS loaded into the
 *                      prompt. Capped, so it stays a cheap table of contents.
 *     <name>.md      — one topic file per memory, with a small frontmatter
 *                      header. Read on demand by the model (grep/read), not
 *                      auto-loaded.
 *
 * The model writes here through the `save_memory` tool, which saves SILENTLY: the
 * user asked not to be made to approve each one. (This comment used to say the tool
 * "confirms with the user first", which stopped being true when the prompt was
 * dropped — worth stating plainly, because "we ask first" is exactly the kind of
 * assurance someone reads once and then relies on.) This module is the mechanism
 * only — it does not decide WHAT is worth remembering; that is the model's
 * judgment, guided by the prompt.
 *
 * Like store.ts, this is the CLIENT side of the eventual client/server split:
 * the pure engine never calls in here. All writes are best-effort.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { projectDir } from "./store.js";

/** The closed set of memory types (mirrors the prompt's taxonomy). */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

export const MEMORY_INDEX = "MEMORY.md";
// Caps for the always-loaded index. Lines is the natural boundary; bytes catches
// a short index with very long lines. Past either, we load a prefix + a warning.
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

/** The memory directory for a project (under its state dir). */
export function memoryDir(projectCwd: string): string {
  return join(projectDir(projectCwd), "memory");
}

/** Create the memory directory if absent, so the model never has to mkdir. */
export async function ensureMemoryDir(projectCwd: string): Promise<void> {
  try {
    await fs.mkdir(memoryDir(projectCwd), { recursive: true });
  } catch {
    // Best-effort: a real perms error surfaces when save_memory's write fails.
  }
}

/**
 * Read MEMORY.md for injection into the prompt, truncated to the caps. Returns
 * "" when there is no index yet (the prompt then says memory is empty).
 */
export async function loadMemoryIndex(projectCwd: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(join(memoryDir(projectCwd), MEMORY_INDEX), "utf8");
  } catch {
    return "";
  }
  return truncateIndex(raw.trim());
}

/** Line-cap first (clean boundary), then byte-cap at the last newline that fits. */
function truncateIndex(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const overLines = lines.length > MAX_INDEX_LINES;
  const overBytes = content.length > MAX_INDEX_BYTES;
  if (!overLines && !overBytes) return content;

  let out = overLines ? lines.slice(0, MAX_INDEX_LINES).join("\n") : content;
  if (out.length > MAX_INDEX_BYTES) {
    const cut = out.lastIndexOf("\n", MAX_INDEX_BYTES);
    out = out.slice(0, cut > 0 ? cut : MAX_INDEX_BYTES);
  }
  return `${out}\n\n> WARNING: ${MEMORY_INDEX} is too long and was only partly loaded. Keep each index entry to one short line; move detail into the topic files.`;
}

/** A memory the model wants to persist. `indexLine` is the one-line hook for MEMORY.md. */
export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  indexLine: string;
}

export interface SavedMemory {
  name: string;
  file: string; // the topic file name, e.g. "user-role.md"
  updated: boolean; // true when it replaced an existing memory of the same name
  /**
   * Set only when the memory overwritten was filed under a DIFFERENT name.
   *
   * Names are slugified and clipped to 60 characters, so two distinct names can land
   * on one file — and then the write is not the update it appears to be, it is a
   * deletion. "Memory is non-destructive" is the stated reason the user is never
   * asked about a save, so the one case where that is untrue has to be reported
   * rather than absorbed.
   */
  replaced?: string;
}

/**
 * Write a memory: the topic file (frontmatter + body) plus its pointer line in
 * MEMORY.md. A memory whose name slugs to an existing file is an UPDATE — the
 * topic file is overwritten and its index line replaced in place, so the model
 * refining a fact never creates a duplicate.
 */
export async function saveMemory(projectCwd: string, m: MemoryInput): Promise<SavedMemory> {
  await ensureMemoryDir(projectCwd);
  const dir = memoryDir(projectCwd);
  const slug = slugify(m.name);
  const file = `${slug}.md`;
  const path = join(dir, file);

  const previous = await existingName(path);
  const updated = previous !== null;
  // Atomic: cross-session memory is the one thing here that OUTLIVES the session, so a
  // torn write costs a fact the user expected to be remembered permanently.
  await writeFileAtomic(path, renderMemoryFile(m));
  await upsertIndexLine(dir, file, `- [${oneLine(m.name)}](${file}) — ${oneLine(m.indexLine)}`);

  const replaced = previous && previous !== oneLine(m.name) ? previous : undefined;
  return { name: m.name, file, updated, ...(replaced ? { replaced } : {}) };
}

/** The `name:` of the memory already at `path`, or null if there is no file there.
 *  Returns "" for a file we cannot parse, which still counts as "something was here". */
async function existingName(path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return /^name:[ \t]*(.*)$/m.exec(raw)?.[1]?.trim() ?? "";
  } catch {
    return null;
  }
}

function renderMemoryFile(m: MemoryInput): string {
  // Flat key: value frontmatter, the same shape the governor and skills use.
  // Values are flattened to ONE line: these are model-supplied strings going into a
  // line-oriented format, so an embedded newline would start what parses as a new
  // frontmatter key — a `description` ending in "\ntype: user" would silently
  // re-file the memory. Nothing malicious is needed for this, just a pasted title.
  return [
    "---",
    `name: ${oneLine(m.name)}`,
    `description: ${oneLine(m.description)}`,
    `type: ${m.type}`,
    "---",
    "",
    m.body.trim(),
    "",
  ].join("\n");
}

/** Collapse any newline/carriage return into a space, so a value stays one field. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Add or replace the index line that points at `file`, keeping MEMORY.md a flat list. */
async function upsertIndexLine(dir: string, file: string, line: string): Promise<void> {
  const indexPath = join(dir, MEMORY_INDEX);
  let current = "";
  try {
    current = await fs.readFile(indexPath, "utf8");
  } catch {
    // No index yet.
  }

  // Drop this file's own pointer line, and ONLY that. The old test was
  // `line.includes("(file.md)")`, which matched anywhere in the line — so an index
  // entry whose prose referenced another memory ("supersedes (user-role.md)") was
  // deleted when that other memory was next saved. Index lines are model-written
  // prose about memories, so cross-references are the expected content, and losing
  // one silently removes a memory from the only listing that is always loaded.
  const isPointerTo = (l: string) => new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(file)}\\)`).test(l);
  if (current.trim()) {
    const kept = current
      .split("\n")
      .filter((l) => !isPointerTo(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    await writeFileAtomic(indexPath, `${kept}\n${line}\n`);
  } else {
    await writeFileAtomic(indexPath, `# Memory Index\n\n${line}\n`);
  }
}

/** A filesystem-safe slug from a memory name. Falls back to "memory" if empty. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "memory"
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
