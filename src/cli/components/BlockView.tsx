/**
 * BlockView — render one transcript block, the same whether committed (in
 * <Static> scrollback) or live in the tail. Gutter-aligned: the
 * first row of every block is a single marker in a 2-col gutter, the content
 * breathing beside it and wrapped lines hanging under the content.
 *
 * Multi-line text is wrapped BY US (wrap.ts), not left to Ink's own
 * `wrap="wrap"` — that has a real, reproduced bug where some continuation
 * lines come out indented by a stray leading space and others on the exact
 * same text don't (see wrap.ts's header comment for the proof). Wrapping
 * ourselves and rendering one <Text> per finished line leaves nothing for
 * Ink's wrapper to be inconsistent about.
 */
import { memo } from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "../markdown.js";
import { wrapAnsi } from "../wrap.js";
import { KIND_COLOR } from "../toolDisplay.js";
import { compactionLines } from "../compaction.js";
import { ToolLine } from "./ToolLine.js";
import { ToolGroup } from "./ToolGroup.js";
import { SubagentView } from "./SubagentView.js";
import type { Block } from "../transcript.js";

/**
 * Text pre-wrapped to `width`, one <Text> row per line — see the file header.
 *
 * A blank line is rendered as a single space, not as "". Ink's `measureText`
 * (`ink/build/measure-text.js`) returns `height: 0` for an empty string, so an empty
 * <Text> occupies no row at all and every blank line in the markdown disappears —
 * which is what turned structured answers into one undifferentiated wall. The
 * separators were being produced correctly by renderMarkdown and thrown away here.
 * Probed: rows ["A","","B"] render as ["A","B"] with "", as ["A","","B"] with " ".
 */
function WrappedText({ text, width, color }: { text: string; width: number; color?: string }) {
  return (
    <Box width={width} flexDirection="column">
      {wrapAnsi(text, width).map((line, i) => (
        <Text key={i} color={color} wrap="truncate-end">{line === "" ? " " : line}</Text>
      ))}
    </Box>
  );
}

/** The widest a line of prose is allowed to get, in columns. Around the top of the
 *  range typography settles on for continuous reading; past it the eye starts
 *  missing the start of the next line. */
const READING_WIDTH = 88;

