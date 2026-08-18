/**
 * ToolGroup — one consolidated row for a burst of file reads, plus the calls
 * it made listed beneath it.
 *
 *   ● Read 2 files
 *     ⎿ views.py  42 lines
 *     ⎿ auth.py   128 lines
 *
 * The block appears ONCE, already carrying its list — it is not dispatched until
 * its calls have resolved (App's pump holds it). The only thing that ever changes
 * afterwards is the verb, which settles from "Reading" to "Read" when the turn
 * ends. A bare "Reading 2 files…" header that later grows a body is exactly the
 * transition this design exists to remove, so nothing here may key off `done`.
 *
 * It used to render the header ALONE, on the theory that the count told the
 * story and the individual calls were detail nobody reads. It didn't: "Explored
 * 2 items" names neither the files nor what was found, so it occupied a row
 * while answering nothing. The calls are listed now, collapsed and capped.
 *
 * What is grouped narrowed at the same time. Searches (grep/glob) left the group
 * and became their own block, because a search's pattern and its hits are the
 * whole point of it. The pure code-intel lookups (outline/definition/references/
 * relevant) went the other way and are hidden entirely — they are how the agent
 * navigates, not something done TO the project. See isGroupable.
 */
import { Box, Text } from "ink";
import { KIND_COLOR, ERROR_COLOR } from "../toolDisplay.js";
import { collapseAdjacent } from "../toolItems.js";
import type { ToolGroupItem } from "../transcript.js";

const DOT = "●";

export function ToolGroup({
  items,
  live,
  columns,
  tightTop,
}: {
  items: ToolGroupItem[];
  /** Is the turn that made these calls still running? Chooses the verb, nothing else. */
  live?: boolean;
  columns: number;
  tightTop?: boolean;
}) {
  const n = items.length;
  const anyError = items.some((it) => it.status === "error");
  // Named for what it actually did when it's all one kind of work, which after
  // the narrowing above is the common case: a burst of reads says "Read 3 files".
  const allReads = items.every((it) => it.kind === "read");
  const noun = allReads ? (n === 1 ? "file" : "files") : n === 1 ? "item" : "items";
  const verb = live ? (allReads ? "Reading" : "Exploring") : allReads ? "Read" : "Explored";
  const header = `${verb} ${n} ${noun}`;

  // The discovery dot takes the group's dominant action colour (reads vs searches),
  // red if any call in it failed. It is NOT dimmed while the turn runs: this block
  // is only ever rendered once its calls have resolved, so there is no unresolved
  // state to signal, and dimming would be a second thing changing under the user.
  const dotColor = anyError ? ERROR_COLOR : KIND_COLOR[dominantKind(items)];
  const collapsed = collapseAdjacent(items);
  const rows = collapsed.slice(0, GROUP_MAX_ROWS);
  const hidden = collapsed.length - rows.length;
  const content = Math.max(8, columns - 5);

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={dotColor}>{DOT}</Text>
        </Box>
        <Text bold>{header}</Text>
      </Box>
      {rows.map((row) => (
        <Box key={row.item.toolId} flexDirection="row" width={columns}>
          <Text dimColor>{"  ⎿ "}</Text>
          <Box width={content}>
            <Text color={row.anyError ? "red" : undefined} dimColor={!row.anyError} wrap="truncate-end">
              {row.label}
              {/* The count only. The note is NOT appended here: itemLabel already
                  RETURNS the note for a resolved item, so appending it printed the
                  whole result twice ("Read src/a.ts (195 lines)  read src/a.ts
                  (195 lines)"), which only escaped notice because the duplicate
                  fell past the truncation edge on a narrow terminal. */}
              {row.count > 1 ? `  ×${row.count}` : ""}
            </Text>
          </Box>
        </Box>
      ))}
      {hidden > 0 ? <Text dimColor>{`    … ${hidden} more`}</Text> : null}
    </Box>
  );
}

/** Rows listed under a finished discovery group before the rest are summarised.
 *  Exported so viewport.ts's height estimate uses the same cap this renders. */
export const GROUP_MAX_ROWS = 6;

/** The most common action in a discovery burst — used to colour its dot. Defaults
 *  to "search" (the family reads/greps/maps all belong to). */
function dominantKind(items: ToolGroupItem[]): "read" | "search" {
  const reads = items.filter((it) => it.kind === "read").length;
  return reads > items.length / 2 ? "read" : "search";
}
