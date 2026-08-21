#!/usr/bin/env node
/**
 * Mindweave — entry point.
 *
 * This file does one thing: start the terminal UI. It deliberately stays tiny.
 * All real logic lives in its own lane (cli / dynamo / tools / memory / alternator)
 * so the project stays easy to understand as it grows.
 *
 * The shebang above + the `bin` entry in package.json make this the `mindweave`
 * command: install once (`npm link` / `npm i -g`), then `cd` into any project and
 * type `mindweave`. The session roots at the current directory (process.cwd()), so it
 * just works wherever you run it.
 */
import { render } from "ink";
import { createElement } from "react";
import { App } from "./cli/App.js";
import { loadConfig } from "./cli/bootstrap.js";
import { sweepTempInBackground } from "./tools/tempSweep.js";
import { parseStartupArgs } from "./cli/startupArgs.js";
import { enterAltScreen } from "./cli/altScreen.js";
import { TERMINAL_RESTORE } from "./cli/terminalRestore.js";
import { instrumentStdout, flush as flushPerf, perf, perfEnabled } from "./cli/perfLog.js";
import { MAX_FPS } from "./cli/frameRate.js";
import { framebufferStdout } from "./cli/framebuffer/writer.js";

// --help / --version answer and exit, BEFORE anything reads config, sweeps a
// directory, or starts the UI. They used to fall through to the interactive app,
// which then hung forever with no TTY to render into — the one thing a packaging
// tool or a script does with a new CLI.
const startup = parseStartupArgs(process.argv.slice(2));
if (startup.kind === "print") {
  process.stdout.write(startup.text + "\n");
  process.exit(0);
}
if (startup.kind === "reset") {
  // Repairing a terminal a dead run left in mouse-reporting mode. Nothing else may run
  // first: this is typed when the terminal is already misbehaving, and loading config or
  // sweeping temp would only add ways for it to fail before it writes the one thing it
  // came to write. Escapes go out only to a real terminal, since into a pipe they would
  // be corruption rather than repair.
  if (process.stdout.isTTY) {
    process.stdout.write(TERMINAL_RESTORE);
    process.stdout.write("terminal restored\n");
  } else {
    process.stdout.write("not a terminal, nothing to restore\n");
  }
  process.exit(0);
}

// Load config (global ~/.mindweave/.env + project .env) so provider API keys are
// available no matter which project we're launched in.
loadConfig();

// Clear out the temp files and directories earlier runs left behind: screenshots past
// their retention window, and the scratch (cwd hand-off files, command wrappers, test
// fixtures) that every call site removes on its way out and nothing removes when a run
// ends badly. Startup rather than shutdown precisely because that catches what a crash
// left behind, and detached so a slow or unreadable temp directory cannot delay the UI.
sweepTempInBackground();

// Times every frame the renderer writes to the real terminal. No-op unless
// MINDWEAVE_PERF names a file — see cli/perfLog.ts for why this cannot be measured
// from a test probe.
instrumentStdout(process.stdout);
process.on("exit", flushPerf);

enterAltScreen();

// Ink renders into a FRAMEBUFFER rather than straight to the terminal: each frame is
// parsed into a cell grid, diffed against what is already on screen, and only the
// cells that actually differ are written. Measured on a transcript-shaped screen,
// that is ~13x fewer bytes per frame (2,345 -> 178). See `cli/framebuffer/`.
//
// `incrementalRendering` is deliberately NOT enabled alongside it, and this is load
// bearing rather than a preference: that mode makes Ink emit only the LINES it thinks
// changed, interleaved with its own cursor movements, instead of a complete frame.
// The framebuffer's parser expects a whole frame — a partial one would be read as a
// full screen and everything it omitted would be blanked. One diff or the other, and
// ours is per-cell where Ink's is per-line.
// The frame-rate cap is what sets typing latency — see `cli/frameRate.ts` for the
// measurements and for why it is a timer rather than a cost.
render(createElement(App), {
  maxFps: MAX_FPS,
  stdout: framebufferStdout(process.stdout, perfEnabled() ? (s) => perf(`frame in=${s.inBytes} out=${s.outBytes}`) : undefined) as unknown as NodeJS.WriteStream,
});
