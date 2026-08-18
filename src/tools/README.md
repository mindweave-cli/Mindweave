# tools/ — what the engine can do

The agent's hands: read files, write/edit files, run commands, search, etc.

Each real tool lives in its own file (e.g. `read-file.ts`, `run-command.ts`)
so they stay easy to find and reason about. Trivial helpers can share a file —
we separate where it earns its keep, not file-per-line.

Tools always execute locally on the user's machine, even after the dynamo moves
to a server.

## Shape

Every tool implements the `Tool` interface in `types.ts`: a `name`, a
`description`, a JSON-Schema `parameters` object, a `readOnly` flag, and an
`execute(args, ctx)` that returns `{ output, isError?, summary? }`. `output` is
what the model sees; `summary` is a one-line label for the live UI.

`ctx` is the shared per-session `ToolContext` (created in `session.ts`, owned by
the CLI for the whole conversation): `cwd` (the working directory, which
`run_command` advances on `cd`) and `reads` (a map of every file read/written and
its state). `reads` does double duty — it's the read-before-edit gate *and* lets
`read_file` skip re-sending a file that hasn't changed. Because `ctx` persists
across turns, a `cd` or a read in one turn is still in effect in the next.

`registry.ts` is the single list of available tools — add a tool by writing its
file and listing it there. The engine reads from the registry and nowhere else.

Read-only tools run in parallel; mutating tools run one at a time (the engine
splits them on the `readOnly` flag).

## Shared helpers

- `paths.ts` — resolve a model path against `ctx.cwd`; relativize for display.
- `guard.ts` — mechanical safety floor: refuse protected paths (`.env`, keys,
  `.git`) and a few catastrophic, irreversible commands. No model judgment.
- `walk.ts` — dependency-free recursive walk + glob→RegExp, shared by glob/grep.

## Tools

Read-only:

- `list_dir` (`listDir.ts`) — one level of a directory; dirs marked with `/`.
- `glob` (`glob.ts`) — find files by name pattern (`**/*.ts`).
- `grep` (`grep.ts`) — regex search of file contents (`content` /
  `files_with_matches` / `count`).

  Both run **ripgrep** when it's installed (the precise, fast, `.gitignore`-aware
  scanner — see `ripgrep.ts`, forces `/` separators) and fall back to the
  pure-Node `walk.ts` when `rg` isn't found, so search always works. Override the
  binary with `MINDWEAVE_RIPGREP_PATH`.
- `read_file` (`readFile.ts`) — read a text file with line numbers. Reads up to
  `MAX_LINES` (default 2000, env `MINDWEAVE_READ_MAX_LINES`) by default and the model
  pages with `offset`; a re-read of an unchanged file is deduped to a stub. Caps
  are fixed/model-agnostic, not tied to any model's context window.

Mutating:

- `write_file` (`writeFile.ts`) — create a file, or overwrite one already read.
- `edit` (`edit.ts`) — `old_string`→`new_string` replacements in one file, one or
  many per call, gated by read-before-edit, must-exist, and unique-match. Was two
  tools (`edit_file`/`multi_edit`) until the shape the model had to choose between
  turned out to be the only difference between them.
- `run_command` (`runCommand.ts`) — run a shell command (PowerShell on Windows,
  POSIX `sh` elsewhere). cwd persists across calls; whole process tree is killed
  on timeout (2 min default, 10 min max).

Tool behaviour is covered by `tools.test.ts` (`npm test`).
