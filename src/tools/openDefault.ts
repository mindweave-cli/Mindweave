/**
 * openDefault.ts — a command that names a browser is rewritten to use the user's own.
 *
 * Opening a file "in a browser" to show it to someone has exactly one correct target: the
 * browser they actually use. A model does not know which that is, so it guesses a name it
 * has seen before — `msedge` on Windows — and a window opens in an application the user
 * may never have chosen, next to the browser they already had open.
 *
 * Telling the model not to do that does not work. It was tried as a line in run_command's
 * description, which is the most-read place a rule can sit, and the very next run still
 * launched Edge by name. A rule a model has to remember under load is a rule that gets
 * dropped, so this is the mechanical version: the command is rewritten on the way to the
 * shell, and there is nothing left to remember.
 *
 * WHAT IS DELIBERATELY LEFT ALONE. A browser invoked with flags is not someone being shown
 * a page — it is automation (`--headless` for a render, a profile for a test) where the
 * specific binary is the point. Rewriting that would break real work to fix a presentation
 * problem, so anything carrying flags passes through untouched.
 */

/** Browser executables a model reaches for, matched on the program name alone. */
const BROWSERS = new Set([
  "msedge",
  "microsoft-edge",
  "chrome",
  "googlechrome",
  "google-chrome",
  "chromium",
  "firefox",
  "iexplore",
  "brave",
  "opera",
  "vivaldi",
  "safari",
]);

/** Words that only introduce a command; the program being launched is what follows. */
const LAUNCHERS = new Set(["start", "start-process", "&", "cmd", "/c", "/k", "-filepath"]);

export interface DefaultOpen {
  /** The command to run instead. */
  command: string;
  /** The browser that was named, for telling the model what changed. */
  browser: string;
  /** What is being opened. */
  target: string;
}

/** Split on whitespace, keeping quoted runs together and remembering nothing else. */
function tokenize(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

const unquote = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;

/** The program name from a token that may be a bare name or a full path, with or without
 *  an extension: `msedge`, `msedge.exe`, `"C:\...\Application\chrome.exe"`. */
function programName(token: string): string {
  const bare = unquote(token);
  const base = bare.split(/[\\/]/).pop() ?? bare;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/** The command that hands something to the system to open with whatever the user has set. */
function openWith(target: string, platform: NodeJS.Platform): string {
  const quoted = `"${target}"`;
  if (platform === "win32") return `Start-Process ${quoted}`;
  if (platform === "darwin") return `open ${quoted}`;
  return `xdg-open ${quoted}`;
}

/**
 * If `command` launches a named browser on one file or URL, the equivalent that opens it
 * in the user's default application instead. Null when the command is anything else —
 * including a browser run with flags, which is automation rather than a page being shown.
 */
export function defaultOpenRewrite(command: string, platform: NodeJS.Platform = process.platform): DefaultOpen | null {
  // A CHAIN is the shape this actually arrives in, and refusing to touch chains is why
  // the first version of this never fired once in real use. What the model writes is
  //
  //     Start-Process msedge file:///…/mockup.html; Start-Sleep -Seconds 3
  //
  // — launch, then wait for the window to appear — so the only form that mattered was
  // the one being skipped. Each link is rewritten on its own and the rest is passed
  // through untouched, which is both safer and more useful than declining the lot.
  const links = splitChain(command);
  if (links.length > 1) {
    let found: DefaultOpen | undefined;
    const rebuilt = links.map((link) => {
      if (link.separator) return link.text;
      const one = rewriteOne(link.text.trim(), platform);
      if (!one) return link.text;
      if (!found) found = one;
      // Keep the original spacing around the link so the chain reads as it was written.
      return link.text.replace(link.text.trim(), one.command);
    });
    return found ? { browser: found.browser, target: found.target, command: rebuilt.join("") } : null;
  }
  return rewriteOne(command.trim(), platform);
}

/** One link of a chain, or the separator between two. Quotes are respected, so a
 *  semicolon inside a path is not mistaken for the end of a command. */
function splitChain(command: string): { text: string; separator: boolean }[] {
  const parts: { text: string; separator: boolean }[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (ch === ";" || two === "&&" || two === "||" || (ch === "|" && command[i + 1] !== "|")) {
      const sep = ch === ";" || ch === "|" ? ch : two;
      parts.push({ text: buf, separator: false });
      parts.push({ text: sep, separator: true });
      buf = "";
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  parts.push({ text: buf, separator: false });
  return parts;
}

/** The rewrite for a single command with no chaining in it. */
function rewriteOne(command: string, platform: NodeJS.Platform): DefaultOpen | null {
  const tokens = tokenize(command.trim());
  if (tokens.length < 2) return null;

  let i = 0;
  while (i < tokens.length && LAUNCHERS.has(programName(tokens[i]!))) i++;
  // `start "" chrome url` — cmd's title argument, an empty quoted string.
  while (i < tokens.length && unquote(tokens[i]!) === "") i++;
  if (i >= tokens.length) return null;

  const browser = programName(tokens[i]!);
  if (!BROWSERS.has(browser)) return null;

  const rest = tokens.slice(i + 1).map(unquote).filter((t) => t !== "");
  // Flags mean automation; leave it alone. `-ArgumentList` is PowerShell's way of passing
  // the same single target, so it is skipped rather than treated as a flag.
  const args = rest.filter((t) => t.toLowerCase() !== "-argumentlist");
  if (args.length !== 1) return null;
  const target = args[0]!;
  if (target.startsWith("-") || target.startsWith("/")) return null;

  return { command: openWith(target, platform), browser, target };
}
