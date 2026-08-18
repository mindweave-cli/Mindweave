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

const DOT = "●";
const BRANCH = "⎿";
// The rail beside quoted machine output (a command's stdout). Distinct from BRANCH:
// the branch says "here is this call's result", the rail says "this text is not ours".
const RAIL = "│";
// The branch nests one level UNDER the tool label: the `⎿` sits beneath the name's
// first letter (col 2) and continuation rows align under the branch content, so the
// result reads as belonging to the tool call instead of hanging in the dot gutter.
const BRANCH_INDENT = 4;

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
  // Trim a long arg from the FRONT so the meaningful tail (a filename) stays
  // visible and the header never wraps to column 0.
  const headerRoom = Math.max(12, columns - verb.length - 6);
  const shownArg = arg && arg.length > headerRoom ? "…" + arg.slice(-(headerRoom - 1)) : arg;

  // The branch content: rich detail lines if present, else the one-line summary.
  const branchLines = detail ? detail.split("\n") : summary ? [summary] : [];

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={dotColor} dimColor={status === "running"}>{DOT}</Text>
        </Box>
        <Text bold>{verb}</Text>
        {shownArg ? <Text>({shownArg})</Text> : null}
        {meta ? <Text dimColor>{" "}{meta}</Text> : null}
      </Box>
      {status !== "running" && branchLines.length > 0 ? (
        detailKind === "shell" ? (
          <ShellLines lines={branchLines} columns={columns} errored={errored} />
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
        const color = errored ? "red" : diff ? diffColor(line) : undefined;
        const dim = !errored && color === undefined;
        return (
          <Box key={i} flexDirection="row" width={columns}>
            <Text dimColor>{i === 0 ? `  ${BRANCH} ` : "    "}</Text>
            <Box width={content}>
              <Text color={color} dimColor={dim} wrap="truncate-end">{line}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * A shell command's block: the command, then its output on a rail, then the outcome.
 *
 *   ● Executed shell command
 *       $ npm run build
 *       │ > tsc && vite build
 *       ✓ Exit code 0
 *
 * The command gets its own row so it is never truncated — inline in the header it was
 * cut at 48 characters, which for a real command line meant losing the half that said
 * what it did. Output sits on a dim rail so it reads as quoted machine output rather
 * than as something Mindweave said, and the outcome hangs off the rail because it is a
 * verdict on the command, not more of its output.
 *
 * The three zones are told apart by the prefixes the tool wrote (`$ ` and `✓`/`✖`), the
 * same convention the diff block uses for `+ `/`- `.
 */
function ShellLines({ lines, columns, errored }: { lines: string[]; columns: number; errored: boolean }) {
  const content = Math.max(8, columns - BRANCH_INDENT - 2);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const command = line.startsWith("$ ");
        const outcome = line.startsWith("✓") || line.startsWith("✖");
        const railed = !command && !outcome;
        return (
          <Box key={i} flexDirection="row" width={columns}>
            <Text dimColor>{railed ? `    ${RAIL} ` : "    "}</Text>
            <Box width={content}>
              <Text
                color={outcome ? (line.startsWith("✓") ? "green" : ERROR_COLOR) : errored && railed ? "red" : undefined}
                dimColor={railed && !errored}
                bold={command}
                wrap="truncate-end"
              >
                {line}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Diff line color by prefix; undefined means "not a diff line" (caller dims it). */
function diffColor(line: string): string | undefined {
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined;
}
