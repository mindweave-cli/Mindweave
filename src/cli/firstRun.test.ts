/**
 * firstRun.test.ts — what happens the very first time Mindweave is opened.
 *
 * No config, no key, no project state. It is the only path where a rough edge costs the
 * user everything, and it had never been tested: `startupArgs.test.ts` covers flag
 * parsing and stops there.
 *
 * The assertion that matters most is the negative one. The template writes a line per
 * provider, and a line like `DEEPSEEK_API_KEY=   # DeepSeek` reads perfectly well and
 * parses as a VALUE of "# DeepSeek" — so every provider reports a key it does not have,
 * no prompt is ever shown, and every request comes back rejected with nothing on screen
 * to explain why. That is a worse first run than having no template at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, globalEnvPath, hasApiKey } from "./bootstrap.js";
import { allProviders } from "../drivers/registry.js";

/** A machine that has never run Mindweave. */
function firstRun(): { env: string; text: string } {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mindweave-firstrun-"));
  for (const p of allProviders()) delete process.env[p.apiKeyEnv];
  loadConfig(mkdtempSync(join(tmpdir(), "mindweave-firstproj-")));
  const env = globalEnvPath();
  return { env, text: readFileSync(env, "utf8") };
}

test("a first run leaves a config template where the user can find it", () => {
  const { env, text } = firstRun();
  assert.ok(existsSync(env), "nothing was written, so there is nowhere to paste a key");
  assert.match(text, /Paste a key/i, "the file does not say what to do with it");
});

test("the template does NOT make every provider look configured", () => {
  // The whole point. A parsed value here means no key prompt and a rejected request.
  firstRun();
  const configured = allProviders().filter((p) => hasApiKey(p.apiKeyEnv));
  assert.deepEqual(
    configured.map((p) => `${p.label}=${process.env[p.apiKeyEnv]}`),
    [],
    "the template set keys nobody typed — the first run will fail with no explanation",
  );
});

test("every provider appears, by name, so a new user can find theirs", () => {
  const { text } = firstRun();
  for (const p of allProviders()) {
    assert.ok(text.includes(p.apiKeyEnv), `${p.label}'s key variable is missing`);
    // The variable alone is not enough: DASHSCOPE, ZAI and MODEL_API_KEY name nothing a
    // user would recognise as Qwen, GLM or Meta.
    assert.ok(text.includes(p.label), `${p.label} is not named, only its variable`);
  }
});

test("config and state resolve to the SAME relocatable place", () => {
  // They were computed by two different functions and only one honoured the override, so
  // a relocated Mindweave moved its sessions and left the config in the real home — and
  // the test suite wrote a config file into the developer's own ~/.mindweave.
  const root = mkdtempSync(join(tmpdir(), "mindweave-both-"));
  process.env.MINDWEAVE_STATE_DIR = root;
  loadConfig(mkdtempSync(join(tmpdir(), "mindweave-p2-")));
  assert.ok(
    globalEnvPath().startsWith(root),
    `config went to ${globalEnvPath()} while state went to ${root}`,
  );
});
