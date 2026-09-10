/**
 * appIdentity.ts — what the app calls itself to the terminal and the OS.
 *
 * By default a Node program is anonymous: the terminal tab keeps whatever the shell put
 * there ("Command Prompt", a path), and a process list shows "node" / "Node.js
 * JavaScript Runtime". Neither says what is actually running. This gives the session a
 * name in the two places a name is cheap to set from inside the process.
 *
 * ## The terminal tab
 *
 * `OSC 2 ; <title> BEL` sets the window/tab title, and every VT-descended terminal —
 * Windows Terminal included — honours it unless a profile is pinned to a fixed tab name.
 * Written once at startup, before the alternate screen and the framebuffer take over, so
 * it is a plain control write and nothing diffs it as a frame.
 *
 * ## The process name
 *
 * `process.title` renames the process where the platform lets it. On Linux and macOS it
 * changes what `ps` and most monitors show. On Windows it sets the console title but does
 * NOT change the image name Task Manager shows (that is `node.exe`, taken from the
 * executable's own version resource) — changing THAT needs a renamed/repackaged binary,
 * which is a build-time concern, not something a running process can do to itself. Set
 * here anyway: it is correct where it works and harmless where it does not.
 */

/** The one place the display name lives, so the tab, the process and any future use agree. */
export const APP_NAME = "Mindweave";

const BEL = "\x07";

/** The OSC sequence that sets the terminal's window/tab title (pure). */
export function setTitleSequence(title: string): string {
  return `\x1b]2;${title}${BEL}`;
}

/**
 * Name the session to the terminal and the OS. Best-effort and silent: a failure here
 * must never be the reason the app does not start.
 *
 * @param write how to reach the real terminal — injected so a test can observe it and so
 *   the caller controls whether it is the raw stdout or a wrapper.
 */
export function nameSession(write: (data: string) => void = (d) => void process.stdout.write(d)): void {
  try {
    process.title = APP_NAME;
  } catch {
    // Some platforms refuse to rename the process; the tab title below still works.
  }
  try {
    if (process.stdout.isTTY) write(setTitleSequence(APP_NAME));
  } catch {
    // No terminal, or a closed stream. Nothing to name.
  }
}
