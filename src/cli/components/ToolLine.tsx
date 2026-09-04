/**
 * ToolLine — a tool's activity row.
 *
 *   ● Update(home.html)
 *     ⎿ - <a href="#" class="btn">
 *       + <a href="catalog.html" class="btn">
 *
 * The dot reflects lifecycle: dim while running, white when ok, red on error. The
 * bold `Name(arg)` sits on the first row; once resolved, an indented `⎿` branch
 * hangs beneath with the rich detail (an edit diff, a file preview, command
 * output) or a one-line summary. The whole result appears AT ONCE on resolve —
 * never a live, line-by-line scroll (that churn is what made the old version
 * glitch).
 */
import { Box, Text } from "ink";
import { KIND_COLOR, ERROR_COLOR, type ToolKind } from "../toolDisplay.js";
import { activeForm } from "../toolItems.js";
import { commandLabel } from "../commandLabel.js";

const DOT = "●";
const BRANCH = "⎿";
// The rail beside quoted machine output (a command's stdout). Distinct from BRANCH:
// the branch says "here is this call's result", the rail says "this text is not ours".
const RAIL = "│";
// The branch nests one level UNDER the tool label: the `⎿` sits beneath the name's
// first letter (col 2) and continuation rows align under the branch content, so the
// result reads as belonging to the tool call instead of hanging in the dot gutter.
const BRANCH_INDENT = 4;
/**
 * The outcome line `withOutcome` puts at the end of a command's output, so the header can
 * lift it off the bottom of the block and set it beside the command.
 *
 * Both failure marks are accepted. `✗` is what is written now; `✖` is what sessions
 * recorded before it was found to render two columns wide on a terminal that measures it
 * as one. A resumed session replays the text it stored, so dropping the old one would
 * leave every past failure's verdict buried at the bottom of its block.
 */
const OUTCOME = /^[✓✗✖]/;

/** Where the verdict sits in a block's lines, or -1. Written as a loop because the
 *  project's TypeScript target predates `findLastIndex`. */
function lastOutcome(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OUTCOME.test(lines[i]!)) return i;
  }
  return -1;
}

export interface ToolLineProps {
  name: string;
  arg?: string;
  status: "running" | "ok" | "error";
  /** Action category — colours the dot (blue family; red when it errors). */
  action?: ToolKind;
  summary?: string;
  detail?: string;
  /** How to read `detail` — see ToolResult.detailKind. Absent means plain text. */
  detailKind?: "diff" | "text" | "shell";
  /** A dim qualifier after the name — a non-default command timeout, say. */
  meta?: string;
  columns: number;
  /** Is the turn that made this call still running? Chooses the verb, nothing else. */
  live?: boolean;
  /** Consecutive tool rows hug; one after prose keeps a blank line above. */
  tightTop?: boolean;
}

