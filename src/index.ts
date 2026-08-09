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
import { sweepCapturesInBackground } from "./tools/captureSweep.js";
import { parseStartupArgs } from "./cli/startupArgs.js";

// --help / --version answer and exit, BEFORE anything reads config, sweeps a
// directory, or starts the UI. They used to fall through to the interactive app,
// which then hung forever with no TTY to render into — the one thing a packaging
// tool or a script does with a new CLI.
const startup = parseStartupArgs(process.argv.slice(2));
if (startup.kind === "print") {
  process.stdout.write(startup.text + "\n");
  process.exit(0);
}

// Load config (global ~/.mindweave/.env + project .env) so provider API keys are
// available no matter which project we're launched in.
loadConfig();

// Clear out screenshots older than the retention window. A capture holds whatever was
// on screen when it was taken, so they should not accumulate forever. Startup rather
// than shutdown because that also catches whatever a crash left behind, and detached
// so a slow or unreadable temp directory cannot delay the UI appearing.
sweepCapturesInBackground();

render(createElement(App));
