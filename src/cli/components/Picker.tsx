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
  /** How many list rows may show at once — App computes this from the real frame
   *  height so the bordered box never grows past the screen and tears. Falls back
   *  to a small, always-safe count. */
  maxRows?: number;
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
  maxRows = MAX_VISIBLE,
}: PickerProps) {
  // Same window size as the command menu (App clamps maxRows to a safe ceiling), so the
  // picker box and the command box are the SAME fixed height.
  const visible = Math.max(1, maxRows);
  const [sel, setSel] = useState(Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)));

  useInput(
    (_input, key) => {
      if (key.upArrow) setSel((s) => (s - 1 + items.length) % items.length);
      else if (key.downArrow) setSel((s) => (s + 1) % items.length);
      else if (key.return) onSelect(sel);
      // Esc closes, and so does Backspace/Delete: the input line above is empty, so a
      // delete is the natural "take it back" — the same gesture that removes the `/` and
      // closes the command menu. Without it the only way out was Esc, which is not
      // discoverable when your instinct is to delete what you just chose.
      else if (key.escape || key.backspace || key.delete) onCancel();
    },
    { isActive: active && items.length > 0 },
  );

  // A scrolling window so a long list never blows past the visible rows.
  const start = Math.min(Math.max(0, sel - (visible - 1)), Math.max(0, items.length - visible));
  const shown = items.slice(start, start + visible);
  const labelWidth = Math.min(40, Math.max(...items.map((i) => i.label.length), 1));

  // Widths subtract the input box's chrome — border (2) + paddingX (2) = 4 — plus the
  // 2-col prefix, so a truncated label/description ends INSIDE the border rather than
  // overflowing the row and wrapping onto a blank continuation line.
  const rowWidth = width - 4;
  const descWidth = Math.max(4, rowWidth - 2 - labelWidth);
  // Where you are in the list, on the title row. A window over a long list otherwise gives
  // no sign that there is more of it, and the rows that used to say so were removed for
  // changing the box's height as you reached the ends. A counter on a row that already
  // exists says the same thing and cannot resize anything.
  const counter = items.length > visible ? `  ${sel + 1} of ${items.length}` : "";
  const titleRows = clipRows(title, Math.max(4, rowWidth - counter.length), maxTitleRows);

  // Blank rows so title + list is a fixed count, matching the command menu's header(1) +
  // maxRows. The box is then the SAME height as the command box and never resizes when a
  // shorter list is shown — the surplus is empty space, not a smaller box.
  const pad = Math.max(0, maxRows + 1 - titleRows.length - shown.length);

  // Content only — the surrounding box is the ONE input box in PromptInput, shared with
  // the input line, so opening this picker from the command menu swaps the box's
  // contents rather than replacing the box. Same header treatment as the command menu:
  // a plain bold label, not a loud colour, so every surface reads as one family. The
  // description sits in its own fixed-width Box for the same reason as the command
  // menu's — a bare Text has nothing to truncate against and wraps instead.
  return (
    <>
      {titleRows.map((line, i) => (
        <Box key={`t${i}`} width={rowWidth} flexShrink={0}>
          <Text bold wrap="truncate-end">{line}</Text>
          {i === 0 && counter ? <Text dimColor>{counter}</Text> : null}
        </Box>
      ))}
      {shown.map((item, i) => {
        const idx = start + i;
        const activeRow = idx === sel;
        return (
          <Box key={idx} width={rowWidth} flexShrink={0}>
            <Text color={activeRow ? "cyan" : undefined} bold={activeRow}>
              {activeRow ? "› " : "  "}
              {item.label.padEnd(labelWidth)}
            </Text>
            {item.description ? (
              <Box width={descWidth}>
                <Text dimColor wrap="truncate-end">{"  " + item.description}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {Array.from({ length: pad }).map((_, i) => (
        <Box key={`pad${i}`} flexShrink={0}><Text> </Text></Box>
      ))}
      <Box flexShrink={0}>
        {/* Backspace goes back as well as Escape, and saying so is the only way that is
            discoverable: the instinct on a screen you opened by mistake is to delete your
            way out of it, and a hint that names only Escape reads as if nothing else works. */}
        <Text dimColor>{"↑/↓ move · Enter select · Esc or ⌫ back"}</Text>
      </Box>
    </>
  );
}
