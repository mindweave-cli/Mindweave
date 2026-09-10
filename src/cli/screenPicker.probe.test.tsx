/**
 * screenPicker.probe.test.tsx — the `/screen` chooser as it reaches the terminal.
 *
 * `screenMode.test.ts` proves what the two entries SAY. This proves they arrive on
 * screen, in the box every other picker uses, with the beta mark and the cost still
 * legible after the row has been laid out and clipped to the terminal's width.
 *
 * That last part is the reason this exists rather than being taken on trust. The inline
 * entry earns its beta mark by what it COSTS — the app takes the mouse, so the
 * terminal's own scrollbar and text selection stop working — and a description that
 * says so is long. A picker row is one line wide. If the width the chooser is given
 * clips it before "selection", the warning is gone and the entry reads as a plain
 * feature, which is the whole thing this label exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { Picker } from "./components/Picker.js";
import { screenChoices } from "./screenMode.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  return stdin;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The chooser exactly as App builds it, painted, escapes stripped. */
function paint(current: "inline" | "fullscreen", width = 100): string {
  const choices = screenChoices(current);
  const stdout = new FakeStdout();
  stdout.columns = width;
  const instance = render(
    <Picker
      title="Which shell?"
      items={choices.map((c) => ({ label: c.label, description: c.description }))}
      width={width}
      maxRows={6}
      describeSelection
      initialIndex={Math.max(0, choices.findIndex((c) => c.mode === current))}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  // NOT simply the last write: Ink also emits bare control sequences (showing the
  // cursor, bracketed paste), and one of those arriving after the frame would be read as
  // a screen with nothing on it. The title is on every real frame, so requiring it
  // selects frames and rejects control writes.
  const last = stdout.frames.filter((f) => f.includes("Which shell")).at(-1) ?? "";
  instance.unmount();
  return last.replace(ANSI, "");
}

test("both shells reach the screen, under a title that asks a question", () => {
  const screen = paint("fullscreen");
  assert.match(screen, /Which shell\?/);
  assert.match(screen, /Fullscreen/);
  assert.match(screen, /Inline/);
});

test("the beta mark survives being painted", () => {
  // Not just present in the data — on the row, after layout.
  assert.match(paint("fullscreen"), /Inline \(beta\)/);
});

test("the beta mark is on the inline row, not loose in the box", () => {
  const row = paint("fullscreen")
    .split("\n")
    .find((l) => /Inline/.test(l));
  assert.ok(row, "no inline row was painted at all");
  assert.match(row, /beta/i, "the mark landed on a different row than the shell it describes");
});

test("the shell in use is ticked on screen", () => {
  const inlineRow = paint("inline")
    .split("\n")
    .find((l) => /Inline/.test(l));
  assert.ok(inlineRow);
  assert.match(inlineRow, /✓/, "the shell in use is not marked, so the chooser gives no starting point");
});

test("the selected shell's description shows in full BELOW the list, not truncated on its row", () => {
  // It used to run past the row and truncate with an ellipsis, which read as broken. Now
  // the highlighted item's description appears in full below the list. Selecting inline,
  // its whole description is on screen and nothing carries an ellipsis.
  const screen = paint("inline", 100);
  const inline = screenChoices("inline").find((c) => c.mode === "inline")!;
  assert.match(screen, new RegExp(inline.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the description was clipped");
  assert.doesNotMatch(screen, /…/, "something in the picker is still truncated with an ellipsis");

  // And the description is on a DIFFERENT row than the label — below it, not beside it.
  const rows = screen.split("\n");
  const labelRow = rows.findIndex((r) => /Inline \(beta\)/.test(r));
  const descRow = rows.findIndex((r) => r.includes(inline.description.slice(0, 12)));
  assert.ok(labelRow >= 0 && descRow > labelRow, "the description is not below the label");
});

test("a LONG description wraps to several rows below rather than truncating", () => {
  // Long enough to need several rows at width 60, short enough to fit the note budget.
  const long = "deliberately long enough to wrap onto more than one row below the list rather than being cut with an ellipsis";
  const stdout = new FakeStdout();
  stdout.columns = 60;
  const instance = render(
    <Picker
      title="Which shell?"
      items={[
        { label: "One", description: long },
        { label: "Two", description: "short" },
      ]}
      width={60}
      maxRows={6}
      describeSelection
      initialIndex={0}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  const screen = (stdout.frames.filter((f) => f.includes("Which shell")).at(-1) ?? "").replace(ANSI, "");
  instance.unmount();

  // Several distinct words from across the long description are all present — proof it
  // was not cut at the first row's width.
  for (const word of ["deliberately", "wrap", "list", "ellipsis"]) {
    assert.match(screen, new RegExp(word), `"${word}" from the long description was lost`);
  }
  assert.doesNotMatch(screen, /…/, "the long description was truncated instead of wrapped");
  // It occupies more than one row.
  const descRows = screen.split("\n").filter((r) => /deliberately|wrap|list|ellipsis/.test(r));
  assert.ok(descRows.length >= 2, `the description did not wrap — it is on ${descRows.length} row(s)`);
});

test("nothing painted is wider than the terminal", () => {
  for (const width of [60, 80, 100]) {
    for (const line of paint("fullscreen", width).split("\n")) {
      assert.ok(line.length <= width, `a ${line.length}-column row in a ${width}-column terminal`);
    }
  }
});

// ── right-aligned metadata (the /continue session list) ─────────────────────
//
// Session titles run from three words to a whole sentence. A left-aligned column of
// descriptions then strands the short titles far from their metadata and crowds the
// long ones out of it. Right-aligning the metadata pins it to the row's edge, label
// filling the rest and truncating when it must — a clean table whatever the lengths.

test("with rightAlignDescription, the metadata is flush right and a long label is truncated", () => {
  const width = 60;
  const stdout = new FakeStdout();
  stdout.columns = width;
  const instance = render(
    <Picker
      title="Continue which session?"
      items={[
        { label: "hi", description: "2 days ago · 8 msgs" },
        { label: "a very long session title that runs well past where the metadata should sit", description: "5 days ago · 45 msgs" },
      ]}
      width={width}
      maxRows={6}
      rightAlignDescription
      initialIndex={0}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  const screen = (stdout.frames.filter((f) => f.includes("Continue which")).at(-1) ?? "").replace(ANSI, "");
  instance.unmount();
  const rows = screen.split("\n");

  // Both descriptions end at (about) the same right column — that is what "aligned" means.
  const shortRow = rows.find((r) => r.includes("8 msgs"))!;
  const longRow = rows.find((r) => r.includes("45 msgs"))!;
  assert.ok(shortRow && longRow, "both session rows painted");
  assert.ok(Math.abs(shortRow.trimEnd().length - longRow.trimEnd().length) <= 1, "the two metadata columns do not end at the same place");

  // The short label's metadata sits far to the right, not right after "hi".
  assert.ok(shortRow.indexOf("2 days ago") > 20, "the metadata was not pushed to the right edge");
  // The over-long title was truncated so it did not collide with its metadata.
  assert.match(longRow, /…/, "a title longer than the row was not truncated");
  assert.match(longRow, /45 msgs/, "the long row lost its metadata");
  // Nothing overflows the terminal.
  for (const r of rows) assert.ok(r.length <= width, `a row is ${r.length} wide on a ${width}-col terminal`);
});
