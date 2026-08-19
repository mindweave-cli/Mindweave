/**
 * ripgrep.ts — run the `rg` binary for fast, precise search.
 *
 * ripgrep is the precise, fast ground-truth scanner: it walks the tree itself
 * (memory-mapped, multithreaded), respects .gitignore, and streams back only
 * matches — the project is never loaded into the agent. We shell out to it and
 * parse the lines.
 *
 * WHERE THE BINARY COMES FROM, in order:
 *   1. `MINDWEAVE_RIPGREP_PATH`, for anyone who wants a specific build.
 *   2. The copy that ships with Mindweave (`@vscode/ripgrep`, an OPTIONAL dependency
 *      resolving to a per-platform package, so npm installs the one binary this machine
 *      needs and nothing is downloaded at install time).
 *   3. `rg` on PATH, for a system install.
 *
 * Bundling matters more than it sounds. The two search engines are NOT equivalent: only
 * ripgrep honours `.gitignore`, and the walk re-reads every candidate file in Node. A
 * user who never installs ripgrep silently gets the slower, less accurate one forever,
 * and nothing on screen says so — which is exactly the sort of invisible degradation
 * this project keeps finding after the fact.
 *
 * OPTIONAL, deliberately. If the platform package is missing — an unsupported
 * architecture, a locked-down registry, `--no-optional` — resolution simply falls
 * through and the pure-Node walk (walk.ts) still answers every search. Search getting
 * slower is an acceptable failure; `npm install mindweave` failing is not.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/**
 * The bundled binary's path, or undefined if this platform's package isn't installed.
 *
 * Resolved through `require.resolve` rather than an `import`, because the whole point is
 * that this may legitimately be absent: a static import of a missing optional dependency
 * is a module-load crash, and the fallback it was meant to allow never gets to run.
 */
function bundledRipgrep(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const binary = process.platform === "win32" ? "rg.exe" : "rg";
    return require.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`);
  } catch {
    return undefined;
  }
}

const RG = process.env.MINDWEAVE_RIPGREP_PATH || bundledRipgrep() || "rg";
const MAX_BUFFER = 20_000_000; // 20 MB — big monorepos can emit a lot of paths
const TIMEOUT_MS = 20_000;

let probe: Promise<boolean> | undefined;

/**
 * Force the built-in walker even where ripgrep is installed.
 *
 * Search has two engines and picks one from what happens to be on the machine, so
 * every run exercises exactly one of them: this machine has ripgrep, the CI runners
 * do not, and neither ever covered both. The two have already drifted apart once —
 * only ripgrep honoured `.gitignore` until v1.9.3, while both claimed to — and a
 * difference like that is invisible until someone runs the other path.
 *
 * Setting this lets one machine test both, which is what the CI matrix uses.
 */
const FORCED_OFF = process.env.MINDWEAVE_NO_RIPGREP === "1";

/** Which binary search will use, for diagnostics and for the test that proves the
 *  bundled one is actually reachable rather than merely declared in package.json. */
export function ripgrepPath(): string {
  return RG;
}

/** Reset the cached probe. Tests only — the env var is read per probe, not per call. */
export function resetRipgrepProbe(): void {
  probe = undefined;
}

/** True if `rg` is runnable. Probed once and cached for the session. */
export function ripgrepAvailable(): Promise<boolean> {
  if (FORCED_OFF) return Promise.resolve(false);
  if (!probe) {
    probe = new Promise<boolean>((resolve) => {
      try {
        const child = spawn(RG, ["--version"], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
  return probe;
}

export interface RgResult {
  /** stdout split into non-empty lines (CR stripped). */
  lines: string[];
  /** rg exit code: 0 = matches, 1 = no matches, 2 = usage/regex error. */
  code: number | null;
  stderr: string;
  /** True if output hit the buffer cap and was cut. */
  truncated: boolean;
}

/** Run ripgrep with `args`, working from `cwd`. Never throws — failures surface
 *  in the returned code/stderr so the tool can report them cleanly. */
export function runRipgrep(args: string[], cwd: string): Promise<RgResult> {
  return new Promise<RgResult>((resolve) => {
    let out = "";
    let err = "";
    let truncated = false;
    let settled = false;

    const finish = (code: number | null, stderr: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = out
        .split("\n")
        .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
        .filter(Boolean);
      resolve({ lines, code, stderr: stderr.trim(), truncated });
    };

    let child;
    try {
      child = spawn(RG, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ lines: [], code: -1, stderr: String(error), truncated: false });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null, "ripgrep timed out");
    }, TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      if (truncated) return;
      out += d.toString("utf8");
      if (out.length > MAX_BUFFER) {
        out = out.slice(0, MAX_BUFFER);
        truncated = true;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 8192) err += d.toString("utf8");
    });
    child.on("error", () => finish(-1, "ripgrep failed to start"));
    child.on("close", (code) => finish(code, err));
  });
}
