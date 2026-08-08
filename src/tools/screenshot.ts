/**
 * screenshot.ts — let the agent SEE a running window.
 *
 * This closes the loop v1.5 tried to close with process liveness. "Did the app
 * come up" was answered by "the process is still alive", which is not the same
 * question: a window that renders a stack trace is alive. Looking at it answers
 * it properly, and the same applies to a layout that is subtly wrong, a chart
 * with no data, or a dialog nobody expected.
 *
 * CAPTURE ONLY. There is no clicking, typing, or moving anything, and that is a
 * scope decision rather than a missing feature. Seeing closes the verification
 * loop; acting is a different product with a far larger risk surface, and it does
 * not belong in a small core.
 *
 * ## Privacy is the design, not a footnote
 *
 * A screenshot is the one tool here that can capture things the agent was never
 * pointed at — another project, an inbox, a password manager, a token sitting in
 * a scrollback — and then send them to a model provider. So:
 *
 *  - **One window, never the screen.** There is no full-desktop mode. The blast
 *    radius of a mistake is one window instead of everything open.
 *  - **The user approves the specific window, by title, before anything is
 *    captured.** Not after, and not once for the session.
 *  - **No approval channel means no capture.** A context that cannot ask (a
 *    sub-agent, a non-interactive run) is refused rather than defaulted to yes.
 *
 * ## Where the picture goes
 *
 * The tool returns a ref, not bytes, and the engine decides what to do with it —
 * hand it to a model that can see, or tell one that can't where the file is. That
 * split is `feedback-universal-core-only`: the capability is stated once and core
 * degrades, rather than every tool learning which providers have eyes.
 */
import { mkdtemp } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { describeImage, isRejection } from "../memory/images.js";
import { captureWindow, listWindows, type WindowInfo } from "./screenshotWin.js";

/** How many titles to name when a match fails, so the model can retry precisely. */
const MAX_LISTED = 12;

/** What matching a `window` argument against the open windows produced. */
export type WindowPick =
  | { kind: "match"; window: WindowInfo }
  | { kind: "none"; candidates: WindowInfo[] }
  | { kind: "ambiguous"; candidates: WindowInfo[] };

/**
 * Choose the window to capture. Pure, and the whole of the matching policy.
 *
 * Ranked rather than first-wins, because a substring hits chrome ("Settings")
 * far more often than it hits the thing meant. An exact title beats a prefix
 * beats a substring, and an unambiguous winner at any tier ends it — so
 * "Mindweave" picks the editor window titled exactly that even while three other
 * windows mention it. A genuine tie is reported rather than guessed: capturing
 * the wrong window is a privacy event, not just a wrong answer.
 */
export function pickWindow(query: string | undefined, windows: WindowInfo[]): WindowPick {
  if (windows.length === 0) return { kind: "none", candidates: [] };

  if (!query) {
    const focused = windows.find((w) => w.foreground);
    return focused ? { kind: "match", window: focused } : { kind: "ambiguous", candidates: windows };
  }

  const needle = query.trim().toLowerCase();
  const titled = windows.map((w) => ({ w, t: w.title.toLowerCase() }));
  const tiers = [
    titled.filter(({ t }) => t === needle),
    titled.filter(({ t }) => t.startsWith(needle)),
    titled.filter(({ t }) => t.includes(needle)),
  ];

  for (const tier of tiers) {
    if (tier.length === 1) return { kind: "match", window: tier[0]!.w };
    if (tier.length > 1) {
      // Several equally good matches, but if exactly one has focus the user is
      // looking at it, and that is a better answer than refusing.
      const focused = tier.filter(({ w }) => w.foreground);
      if (focused.length === 1) return { kind: "match", window: focused[0]!.w };
      return { kind: "ambiguous", candidates: tier.map(({ w }) => w) };
    }
  }
  return { kind: "none", candidates: windows };
}

/** Render window titles for an error the model can act on without another call. */
export function listTitles(windows: WindowInfo[]): string {
  if (windows.length === 0) return "No capturable windows are open.";
  const shown = windows.slice(0, MAX_LISTED);
  const lines = shown.map((w) => `  - ${w.title}${w.foreground ? "  (focused)" : ""}`);
  const hidden = windows.length - shown.length;
  if (hidden > 0) lines.push(`  … and ${hidden} more`);
  return `Open windows:\n${lines.join("\n")}`;
}

