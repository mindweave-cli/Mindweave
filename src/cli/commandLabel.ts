/**
 * commandLabel.ts — naming a shell command in one row.
 *
 * A row's argument is normally a path, and a path is identified by its TAIL: trimming
 * `src/cli/components/ToolLine.tsx` from the front still leaves the filename, which is
 * the part anyone was looking for.
 *
 * A command is the opposite. Its identity is at the FRONT — the program, then whatever
 * subcommand it was given — and everything after that is arguments and plumbing. Trimmed
 * the same way a path is, `gh run view 337… --log-failed | Select-String -Pattern …`
 * arrives as `…-SimpleMatch:$false | Select-Object -Last 25`, which names neither the
 * program nor what it was asked to do, and reads the same as every other long pipeline.
 *
 * So this cuts a command down from the other end, and stops at the first thing that is
 * plumbing rather than command: a pipe, a chain, a redirection.
 */

/** How many columns cutting at a word boundary may waste before the row is simply
 *  filled instead. */
const MAX_BOUNDARY_WASTE = 12;

/** Separators that end the part of a command line worth naming. */
const SEPARATORS = ["&&", "||", "|", ";"];

/**
 * The first command in a pipeline or chain, with quoting respected.
 *
 * The quote tracking is not decoration: `-Pattern 'error|ERR|failed'` carries pipes
 * inside a quoted argument, and splitting on the first one would name the command
 * `gh run view --log-failed 2>&1 | Select-String -Pattern 'error`.
 */
export function firstSegment(command: string): string {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" || ch === "`") {
      // An escape takes the next character with it, whatever it is.
      i++;
      continue;
    }
    for (const sep of SEPARATORS) {
      if (command.startsWith(sep, i)) return command.slice(0, i);
    }
  }
  return command;
}

/** Trailing stream plumbing — `2>&1`, `> out.txt`, `>> log` — which says nothing about
 *  what the command does. */
const REDIRECTION = /\s*(?:\d?>>?&?\d?|\d?<)\s*\S*\s*$/;

/**
 * A command, named in at most `budget` columns.
 *
 * Drops everything from the first pipe or chain onward, then any trailing redirection,
 * then cuts at a word boundary if what is left is still too long. The ellipsis says the
 * command continues; the row is a name for it, not a transcript of it.
 */
export function commandLabel(command: string, budget: number): string {
  const room = Math.max(4, budget);
  let label = firstSegment(command.trim()).trim();
  for (let previous = ""; previous !== label; ) {
    previous = label;
    label = label.replace(REDIRECTION, "").trim();
  }
  if (label === "") label = command.trim();
  if (label.length <= room) return label;

  // Cut at a space, so the last thing shown is a whole token rather than half a flag —
  // but not at any price. A command whose remaining argument is one long unbroken token
  // (a quoted URL, a path with no spaces) has its nearest boundary a long way back, and
  // honouring it there gives up most of the row to show less of the command. So the
  // boundary wins only while it costs little; past that, filling the row is worth more
  // than a tidy edge.
  const cut = label.lastIndexOf(" ", room - 1);
  const kept = cut > 0 && room - cut <= MAX_BOUNDARY_WASTE ? label.slice(0, cut) : label.slice(0, room - 1);
  return kept.trimEnd() + "…";
}