export function ToolLine({ name, arg, status, action, summary, detail, detailKind, meta, columns, live, tightTop }: ToolLineProps) {
  const errored = status === "error";
  // "Updating(home.html)" while the turn runs, "Update(home.html)" once it ends —
  // the same row, one word apart. The row is not shown at all until its result is
  // in hand, so this is the only change the user ever sees it make.
  const verb = activeForm(name, !!live);
  // The dot carries the action at a glance: its category colour when it succeeds,
  // dim while still running, red when it failed.
  const dotColor = errored ? ERROR_COLOR : action ? KIND_COLOR[action] : undefined;
  const metaRoom = meta ? meta.length + 1 : 0;

  // The branch content: rich detail lines if present, else the one-line summary.
  const allLines = detail ? detail.split("\n") : summary ? [summary] : [];

  // A command's verdict is LIFTED out of its output and set against the right margin of
  // this row.
  //
  // At the bottom of the block it sat wherever that block happened to end, so finding out
  // whether something worked meant reading down however many lines of build log came out
  // first — and a run that printed nothing looked identical to one that printed plenty.
  // Against the right margin it is in the same place on every command, which is the only
  // reason it can be read without being looked for.
  // The LAST such line, not the first. The verdict is always appended after everything
  // else, and a body can legitimately contain earlier ones — a test summary lists each
  // failing test with the same mark, and taking the first lifted the name of one failing
  // test into the header and left the actual verdict at the bottom.
  const outcomeAt = detailKind === "shell" ? lastOutcome(allLines) : -1;
  const outcome = outcomeAt >= 0 ? allLines[outcomeAt] : undefined;
  const branchLines = outcomeAt >= 0 ? allLines.filter((_, i) => i !== outcomeAt) : allLines;

  // Trim a long arg from the FRONT so the meaningful tail (a filename) stays
  // visible and the header never wraps to column 0.
  //
  // Everything that shares the row is part of the budget. `meta` was previously left out
  // of this arithmetic while still being rendered, so a row carrying one —
  // ` [Timeout: 600s]`, sixteen columns — was built to fill the terminal and then had
  // those columns appended past the end of it. Every long-running command produced an
  // over-wide header, which is the most common way this screen exceeds its own width.
  const outcomeRoom = outcome ? outcome.length + 2 : 0;
  // Two columns for the dot gutter, two for the brackets, and one left free at the right
  // margin so the row can never end exactly on the last cell.
  const headerRoom = Math.max(12, columns - verb.length - metaRoom - outcomeRoom - 5);
  // A command is named from the FRONT and everything else from the back. Trimming a path
  // from the front leaves the filename, which is what was being looked for; trimming a
  // command the same way leaves the plumbing and drops the program. See `commandLabel`.
  const shownArg = !arg
    ? arg
    : action === "run"
      ? commandLabel(arg, headerRoom)
      : arg.length > headerRoom
        ? "…" + arg.slice(-(headerRoom - 1))
        : arg;

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      {/* Bounded and clipped, with nothing here allowed to shrink. Ink's Box defaults to
          `flexShrink: 1`, so a row that does not fit is resolved by squeezing its
          children — the dot gutter narrows, the verb's own box gives up columns, and the
          text inside reflows onto rows this component never asked for. Pinned at 0 the
          row keeps its true shape, and `overflow: hidden` clips the one thing that may
          honestly be lost: the tail of an argument already trimmed on purpose above. */}
      <Box flexDirection="row" width={columns} overflow="hidden">
        <Box minWidth={2} flexShrink={0}>
          <Text color={dotColor} dimColor={status === "running"}>{DOT}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold>{verb}</Text>
        </Box>
        {shownArg ? (
          <Box flexShrink={0}>
            <Text wrap="truncate-end">({shownArg})</Text>
          </Box>
        ) : null}
        {meta ? (
          <Box flexShrink={0}>
            <Text dimColor wrap="truncate-end">{" "}{meta}</Text>
          </Box>
        ) : null}
        {/* Beside the command, not at the right margin. Pinned to the right it was in the
            same place on every row, which reads well in a mock and badly on a wide
            terminal: the verdict ends up half a screen from the command it belongs to,
            with nothing in between, so the two have to be connected by eye every time. */}
        {outcome ? (
          <Box flexShrink={0}>
            <Text color={errored ? ERROR_COLOR : "green"} bold wrap="truncate-end">{"  "}{outcome}</Text>
          </Box>
        ) : null}
      </Box>
      {status !== "running" && branchLines.length > 0 ? (
        detailKind === "shell" ? (
          <ShellLines lines={branchLines} columns={columns} errored={errored} headerHasCommand={!!arg} />
        ) : (
          <BranchLines lines={branchLines} columns={columns} errored={errored} diff={detailKind === "diff"} />
        )
      ) : null}
    </Box>
  );
}

/** The indented `⎿` result block, one source line per row, diff-colored when the
 *  content is a real diff (`+ ` green, `- ` red; everything else dim).
 *
 *  `diff` is passed by the caller from the result's own detailKind, NOT inferred from
 *  "does this row have a detail block". Inferring it painted every command whose output
 *  happened to start with `-` as a deletion — a `Get-ChildItem` listing came out half
 *  red, since PowerShell writes its column rule as `----` and its file rows as `-a----`. */
