/**
 * testState.mjs — keep the test suite out of the user's home directory.
 *
 * Mindweave files everything it keeps under `~/.mindweave/projects/<slug>`, and the
 * slug is derived from the working directory. So any test that ran a session, saved a
 * memory, or wrote a governor rule against a temp directory left a permanent folder in
 * the real home. Nothing knew those were disposable, so nothing ever removed them.
 *
 * Measured on the development machine before this existed: **6,761 of 6,770**
 * directories under `~/.mindweave/projects` were test litter, growing with every run.
 *
 * Loaded with `--import`, which Node runs before any test module, so the override is in
 * place before the first import can read it. `stateRoot()` reads the variable on every
 * call rather than caching it at import, which is what makes that ordering enough.
 *
 * A FRESH directory per process, which matters more than it looks. Node runs each test
 * file in its own process, so this gives every file its own state and nothing carries
 * over between runs. A fixed shared name was tried first and broke two tests that were
 * already isolating themselves with a temporary HOME: the state outlived the run, so a
 * memory saved by yesterday's suite made today's "this is a new memory" assertion fail.
 * Isolation that only holds on a clean machine is not isolation.
 *
 * A test needing two processes to share state sets the variable itself, which is
 * respected below.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Respect an override that is already set, so a developer can point a run somewhere
// specific, and so a test that spawns children can share one state directory with them.
if (!process.env.MINDWEAVE_STATE_DIR) {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mindweave-test-state-"));
}
