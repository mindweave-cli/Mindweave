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
  /** Dim text shown BELOW the items, above the key hint — context that isn't itself a
   *  choice (e.g. what a setting actually does). Counted into the fixed-height budget
   *  the same way the title is. */
  note?: string;
  maxNoteRows?: number;
  /**
   * Show the HIGHLIGHTED item's full description below the list, wrapped, instead of
   * truncated on its own row.
   *
   * A one-line row can only ever show the first few words of a long description before an
   * ellipsis, which reads as broken. With this on, the rows carry labels alone and the
   * selection's description appears in full below — wrapping down the way the rest of the
   * full-screen shell does — and updates as the highlight moves. Reserves `maxNoteRows`,
   * so the box stays a fixed height whatever the description's length.
   */
  describeSelection?: boolean;
  /**
   * Pin each item's description to the RIGHT edge of its row, label filling the rest.
   * The clean table look for a list whose labels vary wildly in length (session titles);
   * the default aligned column is better when the labels are uniform. See the row render.
   */
  rightAlignDescription?: boolean;
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
const MAX_NOTE_ROWS = 4;

export function Picker({
  title,
  items,
  onSelect,
  onCancel,
  width,
  active = true,
  initialIndex = 0,
  maxTitleRows = MAX_TITLE_ROWS,
  note,
  maxNoteRows = MAX_NOTE_ROWS,
  describeSelection = false,
  rightAlignDescription = false,
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
  // The note is either the caller's own text, or — with describeSelection — the
  // highlighted item's full description, wrapped. The two never combine: a picker that
  // describes its selection has no separate note to show.
  const selectionNote = describeSelection ? items[sel]?.description ?? "" : "";
  const noteText = describeSelection ? selectionNote : note ?? "";
  const noteRows = noteText ? clipRows(noteText, rowWidth, maxNoteRows) : [];

  // Blank rows so title + list + note is a fixed count, matching the command menu's
  // header(1) + maxRows. The box is then the SAME height as the command box and never
  // resizes when a shorter list (or no note) is shown — the surplus is empty space,
  // not a smaller box.
  const noteGap = noteRows.length > 0 ? 1 : 0;
  const pad = Math.max(0, maxRows + 1 - titleRows.length - shown.length - noteGap - noteRows.length);

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
        // Right-aligned metadata: the description is pinned to the row's right edge and
        // the label takes the rest, truncating if it must. It is the clean table look for
        // a list whose labels vary wildly in length — session titles run from three
        // words to a whole sentence, and a left-aligned column then either strands the
        // short ones far from their metadata or crowds the long ones out of it. The
        // aligned-column layout below is right when the labels are uniform (provider
        // names, model tiers); this is right when they are not.
        if (rightAlignDescription && item.description && !describeSelection) {
          return (
            <Box key={idx} width={rowWidth} flexShrink={0}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={activeRow ? "cyan" : undefined} bold={activeRow} wrap="truncate-end">
                  {activeRow ? "› " : "  "}
                  {item.label}
                </Text>
              </Box>
              {/* flexShrink:0 so the metadata keeps its full width and the LABEL shrinks
                  and truncates instead — otherwise a long label pushed the description
                  onto a second wrapped line. */}
              <Box flexShrink={0}>
                <Text dimColor>{"  " + item.description}</Text>
              </Box>
            </Box>
          );
        }
        return (
          <Box key={idx} width={rowWidth} flexShrink={0}>
            <Text color={activeRow ? "cyan" : undefined} bold={activeRow}>
              {activeRow ? "› " : "  "}
              {item.label.padEnd(labelWidth)}
            </Text>
            {/* The description is shown BELOW the list when describeSelection is set — see
                the note area — so it is not repeated, truncated, on the row here. */}
            {item.description && !describeSelection ? (
              <Box width={descWidth}>
                <Text dimColor wrap="truncate-end">{"  " + item.description}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {noteGap ? (
        <Box flexShrink={0}><Text> </Text></Box>
      ) : null}
      {noteRows.map((line, i) => (
        <Box key={`n${i}`} width={rowWidth} flexShrink={0}>
          <Text dimColor wrap="truncate-end">{line}</Text>
        </Box>
      ))}
      {Array.from({ length: pad }).map((_, i) => (
        <Box key={`pad${i}`} flexShrink={0}><Text> </Text></Box>
      ))}
      <Box flexShrink={0}>
        {/* Backspace goes back as well as Escape, and saying so is the only way that is
            discoverable: the instinct on a screen you opened by mistake is to delete your
            way out of it, and a hint that names only Escape reads as if nothing else works. */}
        <Text dimColor>{"↑/↓ move · Enter select · Esc or ⌫  back"}</Text>
      </Box>
    </>
  );
}
