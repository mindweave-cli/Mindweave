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
 * A fixed name per run rather than a random one: the suite spans several processes
 * (`--test-concurrency`), and they have to agree on where the state lives or a test
 * that writes in one and reads in another would look flaky for no reason.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Respect an override that is already set, so a developer can point a run somewhere
// specific without editing this file.
if (!process.env.MINDWEAVE_STATE_DIR) {
  const dir = join(tmpdir(), "mindweave-test-state");
  mkdirSync(dir, { recursive: true });
  process.env.MINDWEAVE_STATE_DIR = dir;
}
