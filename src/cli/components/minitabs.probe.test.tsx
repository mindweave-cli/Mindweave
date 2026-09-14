/**
 * minitabs.probe.test.tsx — the shared row this drill-down pattern is built on.
 *
 * The bug this exists to pin: `MiniTabRow`'s label column was a fixed 24 characters
 * REGARDLESS of whether anything else was sharing the row, so a caller with a single long
 * option and no `right`/`mid` at all (a picker step: "A command (runs locally, e.g. npx
 * …)") had it chopped to 24 characters while most of the box sat empty beside it — the
 * exact class of "the text is unclear because it got cut off" this project keeps closing
 * elsewhere. `left` now takes the row's full remaining width whenever `right` is absent.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, Box } from "ink";
import { MiniTabPanel, MiniTabRow } from "./minitabs.js";

function frame(node: React.ReactElement, width = 64): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 76,
    rows: 30,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray" paddingX={1}>
      {node}
    </Box>,
    { stdout: stream, patchConsole: false, interactive: true },
  );
  app.unmount();
  const ESC = String.fromCharCode(27);
  return out.join("").replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "");
}

test("a lone label with no right column uses the row's full width, not a fixed 24", () => {
  const label = "A command (runs locally, e.g. npx …)"; // 37 characters — longer than 24
  const out = frame(
    <MiniTabPanel title="Add an MCP server" rows={1} maxRows={6} width={64} hint="Enter next">
      <MiniTabRow on={true} n={1} left={label} width={64} />
    </MiniTabPanel>,
    64,
  );
  assert.match(out, /A command \(runs locally, e\.g\. npx …\)/, `the label was cut short:\n${out}`);
});

test("a label WITH a right column still reserves space for it — the two-column case is unchanged", () => {
  const out = frame(
    <MiniTabPanel title="Servers" rows={1} maxRows={6} width={64} hint="Enter select">
      <MiniTabRow on={false} n={1} left="DeepSeek" right="2 models · key set" width={64} />
    </MiniTabPanel>,
    64,
  );
  assert.match(out, /DeepSeek/);
  assert.match(out, /2 models · key set/, `the right column did not render:\n${out}`);
});

test("a right column long enough to matter still truncates rather than overflowing the box", () => {
  const longError = "connection refused at 127.0.0.1:9999 after 3 attempts, giving up entirely now";
  const out = frame(
    <MiniTabPanel title="MCP servers" rows={1} maxRows={6} width={64} hint="Enter select">
      <MiniTabRow on={false} n={1} left="myserver" right={`error · ${longError}`} width={64} />
    </MiniTabPanel>,
    64,
  );
  const lines = out.split(/\r?\n/).filter((l) => l.includes("myserver"));
  assert.equal(lines.length, 1, "the row must not wrap onto a second line");
  assert.ok(lines[0]!.length <= 66, `the row overflowed the 64-wide box: ${lines[0]!.length} chars`);
});

test("a two-digit row number does not shove the label out of alignment with a one-digit row", () => {
  const out = frame(
    <MiniTabPanel title="Servers" rows={2} maxRows={7} width={64} hint="Enter select">
      <MiniTabRow on={false} n={2} numWidth={2} left="Prov2" right="no key yet" width={64} />
      <MiniTabRow on={false} n={11} numWidth={2} left="Prov11" right="no key yet" width={64} />
    </MiniTabPanel>,
    64,
  );
  const rows = out.split(/\r?\n/).filter((r) => /no key yet/.test(r));
  const single = rows.find((r) => /\bProv2\b/.test(r))!;
  const double = rows.find((r) => /\bProv11\b/.test(r))!;
  assert.ok(single && double, "both rows painted");
  assert.equal(single.indexOf("Prov2"), double.indexOf("Prov11"), "labels start in different columns");
});
