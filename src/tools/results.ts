/**
 * results.ts — the two ways a tool reports a failure.
 *
 * Both were copied into twenty-two tool files as identical private helpers, which meant
 * the second one could not be reached from most of them without copying it as well. They
 * live here once instead. Nothing about a failure's shape changed in the move.
 */
import type { ToolResult } from "./types.js";

/** A failure the user should see: a refusal, a missing file, a command that exited badly. */
export function fail(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message };
}

/**
 * A failure the model is expected to fix by itself, this turn.
 *
 * Identical to `fail` for the model — same error text, same `isError`, so nothing about
 * its recovery changes — but marked `quiet` so the UI does not paint a red row for what
 * is really a mid-thought correction. See `ToolResult.quiet` for where the line sits.
 */
export function failQuietly(message: string): ToolResult {
  return { output: `Error: ${message}`, isError: true, summary: message, quiet: true };
}
