/**
 * store.ts — where sessions live on disk.
 *
 * Sessions are persisted OUTSIDE the project, under the user's home directory
 * (`~/.mindweave/projects/<sanitized-project-path>/`), keyed by which project they
 * belong to. This keeps a project's git tree
 * clean while still letting you resume exactly where you left off, per project.
 *
 * Each session is two files:
 *   <id>.jsonl       — the transcript, one Entry per line (append-friendly, but
 *                      rewritten wholesale at end of turn so compaction's edits
 *                      to earlier entries are reflected — a transcript is bounded
 *                      by compaction, so the rewrite is cheap).
 *   <id>.meta.json   — small descriptor (prompts, timestamps) the resume picker
 *                      reads without parsing the whole transcript.
 *
 * All persistence is best-effort: a failed write logs nothing and never breaks a
 * turn (the in-memory session is the source of truth during a run). This is the
 * CLIENT side of the eventual client/server split — the pure engine never calls
 * anything in here.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Entry, Session, SessionMeta } from "./types.js";

/** Turn a project path into a single safe directory name (e.g. `D:\proj` → `D--proj`). */
export function sanitizeProjectPath(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/**
 * The per-project state directory under the user's home: where everything Mindweave
 * keeps for a given project lives — sessions today, and per-project rules /
 * skills / forbidden (the governor). One scheme, one source of truth, so a
 * project's state is always filed under the same key.
 */
export function projectDir(projectCwd: string): string {
  return join(homedir(), ".mindweave", "projects", sanitizeProjectPath(projectCwd));
}

/** The directory holding all sessions for a given project (its state dir). */
export function sessionDir(projectCwd: string): string {
  return projectDir(projectCwd);
}

function transcriptPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.jsonl`);
}

/** Sidecar file holding a session's maintained "session memory" notes. */
function notesPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.notes.md`);
}

/** Load a session's session-memory notes, or "" if none. */
export async function loadSessionNotes(projectCwd: string, id: string): Promise<string> {
  try {
    return (await fs.readFile(notesPath(projectCwd, id), "utf8")).trim();
  } catch {
    return "";
  }
}

function metaPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.meta.json`);
}

function firstUserText(transcript: Entry[]): string {
  return transcript.find((e) => e.role === "user")?.content.trim() ?? "";
}

/** The last thing the PERSON said. Engine-written nudges arrive as `user` messages so
 *  the model treats them as instruction, but they are not prompts and must not be
 *  shown as one — this is what the session picker labels a session with. */
function lastUserText(transcript: Entry[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role === "user" && !e.synthetic) return e.content.trim();
  }
  return "";
}

function clip(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Write the session to disk (transcript + meta). Best-effort: returns false on
 * any failure instead of throwing, so a persistence hiccup never aborts a turn.
 */
export async function saveSession(session: Session): Promise<boolean> {
  try {
    const dir = sessionDir(session.cwd);
    await fs.mkdir(dir, { recursive: true });

    const lines = session.transcript.map((e) => JSON.stringify(e)).join("\n");
    await fs.writeFile(transcriptPath(session.cwd, session.id), lines + "\n", "utf8");

    // Extra roots = everything on the tool context beyond the primary (session.cwd).
    const extraRoots = (session.toolContext.roots ?? []).filter((r) => r !== session.cwd);
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      firstPrompt: clip(firstUserText(session.transcript)),
      lastPrompt: clip(lastUserText(session.transcript)),
      entryCount: session.transcript.length,
      ...(extraRoots.length > 0 ? { extraRoots } : {}),
      // Only once something has actually been spent, so a session that never ran a turn
      // does not carry a row of zeroes claiming to be a measurement.
      ...(session.spend && session.spend.turns > 0 ? { spend: session.spend } : {}),
      // The per-call breakdown, which is what makes a surprising bill diagnosable: the
      // totals above are identical whether a turn made one expensive call or six cheap
      // ones, and that difference is the whole answer.
      ...(session.callLog && session.callLog.length > 0 ? { callLog: session.callLog } : {}),
    };
    await fs.writeFile(metaPath(session.cwd, session.id), JSON.stringify(meta, null, 2), "utf8");

    // Session-memory notes sidecar (the maintained running state), when present.
    if (session.sessionMemory && session.sessionMemory.trim()) {
      await fs.writeFile(notesPath(session.cwd, session.id), session.sessionMemory, "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/** Load a session's transcript from disk, or null if it isn't there / is unreadable. */
export async function loadTranscript(projectCwd: string, id: string): Promise<Entry[] | null> {
  try {
    const raw = await fs.readFile(transcriptPath(projectCwd, id), "utf8");
    const entries: Entry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as Entry);
      } catch {
        // Skip a corrupt line rather than losing the whole session.
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Load one session's descriptor (for resume — carries extraRoots/createdAt), or null. */
export async function loadMeta(projectCwd: string, id: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(projectCwd, id), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

/** List this project's sessions, most-recently-updated first. */
export async function listSessions(projectCwd: string): Promise<SessionMeta[]> {
  const dir = sessionDir(projectCwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const raw = await fs.readFile(join(dir, name), "utf8");
      metas.push(JSON.parse(raw) as SessionMeta);
    } catch {
      // Skip unreadable/corrupt meta files.
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recent session for this project, or null if there are none. */
export async function latestSession(projectCwd: string): Promise<SessionMeta | null> {
  return (await listSessions(projectCwd))[0] ?? null;
}