export const screenshot: Tool = {
  name: "screenshot",
  // An observation: it changes nothing about the project. The privacy gate below
  // is explicit and runs whether or not the session is in a guarded mode.
  readOnly: true,
  description:
    "Take a picture of one open window and look at it. Use it to check that an app " +
    "actually came up and renders correctly — a running process is not proof of that — " +
    "or to see a layout, a chart, or an error dialog for yourself. " +
    "Pass `window` with part of the window's title; leave it out to capture the window " +
    "the user is currently focused on. " +
    "The user is asked to approve the specific window first, so call it when looking " +
    "will genuinely tell you something, not as a routine check. " +
    "Windows only, one window at a time — the whole screen is never captured, and " +
    "nothing can be clicked or typed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      window: {
        type: "string",
        description:
          "Part of the target window's title, e.g. \"Vite\" or \"localhost\". " +
          "Omit to capture whichever window has focus.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const query = typeof args.window === "string" && args.window.trim() ? args.window.trim() : undefined;

    if (process.platform !== "win32") {
      return degrade(
        `Screenshots are Windows-only for now, and this is ${process.platform}. ` +
          `Ask the user to describe what they see, or check the app another way.`,
        "screenshot unsupported on this platform",
      );
    }

    // No way to ask means no capture. A sub-agent or a non-interactive run must not
    // silently inherit permission to photograph the user's desktop.
    if (!ctx.requestApproval) {
      return degrade(
        "Cannot take a screenshot from here: capturing the user's screen needs their " +
          "approval and there is no way to ask in this context. Ask the user to run it " +
          "in the main session, or verify another way.",
        "cannot ask to screenshot",
      );
    }

    let windows: WindowInfo[];
    try {
      windows = await listWindows(ctx.abortSignal);
    } catch (error) {
      return fail(`Could not list open windows: ${message(error)}`);
    }

    const pick = pickWindow(query, windows);
    if (pick.kind === "none") {
      return fail(
        query
          ? `No open window's title contains "${query}". ${listTitles(pick.candidates)}`
          : `There is no window to capture. ${listTitles(pick.candidates)}`,
      );
    }
    if (pick.kind === "ambiguous") {
      return fail(
        `"${query ?? "(focused window)"}" matches ${pick.candidates.length} windows, so it is not clear ` +
          `which to capture. Name one more precisely:\n${listTitles(pick.candidates)}`,
      );
    }

    const target = pick.window;
    const choice = await ctx.requestApproval(
      `Take a screenshot of "${target.title}"? The image is sent to the model.`,
      ["Yes, capture it", "No"],
    );
    if (!choice.startsWith("Yes")) {
      return degrade(
        `The user declined the screenshot of "${target.title}". Do not ask again for the ` +
          `same window; verify another way or ask them what they see.`,
        "screenshot declined",
      );
    }

    try {
      const dir = await mkdtemp(join(tmpdir(), "mindweave-shot-"));
      const path = join(dir, `${safeName(target.title)}.png`);
      const size = await captureWindow(target.handle, path, ctx.abortSignal);
      const bytes = (await stat(path)).size;

      // The same validation a user's attachment goes through — caps and dimension
      // limits live in one place rather than being re-implemented per producer.
      const ref = await describeImage(path, bytes);
      if (isRejection(ref)) return fail(`Captured "${target.title}" but cannot use the image: ${ref.reason}`);

      return {
        output:
          `Captured "${target.title}" (${size.width}x${size.height}). ` +
          `The image follows this result — look at it and say what you see.`,
        summary: `screenshot of ${target.title} (${size.width}x${size.height})`,
        images: [ref],
      };
    } catch (error) {
      return fail(`Could not capture "${target.title}": ${message(error)}`);
    }
  },
};

/** A window title, reduced to something safe to put in a filename. */
export function safeName(title: string): string {
  const cleaned = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned.toLowerCase() || "window";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Not an error: nothing broke and retrying will not change the answer. */
function degrade(output: string, summary: string): ToolResult {
  return { output, summary };
}

function fail(text: string): ToolResult {
  return { output: `Error: ${text}`, isError: true, summary: text.slice(0, 80) };
}
