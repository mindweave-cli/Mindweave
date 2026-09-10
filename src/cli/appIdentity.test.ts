/**
 * appIdentity.test.ts — the session names itself to the terminal and the OS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_NAME, nameSession, setTitleSequence } from "./appIdentity.js";

test("the title sequence is a well-formed OSC 2 window-title set", () => {
  const seq = setTitleSequence("Mindweave");
  assert.equal(seq, "\x1b]2;Mindweave\x07", "not the OSC 2 ; title BEL shape a terminal expects");
});

test("nameSession sets process.title to the app name", () => {
  const before = process.title;
  try {
    nameSession(() => {});
    assert.equal(process.title, APP_NAME);
  } finally {
    process.title = before;
  }
});

test("nameSession writes the title to the terminal when one is attached", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const writes: string[] = [];
  try {
    nameSession((d) => writes.push(d));
    assert.deepEqual(writes, [setTitleSequence(APP_NAME)]);
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
  }
});

test("with no terminal, nothing is written (a pipe must not get escape bytes)", () => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  const writes: string[] = [];
  try {
    nameSession((d) => writes.push(d));
    assert.deepEqual(writes, []);
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
  }
});
