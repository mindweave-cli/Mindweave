/**
 * trust.ts — whether Mindweave should ask before working in a folder.
 *
 * Opening somewhere is a permission decision, and it is the widest one there is: every
 * later guard is scoped to the workspace, so the workspace itself is the thing that has
 * to be chosen deliberately. Opened at `D:\` the workspace is the entire drive, and the
 * outside-the-workspace prompt — which exists precisely to catch a write somewhere the
 * user did not intend — can never fire, because nothing on that drive is outside it.
 *
 * Claude Code asks the same question on first open ("Is this a project you created or
 * one you trust?") and treats the home directory specially: trust is accepted for the
 * session and deliberately never written to disk. Same shape here, with drive and
 * filesystem roots joining home in that category, because they are broader still.
 */
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/** How much of the machine this root covers. */
export type Breadth = "ordinary" | "home" | "root";

/**
 * A root is "root" when it is a filesystem or drive root (`/`, `D:\`), "home" when it is
 * the user's home directory, and ordinary otherwise.
 */
export function rootBreadth(cwd: string): Breadth {
  const abs = resolve(cwd);
  if (abs === parse(abs).root) return "root";
  // Trailing separator normalised first: `C:\Users\me\` and `C:\Users\me` are one place.
  const trimmed = abs.endsWith(sep) ? abs.slice(0, -sep.length) : abs;
  const home = resolve(homedir());
  return trimmed.toLowerCase() === home.toLowerCase() ? "home" : "ordinary";
}

/**
 * Should a yes here be remembered for next time?
 *
 * No for the broad ones. Agreeing to work in your home directory once should not quietly
 * make it a trusted workspace forever — the answer was about today's task, and the folder
 * covers everything you own. Claude Code makes the same call for the same case.
 */
export function trustPersists(breadth: Breadth): boolean {
  return breadth === "ordinary";
}

/** What the screen says about a root, in the user's terms. */
export function breadthWarning(breadth: Breadth, cwd: string): string {
  switch (breadth) {
    case "root":
      return `This is a whole drive. Everything on ${resolve(cwd)} counts as the project, so nothing is outside it.`;
    case "home":
      return "This is your home directory. Everything you own counts as the project, including files that are nothing to do with code.";
    default:
      return "";
  }
}

/**
 * Has the user already agreed to work here?
 *
 * Recorded as a file in the project's own state directory rather than in a central
 * list, so it travels with everything else Mindweave keeps about that project and
 * disappears with it. A folder whose trust does not persist (home, a drive root) never
 * writes one, so it is asked every session by design.
 */
export function trustMarkerPath(stateDir: string): string {
  return join(stateDir, "trusted");
}

export function isTrusted(stateDir: string, breadth: Breadth): boolean {
  if (!trustPersists(breadth)) return false;
  return existsSync(trustMarkerPath(stateDir));
}

export function rememberTrust(stateDir: string, breadth: Breadth): void {
  if (!trustPersists(breadth)) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(trustMarkerPath(stateDir), `${new Date().toISOString()}\n`);
  } catch {
    // Best-effort: failing to record it means being asked again, which is safe.
  }
}