function BlockViewInner({ block, columns, tightTop }: { block: Block; columns: number; tightTop?: boolean }) {
  const textWidth = Math.max(8, columns - 4);

  switch (block.kind) {
    case "user":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text color="cyan">{">"}</Text></Box>
          <WrappedText text={block.text} width={textWidth} color="cyan" />
        </Box>
      );

    case "assistant": {
      if (!block.text) return null;
      // Prose is capped at a reading width rather than run to the terminal's edge.
      // Line length is the oldest measured variable in typography and a wide
      // terminal is well past the point where the eye starts losing its place on
      // the return sweep — the answer gets harder to read the bigger the window
      // gets, which is the wrong way round. Tools and diffs still use the full
      // width; only prose is bounded, because only prose is read line after line.
      const proseWidth = Math.min(textWidth, READING_WIDTH);
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text>{"●"}</Text></Box>
          <WrappedText text={renderMarkdown(block.text, proseWidth)} width={proseWidth} />
        </Box>
      );
    }

    case "tool":
      return (
        <ToolLine
          name={block.name}
          arg={block.arg}
          status={block.status}
          action={block.action}
          summary={block.summary}
          detail={block.detail}
          detailKind={block.detailKind}
          meta={block.meta}
          columns={columns}
          live={block.live}
          tightTop={tightTop}
        />
      );

    case "tools":
      return <ToolGroup items={block.items} live={block.live} columns={columns} tightTop={tightTop} />;

    case "subagent":
      return (
        <SubagentView
          agents={block.agents}
          done={block.done}
          columns={columns}
          tightTop={tightTop}
        />
      );

    case "error":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text color="red">{"●"}</Text></Box>
          <WrappedText text={block.text} width={textWidth} color="red" />
        </Box>
      );

    case "completion":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text dimColor>{"✻"}</Text></Box>
          <Text dimColor>{block.text}</Text>
        </Box>
      );

    case "note": {
      const noteLines = wrapAnsi(block.text, Math.max(4, columns - 2));
      return (
        <Box width={columns} flexDirection="column">
          {noteLines.map((line, i) => (
            <Text key={i} dimColor>{i === 0 ? "· " : "  "}{line}</Text>
          ))}
        </Box>
      );
    }

    case "notice": {
      // A gate, not a remark. Amber marker and a rail, so "you are about to run this"
      // cannot be mistaken for the assistant's own ● prose and skimmed past. Lines are
      // rendered verbatim — no markdown — because they are literal commands and paths
      // where a stray backtick or underscore must not be reinterpreted.
      const railWidth = Math.max(8, columns - 4);
      return (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Box minWidth={2}><Text color={KIND_COLOR.governor}>{"●"}</Text></Box>
            <Text bold>{block.title}</Text>
          </Box>
          {block.body.split("\n").flatMap((line, i) =>
            wrapAnsi(line, railWidth).map((row, j) => (
              <Box key={`${i}-${j}`} flexDirection="row" width={columns}>
                <Text color={KIND_COLOR.governor} dimColor>{"  │ "}</Text>
                <Box width={railWidth}>
                  <Text wrap="truncate-end">{row}</Text>
                </Box>
              </Box>
            )),
          )}
        </Box>
      );
    }

    case "compaction": {
      // The bars are pre-composed as plain rows (compaction.ts) so the layout is
      // testable without a terminal. Each row is printed verbatim and truncated, never
      // wrapped: half a progress bar on the next line reads as two broken bars.
      const rows = compactionLines(block.report, columns - 2);
      return (
        <Box marginTop={1} marginBottom={1} flexDirection="column" width={columns}>
          {rows.map((line, i) => (
            <Text key={i} dimColor={i !== 1} wrap="truncate-end">{"  "}{line}</Text>
          ))}
        </Box>
      );
    }

    case "context":
      // Context trimming (compaction) — set off from ordinary activity with its own
      // faint marker and italics, so it reads as housekeeping, not something Mindweave did.
      return (
        <Box marginTop={1} marginBottom={1} width={columns}>
          <Text dimColor italic wrap="truncate-end">{"⋯ "}{block.text}</Text>
        </Box>
      );
  }
}

/**
 * MEMOIZED, and this is the single most load-bearing line in the UI's performance.
 *
 * Ink re-renders the WHOLE component tree on every React state change — there is no
 * partial update, and after the commit it erases the drawn lines and rewrites them.
 * Every keystroke is a state change (the prompt's reducer), and so is every wheel
 * tick (`scrollUp`). Without this wrapper each of those re-ran `renderMarkdown` and
 * `wrapAnsi` from scratch for EVERY block on screen, then handed Yoga a fresh tree to
 * lay out.
 *
 * Measured, on a realistic assistant reply, before this landed:
 *
 *   | blocks | text work per keystroke |
 *   |--------|-------------------------|
 *   |     30 |                 17.9 ms |
 *   |     80 |                 47.7 ms |
 *   |    150 |                 89.4 ms |
 *
 * — and that is BEFORE layout and redraw, against Ink's 32ms frame throttle. It is
 * why typing got slower the longer the conversation ran, why scrolling stuttered, and
 * why a tool block "popped" instead of appearing cleanly: it was landing inside a
 * frame that took ~90ms to draw.
 *
 * The reason a plain shallow compare is CORRECT here, rather than a lucky shortcut:
 * the transcript reducer never rebuilds a block that did not change. `commit` concats,
 * `patch` maps and returns `b` untouched unless the id matches, and `endTurn`'s `clear`
 * returns `b` itself for everything except a live tool row. So block identity is stable
 * across renders by construction, and the one moment a committed row is allowed to
 * change (`live` flipping at turn end) DOES produce a new object and so DOES re-render.
 * `columns` and `tightTop` are primitives. Nothing here is a fresh object or closure
 * per render, which is the usual reason `memo` silently does nothing.
 *
 * If a future block type is given a prop that is built inline at the call site (an
 * array, an object, a callback), this optimization is dead and the lag returns with no
 * test failing. Keep the props primitive-or-stable.
 */
export const BlockView = memo(BlockViewInner);

