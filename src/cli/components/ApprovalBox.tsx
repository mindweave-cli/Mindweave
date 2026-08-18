/**
 * ApprovalBox — the bordered prompt for a decision the agent cannot make alone.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Start on this?                               │
 *   │                                              │
 *   │  › [1] Approve — Lightning (just do it)      │
 *   │    [2] Approve — Sentinel (ask each action)  │
 *   │    [3] Reject                                │
 *   │                                              │
 *   │ ↑/↓ or 1-3 · Enter to choose · Esc to cancel │
 *   └──────────────────────────────────────────────┘
 *
 * Separate from `Picker` on purpose. A picker is a LIST you scroll — sessions, models,
 * shells — and it is fine for it to look like one. This is a QUESTION with two to four
 * answers, it arrives unbidden in the middle of the user's work, and the answer commits
 * them to something (running a command, starting a plan). It gets a border so it reads
 * as a stop rather than as more output, and blank lines above and below the choices so
 * the thing being agreed to does not blur into the thing agreeing to it.
 *
 * Number keys are accepted as well as arrows, because this prompt is a decision the
 * user wants over with, not a list to browse. They are numbers rather than per-answer
 * letters ([y]/[a]/[n]) so the accelerator can never disagree with the wording — the
 * answers are supplied by the caller and change from prompt to prompt.
 *
 * HEIGHT IS BOUNDED, and that is not cosmetic. This draws in the footer, and anything
 * there that grows past the terminal's height makes Ink abandon its erase-and-redraw:
 * the screen tears, the input box is pushed off, and the app looks frozen with no way
 * to answer. That is a bug this project has already shipped once — see clipRows.
 */
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { clipRows } from "../wrap.js";

/** Rows the question may occupy before it is cut (wrapping included). */
const MAX_QUESTION_ROWS = 4;
/** Answers shown. More than this and the caller is asking the wrong question. */
const MAX_CHOICES = 6;

export interface ApprovalBoxProps {
  /** The question — ONE short line. Long context belongs in the transcript. */
  question: string;
  /** The answers, in order. The first is preselected. */
  options: string[];
  onSelect: (index: number) => void;
  onCancel: () => void;
  width: number;
  /** Only one input owner may be live; the caller sets this true while open. */
  active?: boolean;
}

export function ApprovalBox({
  question,
  options,
  onSelect,
  onCancel,
  width,
  active = true,
}: ApprovalBoxProps) {
  const shown = options.slice(0, MAX_CHOICES);
  const [sel, setSel] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow) setSel((s) => (s - 1 + shown.length) % shown.length);
      else if (key.downArrow) setSel((s) => (s + 1) % shown.length);
      else if (key.return) onSelect(sel);
      else if (key.escape) onCancel();
      else {
        // A number picks AND commits in one keystroke. Selecting without confirming
        // would make the fast path silently need a second key.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= shown.length) onSelect(n - 1);
      }
    },
    { isActive: active && shown.length > 0 },
  );

  // Inside the border: two frame columns and one padding column each side.
  const inner = Math.max(12, width - 4);
  const questionRows = clipRows(question, inner, MAX_QUESTION_ROWS);

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      {/* flexShrink:0 on every row, for the same reason the command palette has it:
          without it Yoga compresses an overfull box instead of leaving it at its
          real height, and the height is what the footer measurement depends on. */}
      {questionRows.map((line, i) => (
        <Box key={`q${i}`} flexShrink={0}>
          <Text bold wrap="truncate-end">{line}</Text>
        </Box>
      ))}

      <Box flexShrink={0}><Text> </Text></Box>

      {shown.map((label, i) => {
        const on = i === sel;
        return (
          <Box key={i} width={inner} flexShrink={0}>
            <Text color={on ? "cyan" : undefined} bold={on}>
              {on ? " › " : "   "}
              {`[${i + 1}] `}
            </Text>
            <Box width={Math.max(4, inner - 7)}>
              <Text color={on ? "cyan" : undefined} bold={on} wrap="truncate-end">
                {label}
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box flexShrink={0}><Text> </Text></Box>

      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {`↑/↓ or 1-${shown.length} · Enter to choose · Esc to cancel`}
        </Text>
      </Box>
    </Box>
  );
}
