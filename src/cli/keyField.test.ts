/**
 * keyField.test.ts — a scroll wheel must never end up inside an API key.
 *
 * Once mouse reporting is on, wheel movements arrive at a focused text field as ordinary
 * typed text. Scrolling while pasting a key fills the field with escape sequences, and
 * the key then fails in a way that looks like the key itself is wrong — which is the
 * worst possible failure to hand someone on their first run.
 *
 * The prompt has stripped these for a long time. The key fields were new and did not, so
 * this asserts the RULE rather than one field: every place that takes a key runs the
 * input through the same filter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripMouse } from "./mouse.js";

const here = dirname(fileURLToPath(import.meta.url));

test("a wheel report is removed, and a real key is untouched", () => {
  const key = "sk-ant-api03-Zx9_real-KEY-value";
  const wheel = String.fromCharCode(27) + "[<64;25;26M";
  assert.equal(stripMouse(key + wheel), key, "a wheel report survived into the key");
  assert.equal(stripMouse(wheel + key + wheel + wheel), key);
  assert.equal(stripMouse(key), key, "a plain key was altered");
});

test("EVERY field that takes a key filters its input", () => {
  // Named files rather than a live render, because what matters is that no NEW key field
  // is ever added without this — a rule a component test could not notice being broken.
  for (const file of ["components/KeySetup.tsx", "components/KeyManager.tsx"]) {
    const src = readFileSync(join(here, file), "utf8");
    if (!src.includes("TextInput")) continue;
    assert.match(
      src,
      /onChange=\{\(v\) => set\w+\(stripMouse\(v\)\)\}/,
      `${file} takes a key without stripping mouse reports — scrolling will corrupt it`,
    );
  }
});
