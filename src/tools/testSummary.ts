/**
 * testSummary.ts — recognising a test run in a command's output, and saying what it did
 * in one row.
 *
 * A test run is the one command whose output is almost entirely noise on success. Two
 * thousand passing tests print two thousand lines to say "nothing is wrong", and the
 * three lines that matter on a failure are buried among them. Every other command is
 * shown as output; this one is worth reading as a RESULT.
 *
 *   ✓ 2,171 passed · 8 skipped · 39.8s
 *
 *   ✗ 3 failed · 2,168 passed · 41.2s
 *   ✗ caret at end of a full row
 *       expected "abcd", got "abc…"   inputView.test.ts:64
 *
 * ## The rule this file lives under
 *
 * A runner that is not RECOGNISED must fall through to the ordinary shell block, whole
 * and untouched. Recognising output means matching a format somebody else owns and may
 * change, so the failure mode has to be "this looks like an ordinary command", never a
 * confident summary of numbers that were never there. Every matcher below returns
 * `undefined` rather than a guess, and the counts come from the runner's own totals line
 * rather than from counting ticks — a reporter that prints per-file totals as well as a
 * grand total would otherwise be added up twice.
 */

import { FAIL_MARK, OK_MARK } from "./detail.js";

/** One failing test, as much of it as the runner made available. */
export interface TestFailure {
  name: string;
  /** The assertion or error line, when the format puts one within reach. */
  detail?: string;
  /** `file:line`, when the format names one. */
  location?: string;
}

/** What a recognised test run reported. */
export interface TestRun {
  passed: number;
  failed: number;
  skipped: number;
  /** Wall clock the runner itself reported, where it reports one. */
  durationMs?: number;
  failures: TestFailure[];
}

/** Failures listed under the summary row. The rest are hidden: a failing run must not
 *  take the screen, and thirty stack traces are not more useful than three. */
export const SHOWN_FAILURES = 3;

