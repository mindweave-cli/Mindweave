/**
 * approvalChannel.ts — the settlement rules for asking the user something.
 *
 * The overlay is a single slot, and approvals arrive from more than one place: a tool
 * mid-turn, the Sentinel gate, MCP trust verification kicked off from a floating promise
 * at session start. A second request used to overwrite the first and drop its resolver,
 * so the tool awaiting it waited for the rest of the session with nothing on screen to
 * explain why — and in the worse ordering, the answer to the second question was handed
 * to the first tool.
 *
 * So the queue lives here, out of the component, where it can be driven directly by a
 * test. Claude Code queues its permission requests for the same reason.
 *
 * Three rules, and all three are the point:
 *   - ONE AT A TIME. A request waits rather than replacing what is on screen.
 *   - EXACTLY ONCE. Whoever settles it first wins; later answers are ignored rather
 *     than attributed to whatever asked next.
 *   - NOTHING HANGS. An interrupt answers everything not yet shown, because a queued
 *     request has no overlay to press Esc on and nothing else could ever settle it.
 */

export interface PendingApproval<T> {
  /** What the UI needs to render this one. */
  item: T;
  /** Settles the awaiting caller. Safe to call more than once; the first wins. */
  settle: (choice: string) => void;
}

export class ApprovalChannel<T> {
  private shown: PendingApproval<T> | null = null;
  private readonly queued: PendingApproval<T>[] = [];

  /** What should be on screen right now, or null when nothing is being asked. */
  get current(): T | null {
    return this.shown?.item ?? null;
  }

  /** How many requests are waiting behind the one on screen. */
  get waiting(): number {
    return this.queued.length;
  }

  /** Ask, resolving when this particular request is answered. */
  ask(item: T): Promise<string> {
    return new Promise<string>((resolve) => {
      let settled = false;
      this.queued.push({
        item,
        settle: (choice: string) => {
          if (settled) return;
          settled = true;
          resolve(choice);
        },
      });
      this.pump();
    });
  }

  /** Answer the request currently on screen and bring the next one forward. */
  answer(choice: string): void {
    const done = this.shown;
    this.shown = null;
    done?.settle(choice);
    this.pump();
  }

  /**
   * Answer everything NOT yet shown, as the user declining.
   *
   * The displayed one is deliberately left alone: it is on screen and Esc owns it, so
   * settling it here would answer a question the user is still looking at.
   */
  dismissWaiting(dismissed: string): void {
    const rest = this.queued.splice(0, this.queued.length);
    for (const o of rest) o.settle(dismissed);
  }

  private pump(): void {
    if (!this.shown) this.shown = this.queued.shift() ?? null;
  }
}
