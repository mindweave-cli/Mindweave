/**
 * pathList.ts — the files one tool call asked for.
 *
 * Its own module because TWO things need the answer and they must not disagree: the
 * tool that reads the files, and the row that says which files are being read.
 *
 * They did disagree. The tool accepts the list under `paths` or the older singular
 * `path`, as a list or as a bare string — deliberately, because a resumed session
 * replays calls the model made under the previous schema, and refusing those would turn
 * every restore into a wall of errors. The display accepted a narrower set. So a call
 * that passed four files under `path` read all four and rendered as `Reading 1 file`
 * with no filenames: the header contradicting its own result, and the one line that
 * would have said WHICH files simply absent.
 *
 * A lenient reader and a strict display is a bug waiting to happen every time either
 * side moves. One function, both callers.
 */

/**
 * Every path in `args`, in order, however the call happened to spell it (pure).
 *
 * Empty and whitespace-only entries are dropped: they are not files, and a blank
 * name in a row is indistinguishable from a rendering fault.
 */
export function toPathList(args: Record<string, unknown>): string[] {
  const raw = args["paths"] ?? args["path"];
  if (typeof raw === "string") return raw.trim() ? [raw] : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}