const num = (s: string | undefined): number => {
  const n = Number((s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * `node --test`, whose spec reporter ends with its own totals block.
 *
 *   ℹ tests 2171
 *   ℹ pass 2168
 *   ℹ fail 3
 *   ℹ skipped 8
 *   ℹ duration_ms 41213.4
 */
function nodeTest(output: string): TestRun | undefined {
  const field = (name: string): string | undefined =>
    new RegExp(`^\\s*(?:ℹ|i)\\s+${name}\\s+([\\d.,]+)\\s*$`, "m").exec(output)?.[1];
  const pass = field("pass");
  const fail = field("fail");
  if (pass === undefined || fail === undefined) return undefined;
  const duration = field("duration_ms");
  return {
    passed: num(pass),
    failed: num(fail),
    skipped: num(field("skipped")),
    ...(duration === undefined ? {} : { durationMs: num(duration) }),
    failures: nodeFailures(output),
  };
}

/**
 * The failing tests from a `node --test` run.
 *
 * Read from the body rather than from the trailing "failing tests:" recap, because the
 * recap repeats each name without the assertion under it, and the assertion is the only
 * part worth a row.
 */
function nodeFailures(output: string): TestFailure[] {
  const lines = output.split("\n");
  const out: TestFailure[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*(?:✖|not ok \d+ -)\s+(.+?)(?:\s+\(\d[\d.]*ms\))?\s*$/.exec(lines[i]!);
    if (!head) continue;
    const name = head[1]!.trim();
    // The recap's own header, and the recap entries that follow it.
    if (name === "failing tests:" || seen.has(name)) continue;
    seen.add(name);
    const failure: TestFailure = { name };
    // The assertion sits in the indented block under the name; the file and line arrive
    // a little further down, in the first frame of the stack that is not node's own.
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const line = lines[j]!;
      if (/^\s*(?:✔|✖|ℹ)/.test(line)) break;
      const detail = /^\s{2,}(\w*(?:Error|Assertion)[^\n]*|expected[^\n]*|actual[^\n]*)$/.exec(line);
      if (detail && failure.detail === undefined) failure.detail = detail[1]!.trim();
      const where = /([\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?):(\d+)/.exec(line);
      if (where && failure.location === undefined) failure.location = `${where[1]}:${where[2]}`;
    }
    out.push(failure);
  }
  return out;
}

/**
 * Vitest, whose summary counts test FILES and tests on separate lines. Only the second
 * is a count of tests, and reading the first as one reports three failures as one.
 */
function vitest(output: string): TestRun | undefined {
  const line = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
  if (line === undefined) return undefined;
  const passed = /(\d[\d,]*)\s+passed/.exec(line);
  if (!passed) return undefined;
  const duration = /^\s*Duration\s+([\d.]+)(m?s)/m.exec(output);
  return {
    passed: num(passed[1]),
    failed: num(/(\d[\d,]*)\s+failed/.exec(line)?.[1]),
    skipped: num(/(\d[\d,]*)\s+(?:skipped|todo)/.exec(line)?.[1]),
    ...(duration ? { durationMs: duration[2] === "s" ? num(duration[1]) * 1000 : num(duration[1]) } : {}),
    failures: taggedFailures(output, /^\s*(?:FAIL|×|✕)\s+(.+?)\s*$/gm),
  };
}

/** Jest, which puts every count on one line and its time on another. */
function jest(output: string): TestRun | undefined {
  const line = /^\s*Tests:\s+(.+)$/m.exec(output)?.[1];
  if (line === undefined) return undefined;
  const passed = /(\d[\d,]*)\s+passed/.exec(line);
  if (!passed) return undefined;
  const seconds = /^\s*Time:\s+([\d.]+)\s*s/m.exec(output)?.[1];
  return {
    passed: num(passed[1]),
    failed: num(/(\d[\d,]*)\s+failed/.exec(line)?.[1]),
    skipped: num(/(\d[\d,]*)\s+(?:skipped|todo)/.exec(line)?.[1]),
    ...(seconds === undefined ? {} : { durationMs: num(seconds) * 1000 }),
    failures: taggedFailures(output, /^\s*●\s+(.+?)\s*$/gm),
  };
}

/** pytest, which reports everything on one banner line at the end. */
function pytest(output: string): TestRun | undefined {
  const banner = /^=+ (.*\b(?:passed|failed|error)\b.*?) =+$/m.exec(output)?.[1];
  if (banner === undefined) return undefined;
  const seconds = /in ([\d.]+)s/.exec(banner)?.[1];
  return {
    passed: num(/(\d+)\s+passed/.exec(banner)?.[1]),
    failed: num(/(\d+)\s+(?:failed|error)/.exec(banner)?.[1]),
    skipped: num(/(\d+)\s+(?:skipped|deselected)/.exec(banner)?.[1]),
    ...(seconds === undefined ? {} : { durationMs: num(seconds) * 1000 }),
    failures: taggedFailures(output, /^FAILED\s+(.+?)(?:\s+-\s+.*)?$/gm),
  };
}

/** Failure names from formats that mark each one with a tag on its own line. */
function taggedFailures(output: string, pattern: RegExp): TestFailure[] {
  const out: TestFailure[] = [];
  const seen = new Set<string>();
  for (const m of output.matchAll(pattern)) {
    const name = m[1]!.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push({ name });
  }
  return out;
}

/**
 * Read a test run out of a command's output, or return `undefined`.
 *
 * Order matters only in that each matcher looks for a totals line the others do not have,
 * so a run is claimed by the one runner that actually wrote it.
 */
export function parseTestRun(output: string): TestRun | undefined {
  if (output.trim() === "") return undefined;
  for (const matcher of [nodeTest, vitest, jest, pytest]) {
    const run = matcher(output);
    // A run with nothing in it at all is a false positive: a totals line matched, but
    // there were no tests, so this was not a test run.
    if (run && run.passed + run.failed + run.skipped > 0) return run;
  }
  return undefined;
}

/**
 * A test run as the row shows it: a verdict, then the first few failures.
 *
 * The verdict leads with `✓`/`✖` because the renderer lifts that line out and sets it
 * against the right margin of the command's header — see `ToolLine`. A green run is that
 * line and nothing else, which is the whole point: a run where nothing is wrong should
 * cost one row and a run where something is should show what.
 *
 * `formatDuration` is passed in rather than imported so this module stays free of the
 * display layer; it is one function and the alternative is a cycle.
 */
export function testDetail(run: TestRun, formatDuration: (ms: number) => string): string {
  const counts: string[] = [];
  if (run.failed > 0) counts.push(`${run.failed.toLocaleString("en-US")} failed`);
  counts.push(`${run.passed.toLocaleString("en-US")} passed`);
  if (run.skipped > 0) counts.push(`${run.skipped.toLocaleString("en-US")} skipped`);
  if (run.durationMs !== undefined) counts.push(formatDuration(run.durationMs));
  const verdict = `${run.failed > 0 ? FAIL_MARK : OK_MARK} ${counts.join(" · ")}`;

  const rows: string[] = [];
  for (const failure of run.failures.slice(0, SHOWN_FAILURES)) {
    rows.push(`${FAIL_MARK} ${failure.name}`);
    const where = [failure.detail, failure.location].filter((s) => s !== undefined && s !== "");
    if (where.length > 0) rows.push(`    ${where.join("   ")}`);
  }
  const hidden = run.failures.length - SHOWN_FAILURES;
  if (hidden > 0) rows.push(`… ${hidden.toLocaleString("en-US")} more failure${hidden === 1 ? "" : "s"}`);

  return [...rows, verdict].join("\n");
}
