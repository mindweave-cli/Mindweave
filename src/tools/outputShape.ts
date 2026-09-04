/**
 * outputShape.ts — cutting captured command output down to what is worth reading.
 *
 * A build log, a CI log and a test runner all have the same shape: a narrow column of
 * information wrapped in a wide column of repetition. Every line of a GitHub Actions log
 * carries the job name and a full timestamp before it says anything, which on a terminal
 * is more than half the row spent on text that is identical from line to line and was
 * never the reason anyone looked.
 *
 * Two rules, kept separate because they answer to different evidence:
 *
 *   - a prefix shared by every line is chrome, whatever it happens to say
 *   - a timestamp at the start of a line is chrome even when every one differs
 *
 * Then what is left is capped from the END. Output is read backwards: a build says what
 * went wrong on its last line and what it was doing on its first. The previous cap kept
 * the head, which is why a failed run showed its opening banner and dropped the error.
 *
 * Pure, so all of it is decided by tests on plain arrays rather than by looking at a
 * screen and forming an opinion.
 */

/** Minimum length for a column head to be worth removing. */
const MIN_PREFIX = 3;

/** Fewer lines than this is not a pattern, it is a coincidence. */
const MIN_LINES_FOR_PREFIX = 3;

/** How far into a line a column gutter may sit. Past this it is not a margin around the
 *  content, it is most of the content. */
const MAX_PREFIX = 80;

/** The share of lines that must carry the same head before it counts as chrome. Well
 *  under all of them, because logs interleave: a wrapped continuation, a line from
 *  another stream, and a blank all legitimately arrive without the column. */
const PREFIX_SHARE = 0.6;

/** A run of two or more spaces — how padded output separates its fields. One space is
 *  just as likely to be the space in a sentence. */
const GUTTER = / {2,}/g;

/**
 * An ISO-8601 timestamp at the start of a line, as CI logs emit them, with or without
 * fractional seconds and with any of the usual zone spellings.
 *
 * Exactly one space is taken with it, never a run. The separator after a stamp is a
 * single space, and anything past that is the line's own indentation — a stack trace is
 * indented under the error it belongs to, and swallowing that would flatten it.
 */
const LEADING_TIMESTAMP =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]) ?/;

/**
 * The columns a line opens with, if it opens with any.
 *
 * Everything up to and including the LAST gutter that still sits near the start of the
 * line, so a row of several padded fields gives up all of them at once rather than one
 * per pass. A line with no gutter has no head, and is left alone.
 */
function columnHead(line: string): string | undefined {
  let end: number | undefined;
  GUTTER.lastIndex = 0;
  for (let m = GUTTER.exec(line); m; m = GUTTER.exec(line)) {
    const stop = m.index + m[0].length;
    if (stop > MAX_PREFIX) break;
    // A head that swallows the line is not chrome around content, it IS the content.
    if (stop >= line.length) break;
    end = stop;
  }
  return end !== undefined && end >= MIN_PREFIX ? line.slice(0, end) : undefined;
}

/**
 * Drop the column head that most lines share.
 *
 * MOST, not all, and this is the whole difficulty. Requiring every line to carry the
 * prefix reads well as a rule and fails on every real log, because logs interleave: a
 * stack trace continues on an unprefixed row, a second stream writes a line of its own, a
 * wrapped path arrives with no columns at all. One such row would turn the shared prefix
 * into nothing and hand back the untouched output — which is exactly what happened, and
 * only showed up when a probe was pointed at a log that had one.
 *
 * Lines that do carry the head lose it. Lines that do not are left exactly as they are:
 * they are already the short ones, and cutting a prefix they never had could only take
 * away something they were saying.
 */
export function stripCommonPrefix(lines: string[]): string[] {
  const filled = lines.filter((l) => l.trim() !== "");
  if (filled.length < MIN_LINES_FOR_PREFIX) return lines;

  // How many lines open with each head. The winner has to be shared rather than merely
  // present, so a single padded line among plain ones changes nothing.
  const counts = new Map<string, number>();
  for (const line of filled) {
    const head = columnHead(line);
    if (head !== undefined) counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [head, count] of counts) {
    // Ties go to the longer head: two heads that both fit are nested, and the longer one
    // is the full set of columns rather than the first of them.
    if (count > bestCount || (count === bestCount && best !== undefined && head.length > best.length)) {
      best = head;
      bestCount = count;
    }
  }
  if (best === undefined || bestCount < Math.ceil(filled.length * PREFIX_SHARE)) return lines;

  const head = best;
  return lines.map((l) => (l.startsWith(head) ? l.slice(head.length) : l));
}

/** Drop a leading timestamp from each line. Applied per line, because these differ from
 *  line to line and so survive the shared-prefix rule above by design. */
export function stripTimestamps(lines: string[]): string[] {
  const hits = lines.filter((l) => LEADING_TIMESTAMP.test(l)).length;
  const filled = lines.filter((l) => l.trim() !== "").length;
  // Only when it is the shape of the output rather than one line that happens to open
  // with a date. Half is a low bar on purpose: interleaved logs are common and a
  // stamped line is no less stamped for sitting next to an unstamped one.
  if (filled === 0 || hits * 2 < filled) return lines;
  return lines.map((l) => l.replace(LEADING_TIMESTAMP, ""));
}

/** Both rules, in the order that lets the second one see what the first uncovered. */
export function condense(lines: string[]): string[] {
  return stripTimestamps(stripCommonPrefix(lines));
}

/**
 * Keep the last `max` lines, naming what was dropped.
 *
 * The notice goes ABOVE the kept lines, where it reads as "this is the end of something
 * longer". Below them it reads as more output, which is how the old middle-drop marker
 * ended up looking like a line the command had printed.
 */
export function tailCap(lines: string[], max: number): string[] {
  const limit = Math.max(1, max);
  if (lines.length <= limit) return lines;
  const hidden = lines.length - limit;
  return [`… ${hidden.toLocaleString("en-US")} earlier line${hidden === 1 ? "" : "s"} hidden`, ...lines.slice(-limit)];
}
