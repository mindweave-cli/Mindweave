/**
 * updateRunner.ts — the side effects `/update` needs, and nothing else.
 *
 * The decisions live in `selfUpdate.ts` (where this copy is, and what may be done about
 * it) and `restart.ts` (how the terminal is handed over). Both are pure and tested
 * exhaustively. This file is the thin layer that gives them a real filesystem, a real
 * npm and a real process, and it is deliberately small: every line here is one that
 * cannot be tested without doing the thing it describes.
 *
 * The one piece of state is the pending restart. It exists because the relaunch cannot
 * happen inside the UI — the terminal has to be handed over AFTER Ink has unmounted, and
 * Ink unmounting is what ends the render. So the command records an intention, the app
 * closes normally through the path it always uses, and `index.ts` reads the intention
 * once everything is down. A callback held across that boundary would be a callback
 * running inside a component that no longer exists.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyInstall, updateCommand, type Install, type InstallProbe } from "./selfUpdate.js";

/** How long npm gets before the update is abandoned. */
const INSTALL_TIMEOUT_MS = 180_000;

/** The real filesystem, as the two questions `classifyInstall` asks of it. */
const realProbe: InstallProbe = {
  isLink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      // Not there, or not readable. Either way it is not a link we are following.
      return false;
    }
  },
  exists: (path) => existsSync(path),
};

/** The directory holding our package.json — the same two-levels-up walk `version.ts`
 *  uses, and correct from both `dist/cli/` and `src/cli/`. */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Where this copy of Mindweave is installed, and what may be done about it. */
export function currentInstall(): Install {
  return classifyInstall(packageRoot(), realProbe);
}

/** What running npm produced. */
export interface InstallResult {
  ok: boolean;
  /** The last few lines of npm's own output, for a failure worth reading. */
  message: string;
}

/**
 * Run the update, and report only whether it worked.
 *
 * npm is spawned WITHOUT a shell and with its arguments as an array, so a prefix
 * containing a space — `C:\Users\Some Name\AppData\Roaming\npm` is the ordinary case on
 * Windows — is passed as one argument rather than reassembled and re-split by a shell.
 *
 * A failure here is a no-op, not a half-state: npm either replaced the package or it did
 * not, the old copy is still installed and still running, and nothing else has been
 * touched yet. That is what makes it safe to simply report and carry on.
 */
export function runUpdate(prefix: string, version = "latest"): Promise<InstallResult> {
  const { command, args } = updateCommand(prefix, version);
  return new Promise((resolve) => {
    // `npm` on Windows is a .cmd, which cannot be spawned without a shell. `shell: true`
    // is therefore unavoidable HERE — and it is why every value in `args` is one we
    // built, never one a user typed.
    const child = spawn(command, args, { shell: process.platform === "win32", windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Only the tail is ever shown, so only the tail is worth keeping.
      if (output.length > 8_000) output = output.slice(-8_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: `npm did not finish within ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s.` });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    const settle = (result: InstallResult) => {
      clearTimeout(timer);
      resolve(result);
    };
    child.on("error", (err) => settle({ ok: false, message: `npm could not be started: ${err.message}` }));
    child.on("close", (code) => {
      settle(code === 0 ? { ok: true, message: "" } : { ok: false, message: lastLines(output, 8) });
    });
  });
}

/** The last `count` non-empty lines, which is where npm puts the reason. */
function lastLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return lines.slice(-count).join("\n");
}

/** Everything the relaunch needs, recorded by the command and read by `index.ts`. */
export interface PendingRestart {
  packageRoot: string;
  sessionId?: string;
  previousVersion: string;
  prefix: string;
}

let pending: PendingRestart | undefined;

/** Ask for a relaunch once the UI is down. */
export function requestRestart(intent: PendingRestart): void {
  pending = intent;
}

/** Take the request, if there is one. Reading it clears it, so a relaunch cannot
 *  happen twice from one intention. */
export function takePendingRestart(): PendingRestart | undefined {
  const intent = pending;
  pending = undefined;
  return intent;
}
