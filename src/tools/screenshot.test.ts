/**
 * screenshot.test.ts — window matching, list parsing, and the refusal paths.
 *
 * Nothing here opens a window. The capture itself is Win32 talking to a live
 * desktop and CI has no interactive session, so mocking it would only assert the
 * mock. What IS tested is everything that decides WHICH window gets photographed
 * and whether the tool proceeds at all — the part where a mistake is a privacy
 * event rather than a wrong answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { parseWindowList, type WindowInfo } from "./screenshotWin.js";
import { pickWindow, listTitles, safeName, screenshot } from "./screenshot.js";

function win(title: string, handle = "1", foreground = false): WindowInfo {
  return { handle, title, foreground };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [], ...overrides } as ToolContext;
}

const IS_WINDOWS = process.platform === "win32";

// ── parseWindowList ──────────────────────────────────────────────────────────

test("parseWindowList reads handles, titles and the focus marker", () => {
  const windows = parseWindowList("-123\tVS Code\r\n*456\tGoogle Chrome\r\n");
  assert.deepEqual(windows, [
    { handle: "123", title: "VS Code", foreground: false },
    { handle: "456", title: "Google Chrome", foreground: true },
  ]);
});

test("parseWindowList skips anything that isn't a window line", () => {
  // PowerShell can put a warning or a blank line on stdout; neither is a window,
  // and guessing at a malformed line is how a wrong handle gets captured.
  const windows = parseWindowList("WARNING: something\n\n-7\tReal Window\nnot-a-handle\ttitle\n-8\t\n");
  assert.deepEqual(
    windows.map((w) => w.title),
    ["Real Window"],
  );
});

test("parseWindowList keeps tabs out of titles but not spaces", () => {
  const windows = parseWindowList("-9\tmy app — main window\n");
  assert.equal(windows[0]!.title, "my app — main window");
});

// ── pickWindow ───────────────────────────────────────────────────────────────

test("pickWindow with no query takes the focused window", () => {
  const pick = pickWindow(undefined, [win("Chrome", "1"), win("Editor", "2", true)]);
  assert.equal(pick.kind, "match");
  assert.equal(pick.kind === "match" && pick.window.title, "Editor");
});

test("pickWindow prefers an exact title over a longer window that contains it", () => {
  // The real case: "Mindweave" must not lose to "Mindweave — Settings" just
  // because both contain the word.
  const pick = pickWindow("mindweave", [win("Mindweave — Settings", "1"), win("Mindweave", "2")]);
  assert.equal(pick.kind === "match" && pick.window.title, "Mindweave");
});

test("pickWindow prefers a prefix over a mid-string match", () => {
  const pick = pickWindow("vite", [win("My App - vite dev server", "1"), win("Vite + React", "2")]);
  assert.equal(pick.kind === "match" && pick.window.title, "Vite + React");
});

test("pickWindow matches case-insensitively on a substring", () => {
  const pick = pickWindow("LOCALHOST", [win("app — localhost:5173", "1"), win("Notes", "2")]);
  assert.equal(pick.kind === "match" && pick.window.handle, "1");
});

test("pickWindow refuses to guess between equally good matches", () => {
  const pick = pickWindow("chrome", [win("Chrome — A", "1"), win("Chrome — B", "2")]);
  assert.equal(pick.kind, "ambiguous");
  assert.equal(pick.kind === "ambiguous" && pick.candidates.length, 2);
});

test("pickWindow breaks a tie toward the window the user is looking at", () => {
  const pick = pickWindow("chrome", [win("Chrome — A", "1"), win("Chrome — B", "2", true)]);
  assert.equal(pick.kind === "match" && pick.window.handle, "2");
});

test("pickWindow reports no match with the candidates it did see", () => {
  const pick = pickWindow("photoshop", [win("Chrome", "1"), win("Editor", "2")]);
  assert.equal(pick.kind, "none");
  assert.equal(pick.kind === "none" && pick.candidates.length, 2);
});

test("pickWindow reports none when nothing is open at all", () => {
  assert.equal(pickWindow("anything", []).kind, "none");
  assert.equal(pickWindow(undefined, []).kind, "none");
});

// ── listTitles / safeName ────────────────────────────────────────────────────

test("listTitles names the focused window and caps a long list", () => {
  const many = Array.from({ length: 15 }, (_, i) => win(`Window ${i}`, String(i), i === 0));
  const text = listTitles(many);
  assert.match(text, /Window 0 {2}\(focused\)/);
  assert.match(text, /… and 3 more/);
});

test("safeName turns a window title into a usable filename", () => {
  assert.equal(safeName("Vite + React — localhost:5173"), "vite-react-localhost-5173");
  assert.equal(safeName("///"), "window");
  assert.ok(safeName("x".repeat(200)).length <= 40);
});

// ── the tool's refusal paths ─────────────────────────────────────────────────
//
// The two permission-flow tests below are Windows-specific by construction, not by
// accident. Off Windows the tool refuses at its FIRST line — capture is a Win32
// path and there is nothing to fall back to — so the approval channel and the
// window matcher are never reached and neither assertion can hold. Running them
// anyway produced a red suite on Linux that said nothing about the product. The
// non-Windows behaviour gets its own test rather than being left uncovered.

test("screenshot refuses when there is no way to ask permission", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("the approval path is only reached on Windows; see the platform-refusal test");
    return;
  }
  // A sub-agent or a non-interactive run has no approval channel. It must not
  // inherit permission to photograph the desktop by default.
  const result = await screenshot.execute({ window: "anything" }, ctx());
  assert.equal(result.isError, undefined); // nothing broke; retrying won't help
  assert.match(result.output, /needs their approval/);
});

test("screenshot does not capture when the user says no", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("window matching is only reached on Windows; see the platform-refusal test");
    return;
  }
  let captured = false;
  const result = await screenshot.execute(
    { window: "definitely-no-such-window-xyzzy" },
    ctx({
      requestApproval: async () => {
        captured = true;
        return "No";
      },
    }),
  );
  // The window never matched, so approval was never even reached — which is the
  // ordering that matters: no window is named to the user before it is resolved.
  assert.equal(captured, false);
  assert.equal(result.isError, true);
});

test("off Windows, screenshot degrades before asking for anything", async (t) => {
  if (IS_WINDOWS) {
    t.skip("this is the non-Windows path");
    return;
  }
  let asked = false;
  const result = await screenshot.execute(
    { window: "anything" },
    ctx({
      requestApproval: async () => {
        asked = true;
        return "Yes";
      },
    }),
  );
  // Degrading, not erroring: an unsupported platform is a fact about the machine,
  // not a mistake the model should retry or work around.
  assert.equal(asked, false, "the user must not be prompted for a capture that cannot happen");
  assert.equal(result.isError, undefined);
  assert.match(result.output, /Windows-only/);
});

test("screenshot is offered as a read-only tool", () => {
  assert.equal(screenshot.readOnly, true);
});