function BranchLines({
  lines,
  columns,
  errored,
  diff,
}: {
  lines: string[];
  columns: number;
  errored: boolean;
  diff: boolean;
}) {
  const content = Math.max(8, columns - BRANCH_INDENT - 1);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const style = errored ? { color: "red" } : diff ? diffStyle(line) : undefined;
        const dim = !errored && style === undefined;
        // Padded to the full content width so the tint is a continuous band rather than
        // stopping wherever the code happens to end, which reads as a ragged smear.
        const painted = style?.backgroundColor ? line.padEnd(content) : line;
        return (
          <Box key={i} flexDirection="row" width={columns}>
            <Text dimColor>{i === 0 ? `  ${BRANCH} ` : "    "}</Text>
            <Box width={content}>
              <Text {...style} dimColor={dim} wrap="truncate-end">{painted}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * A shell command's block: its output on a rail, then the outcome.
 *
 *   ● Run(npm run build)
 *       │ > tsc && vite build
 *       ✓ Exit code 0
 *
 * The command itself lives in the HEADER, like every other row's subject. It used to
 * sit on its own `$` row under a bare "Executed shell command" title, because as a
 * header argument it was clipped to 48 characters and a real command line is longer
 * than that more often than not — so the half that said what it did was the half that
 * got cut. The clip is gone: the header is fitted to the real terminal width, and the
 * `$` row comes back only when even that could not show the command whole.
 *
 * Output sits on a dim rail so it reads as quoted machine output rather than as
 * something Mindweave said, and the outcome hangs off the rail because it is a verdict
 * on the command, not more of its output. A command with NO output yet (one that was
 * backgrounded) has no rail at all — it reports through the ordinary ⎿ branch, the way
 * a write reports "whole file · 19 lines".
 *
 * The zones are told apart by the prefixes the tool wrote (`$ ` and `✓`/`✖`), the
 * same convention the diff block uses for `+ `/`- `.
 */
function ShellLines({
  lines,
  columns,
  errored,
  headerHasCommand,
}: {
  lines: string[];
  columns: number;
  errored: boolean;
  /** The header already shows the command in full, so the `$` row would repeat it. */
  headerHasCommand: boolean;
}) {
  const content = Math.max(8, columns - BRANCH_INDENT - 2);
  // Only when the header had to trim it away. A command that fits is said once.
  const shown = headerHasCommand ? lines.filter((l) => !l.startsWith("$ ")) : lines;
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => {
        const command = line.startsWith("$ ");
        // Same both-marks rule as OUTCOME above: `✗` now, `✖` in sessions recorded before it.
        const outcome = OUTCOME.test(line);
        const railed = !command && !outcome;
        return (
          <Box key={i} flexDirection="row" width={columns}>
            <Text dimColor>{railed ? `    ${RAIL} ` : "    "}</Text>
            <Box width={content}>
              {command ? (
                // The `$` gets its own colour so the command is findable at a glance in
                // a block of output. It is the one line here the user WROTE, in effect,
                // and it was previously distinguished only by being bold, which loses
                // against a screenful of equally plain machine text.
                <Text wrap="truncate-end">
                  <Text color={KIND_COLOR.run}>{"$ "}</Text>
                  <Text bold>{line.slice(2)}</Text>
                </Text>
              ) : (
                <Text
                  color={outcome ? (line.startsWith("✓") ? "green" : ERROR_COLOR) : errored ? "red" : undefined}
                  dimColor={railed && !errored}
                  bold={outcome}
                  wrap="truncate-end"
                >
                  {line}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * How one diff row is painted.
 *
 * A tinted BACKGROUND across the row, not just coloured text. Foreground colour alone
 * was technically correct and read as flat: a `+` and a `-` in slightly different inks,
 * on a dark terminal, among a dozen other rows. The change a diff is reporting is the
 * whole reason the row exists, and it should be findable without reading it.
 *
 * The tints are dark on purpose. They sit behind ordinary code text that still has to
 * be legible, so they are a wash rather than a highlight, and the foreground stays the
 * brighter of the two signals.
 */
const ADDED_BG = "#0d2818";
const REMOVED_BG = "#2d1113";

interface DiffStyle {
  color?: string;
  backgroundColor?: string;
}

function diffStyle(line: string): DiffStyle | undefined {
  if (line.startsWith("+")) return { color: "green", backgroundColor: ADDED_BG };
  if (line.startsWith("-")) return { color: "red", backgroundColor: REMOVED_BG };
  return undefined;
}
