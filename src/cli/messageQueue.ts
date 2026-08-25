/**
 * messageQueue.ts — messages typed while Mindweave is working.
 *
 * The queue existed before this file did, as six lines inside App.tsx: push on send,
 * shift on turn end. That is enough to not lose a message and not enough to be a
 * feature. Three things were missing, and all three were things a user would only
 * discover by being burned:
 *
 *  - **No way back out.** Once queued, a message was going to be sent. Pressing ↑
 *    looked like editing it — the text appeared, because sending had already written
 *    it to history — but the queued copy was untouched. Editing and sending produced
 *    TWO messages: the edit, and the original the user thought they had just replaced.
 *  - **One turn each.** Three queued messages meant three full turns, each re-sending
 *    the whole conversation. The model also answered each in ignorance of the next,
 *    which is the wrong reading of someone typing three things in a row.
 *  - **Unbounded on screen.** The queue renders in the footer, and the footer is not
 *    height-bounded. Enough queued lines make the frame taller than the terminal,
 *    which corrupts the whole screen rather than clipping (see App's frameHeight
 *    note). Nothing stopped that.
 *
 * The shape here follows Claude Code's: ↑ or Esc pulls the WHOLE queue back into the
 * input as editable text, and the drain batches. Kept deliberately as pure functions
 * over a plain array — the queue is small, always local to one App, and every rule in
 * it is worth a test.
 */

/** Rows of queue the footer will show before collapsing the rest into a count. */
export const MAX_VISIBLE_QUEUED = 3;

/**
 * A queued entry is just its text. There is no mode field on purpose: a slash command
 * is recognised by its own syntax, the same way the send path recognises it, so the
 * queue cannot disagree with the thing that eventually runs it.
 */
export type Queued = string;

/** Whether this entry runs as a command rather than being said to the model. */
export function isCommand(text: Queued): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * What to send next, and what stays queued.
 *
 * Consecutive plain messages go out TOGETHER, as one turn. Someone who types three
 * sentences while waiting meant them as one thought, and answering the first without
 * having read the third is how you get an answer that is immediately obsolete. It is
 * also the cheaper read: one turn re-sends the conversation once instead of three
 * times.
 *
 * A slash command always goes alone. It is not something to say to the model, it is
 * something to DO — merging `/model` into the prose around it would send the literal
 * word to the model instead of switching anything.
 */
export function drain(queue: readonly Queued[]): { send: string; rest: Queued[] } | undefined {
  if (queue.length === 0) return undefined;
  const first = queue[0]!;
  if (isCommand(first)) return { send: first, rest: queue.slice(1) };

  let i = 0;
  while (i < queue.length && !isCommand(queue[i]!)) i++;
  // A blank line between them, not a bare newline: these were separate messages, and
  // run together they read as one rambling paragraph.
  return { send: queue.slice(0, i).join("\n\n"), rest: queue.slice(i) };
}

export interface PopResult {
  /** The full text to put in the input box. */
  text: string;
  /** Where to leave the cursor in it. */
  cursor: number;
}

/**
 * Pull the whole queue back into the input for editing.
 *
 * ALL of it, not just the last one. Partial removal would need the user to hold a
 * selection in their head across a screen that is also printing tool output at them;
 * emptying it and letting them re-send what they still want is fewer moving parts and
 * cannot leave a message queued that they believe they cancelled.
 *
 * Anything already typed is kept and moved to the END, and that ordering is the whole
 * point: a half-written line is the newest thing the user was saying, so it belongs
 * after the older queued messages, not in front of them. The cursor lands where that
 * draft starts, which is where they were.
 */
export function popAll(
  queue: readonly Queued[],
  currentInput: string,
  currentCursor: number,
): PopResult | undefined {
  if (queue.length === 0) return undefined;
  const queuedText = queue.join("\n");
  if (currentInput === "") return { text: queuedText, cursor: queuedText.length };
  return {
    text: `${queuedText}\n${currentInput}`,
    // +1 for the newline that joins the draft on.
    cursor: queuedText.length + 1 + currentCursor,
  };
}

/**
 * What the footer shows: the first few entries, and how many are hidden.
 *
 * Capped because the footer is not height-bounded and an over-tall frame corrupts the
 * screen rather than clipping. The count is not decoration — a user who queued six
 * messages needs to know six are coming, even when they can only see three.
 */
export function visibleQueue(queue: readonly Queued[]): { rows: Queued[]; hidden: number } {
  return {
    rows: queue.slice(0, MAX_VISIBLE_QUEUED),
    hidden: Math.max(0, queue.length - MAX_VISIBLE_QUEUED),
  };
}
