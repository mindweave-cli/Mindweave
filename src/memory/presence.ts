/**
 * presence.ts — which files the model can actually still SEE (pure).
 *
 * The read ledger (`ToolContext.reads`) owns a FACT: "this file was read at this
 * mtime/size, and here are the regions the model focused on." That fact is what the
 * edit freshness gate needs, and it stays true no matter what happens to the
 * transcript.
 *
 * "The content of this file is currently visible to the model" is a different kind of
 * claim. It is not a fact about the past; it is a property of the bytes about to be
 * sent, and it changes every time the transcript changes. The moment it is STORED
 * next to the fact, every future transcript mutation has to remember to update it —
 * and the one that forgets ships a model reasoning about a file it can no longer see.
 *
 * So it is derived, never stored. `workingSetFull` already answers it for the volatile
 * working-set block (emitted by the same pass that renders those bytes). This module
 * answers it for the other half: a full `read_file` result still sitting unstubbed in
 * the transcript. Together they are the whole answer, and `read_file`'s two
 * short-circuits consult one each.
 *
 * See BOUNDARY.md, "Records, derivations, and standing knowledge".
 */
import type { Entry } from "./types.js";
import { fullPathsOf } from "./types.js";
import { CLEARED_STUB } from "./compaction.js";

/**
 * The set of absolute paths whose WHOLE content is still present in the transcript:
 * a `read_file` call with no `offset`/`limit`, whose result has not been cleared to a
 * stub by microcompaction.
 *
 * Pure. `resolve` turns the call's recorded (possibly relative or labelled) path into
 * the same absolute key the read ledger uses; it returns undefined for anything it
 * cannot resolve, which is simply left out.
 */
export function fullReadPaths(entries: Entry[], resolve: (path: string) => string | undefined): Set<string> {
  const callById = new Map<string, { name: string; arguments: string }>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) callById.set(tc.id, { name: tc.name, arguments: tc.arguments });
    }
  }

  const present = new Set<string>();
  for (const e of entries) {
    if (e.role !== "tool") continue;
    // A cleared body is a stub: the entry survives for navigation, the content does not.
    if (e.content.includes(CLEARED_STUB)) continue;

    // The tool recorded which file this result IS, at the moment it was true. Exact:
    // no re-resolution, so a `cd` since then cannot make it point somewhere else.
    const recorded = fullPathsOf(e);
    if (recorded.length > 0) {
      for (const path of recorded) present.add(path);
      continue;
    }

    // Fallback for sessions written before results carried that fact. Re-resolving the
    // arguments is a guess about where a relative path pointed at the time, so it is
    // used only when there is nothing better, never in preference to the recording.
    const call = callById.get(e.toolCallId ?? "");
    if (!call || call.name !== "read_file") continue;
    let args: { path?: unknown; offset?: unknown; limit?: unknown };
    try {
      args = JSON.parse(call.arguments) as typeof args;
    } catch {
      continue; // malformed args — nothing to claim
    }
    // A ranged read put only a window in the transcript, not the whole file.
    if (args.offset !== undefined || args.limit !== undefined) continue;
    if (typeof args.path !== "string") continue;
    const abs = resolve(args.path);
    if (abs) present.add(abs);
  }
  return present;
}
