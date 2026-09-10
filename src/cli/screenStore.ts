/**
 * screenStore.ts — remembering which shell a project is worked in.
 *
 * Beside the model config, in the project's own directory under `~/.mindweave`, for the
 * same reason that one lives there: it is a decision about how you work on THIS project,
 * not a global preference and not something to carry in the repository.
 *
 * Its own tiny file rather than a field on the model config, so a write here can never
 * damage or race the thing that decides which provider answers. Both are best-effort:
 * failing to remember a preference is worth nothing at all next to failing to start.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";
import { parseSavedMode, type ScreenMode } from "./screenMode.js";

function screenPath(projectCwd: string): string {
  return join(projectDir(projectCwd), "screen.json");
}

/**
 * The shell this project was last left in, or null.
 *
 * Null for every reason: never saved, unreadable, corrupt, or holding a word that is not
 * a mode any more. The caller falls back to the default, which is what someone who has
 * never chosen would get — the safe direction, because a session that opens in the wrong
 * shell is fixed by one command, while a session that fails to open is not.
 */
export async function loadScreenMode(projectCwd: string): Promise<ScreenMode | null> {
  try {
    const raw = await fs.readFile(screenPath(projectCwd), "utf8");
    return parseSavedMode((JSON.parse(raw) as { screen?: unknown }).screen);
  } catch {
    return null;
  }
}

/** Remember the shell for next time. Best-effort. */
export async function saveScreenMode(projectCwd: string, mode: ScreenMode): Promise<void> {
  try {
    await fs.mkdir(projectDir(projectCwd), { recursive: true });
    await fs.writeFile(screenPath(projectCwd), JSON.stringify({ screen: mode }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}
