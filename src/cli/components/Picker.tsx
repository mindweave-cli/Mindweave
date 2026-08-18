/**
 * Picker — a reusable interactive list, the one selection primitive for the whole
 * UI. The session resume list (`/continue`), the model/reasoning choosers
 * (`/model`, `/think`), and the forbidden-lift approval prompt all render through
 * this, so selection looks and feels identical everywhere.
 *
 * It owns only a highlight index. ↑/↓ move (wrapping), Enter selects, Esc cancels.
 * Like the input box, it captures keys via `useInput`; the caller gates it with
 * `active` so exactly one input owner is live at a time (the prompt is disabled
 * while a picker is open).
 */
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { clipRows } from "../wrap.js";

export interface PickerItem {
  /** The main line shown for the row. */
  label: string;
  /** Optional dim detail shown to the right (e.g. a time, a one-liner). */
  description?: string;
}

interface PickerProps {
  title: string;
  items: PickerItem[];
  onSelect: (index: number) => void;
  onCancel: () => void;
  width: number;
  /** Only one input owner may be live; the caller sets this true while open. */
  active?: boolean;
  /** Row preselected on open (e.g. the newest session). Defaults to 0. */
  initialIndex?: number;
  /** Hard ceiling on the title's rendered height. See MAX_TITLE_ROWS. */
  maxTitleRows?: number;
}

const MAX_VISIBLE = 10;

/**
 * The title is clipped to this many rendered rows, wrapping included.
 *
 * The list has always been windowed; the title was not, and that was the whole bug.
 * A picker renders in the FOOTER, whose height is measured and subtracted from the
 * chat — but nothing bounded it, so a caller passing long text (exit_plan passed an
 * entire 40-step plan) pushed the frame past `stdout.rows`. Ink then swaps to
 * clearTerminal-and-redraw, stops tracking how many lines it wrote, and the screen
 * tears: header stranded at the top, no input box, scrolling moves a sliver.
 *
 * The fix that lasts is here rather than in the callers. A caller can be careless and
 * the worst outcome is a truncated prompt, not an unusable app — long context belongs
 * in `detail`, which prints to the transcript (see ToolContext.requestApproval).
 */
const MAX_TITLE_ROWS = 6;

export function Picker({
  title,
  items,
  onSelect,
  onCancel,
  width,
  active = true,
  initialIndex = 0,
  maxTitleRows = MAX_TITLE_ROWS,
}: PickerProps) {
  const [sel, setSel] = useState(Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)));

  useInput(
    (_input, key) => {
      if (key.upArrow) setSel((s) => (s - 1 + items.length) % items.length);
      else if (key.downArrow) setSel((s) => (s + 1) % items.length);
      else if (key.return) onSelect(sel);
      else if (key.escape) onCancel();
    },
    { isActive: active && items.length > 0 },
  );

  // A scrolling window so a long list never blows past the visible rows.
  const start = Math.min(Math.max(0, sel - (MAX_VISIBLE - 1)), Math.max(0, items.length - MAX_VISIBLE));
  const shown = items.slice(start, start + MAX_VISIBLE);
  const labelWidth = Math.min(40, Math.max(...items.map((i) => i.label.length), 1));

  const titleRows = clipRows(title, width, maxTitleRows);

  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {titleRows.map((line, i) => (
        <Text key={i} bold color="cyan" wrap="truncate-end">{line}</Text>
      ))}
      {shown.map((item, i) => {
        const idx = start + i;
        const activeRow = idx === sel;
        return (
          <Box key={idx} width={width - 1}>
            <Text color={activeRow ? "cyan" : undefined} bold={activeRow}>
              {activeRow ? "› " : "  "}
              {item.label.padEnd(labelWidth)}
            </Text>
            {item.description ? (
              <Text dimColor wrap="truncate-end">{"  " + item.description}</Text>
            ) : null}
          </Box>
        );
      })}
      <Text dimColor>{"  ↑/↓ move · Enter select · Esc cancel"}</Text>
    </Box>
  );
}
