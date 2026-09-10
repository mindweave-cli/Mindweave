/**
 * exitCursor.ts — leaving the terminal cursor somewhere the next program can print.
 *
 * The inline shell hands the terminal back with the cursor wherever the CARET was, which
 * is inside the input box — two or three rows above the end of everything the app
 * printed. Nothing in the restore sequence moves it: `TERMINAL_RESTORE` turns modes off,
 * it does not reposition.
 *
 * The shell that regains control then prints its prompt at that cursor, and a prompt is
 * written at column zero WITHOUT clearing the rest of the line. So `C:\...>` lands on top
 * of the first seventeen characters of a line of the conversation, and every Enter after
 * it walks one row further down doing the same thing again — a column of prompts eating
 * the left edge of the transcript, one row per keypress. It looks like the transcript has
 * been corrupted, and it survives on screen because it IS the terminal's scrollback now;
 * nothing the app could do afterwards would repair it, and the app is gone.
 *
 * The fix is one cursor move, made before the restore: down to the last row the app
 * actually drew on, then to a fresh line under it. From there the shell prints its prompt
 * below the conversation, where a prompt belongs.
 *
 * ## Why the distance is measured rather than assumed
 *
 * "Two rows below the caret" is true of the ordinary footer and false the moment anything
 * else is on screen — a wrapped multi-line input, an open command palette, a picker, an
 * approval. Each of those puts a different number of rows under the caret, and guessing
 * low is exactly the bug this exists to remove. So the view measures the real distance
 * every render and leaves the answer here, where an exit path can read it without
 * touching React.
 */

/** Rows between the caret and the last row the app drew. Zero means "already at the end". */
let below = 0;

/**
 * Publish the measured distance. Called from the render, cheap enough to call every time.
 *
 * The full-screen shell sets ZERO and means it: it hands back by leaving the alternate
 * screen buffer, which restores the primary buffer and the cursor with it, so there is
 * nothing here to correct.
 */
export function setRowsBelowCaret(rows: number): void {
  below = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
}

/**
 * The sequence that puts the cursor on a fresh line below the app's output (pure).
 *
 * `CUD` (cursor down) rather than newlines: a newline at the bottom of the screen SCROLLS,
 * so overshooting with them would push the conversation up and off the top — turning a
 * misjudged distance into lost content. `CUD` is clamped by the terminal to the bottom
 * row and scrolls nothing, so being wrong costs a blank row instead.
 *
 * The trailing CR-LF is the one deliberate scroll: it opens the fresh line the prompt is
 * printed on, so the prompt sits under the last row of the conversation rather than on it.
 */
export function caretToOutputEnd(): string {
  return `${below > 0 ? `\x1b[${below}B` : ""}\r\n`;
}
