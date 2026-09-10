/**
 * clipboard.ts — put selected text on the system clipboard.
 *
 * Two routes, tried in order, because neither alone covers where a terminal runs.
 *
 * OSC 52 asks the TERMINAL to set the clipboard. It is one escape sequence on the stream
 * already open, it needs no child process, and it is the only thing that works over SSH,
 * where the machine running this has no clipboard of its own. Terminals may refuse it,
 * and there is no reply to say whether they did.
 *
 * So a local helper runs as well when there is one. Writing the same text twice is
 * harmless: both routes set the same clipboard to the same string, and whichever the
 * terminal honours, the result is what the user selected.
 */
import { spawn } from "node:child_process";

/** Above this, skip OSC 52. Terminals cap what they accept and a truncated paste is
 *  worse than one route quietly not firing; the local helper has no such limit. */
const OSC52_MAX_BYTES = 100_000;

/** The command that owns the clipboard on this platform, if one ships with it. */
function helper(): { command: string; args: string[] } | null {
  if (process.platform === "win32") return { command: "clip", args: [] };
  if (process.platform === "darwin") return { command: "pbcopy", args: [] };
  // Wayland first, then X11. Both are absent on a headless machine, where OSC 52 is
  // the only route anyway.
  return { command: "wl-copy", args: [] };
}

/**
 * The escape sequence that hands `text` to the terminal.
 *
 * Exported for tests: the encoding is the part that can be wrong, and it is not
 * observable from the outside once written to a stream.
 */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/**
 * Copy `text`. Never throws and never rejects: a clipboard that does not take is a
 * disappointment, not an error worth interrupting the session for.
 */
export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): void {
  if (text === "") return;

  if (Buffer.byteLength(text, "utf8") <= OSC52_MAX_BYTES) {
    try {
      out.write(osc52(text));
    } catch {
      // A closed or non-writable stream is not worth reporting here.
    }
  }

  const local = helper();
  if (!local) return;
  try {
    const child = spawn(local.command, local.args, { stdio: ["pipe", "ignore", "ignore"] });
    // A missing helper surfaces as an error event, not a throw, and means nothing more
    // than "this platform did not have that one".
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  } catch {
    // Spawning can fail outright on a locked-down system. OSC 52 may still have worked.
  }
}
