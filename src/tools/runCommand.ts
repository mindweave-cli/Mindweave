/**
 * runCommand.ts — run a shell command in the project.
 *
 * This is Mindweave's hands on the system: build, test, git, scaffolding. The design
 * carries a few things that make a shell tool genuinely reliable:
 *
 *  - cwd PERSISTS across calls within a turn without a long-lived shell. We spawn a
 *    fresh shell per command, but the command is wrapped to write its final working
 *    directory to a temp file; we read that back into `ctx.cwd`, so a `cd src` in one
 *    call is still in effect for the next command in the same turn. The engine resets
 *    ctx.cwd to the project root at the start of each turn (see respond()), so a stale
 *    `cd` never carries across turns — the project root is the stable contract.
 *  - whole-tree kill on timeout. Killing the shell alone leaves grandchildren
 *    (node → jest, a dev server) holding the output pipe open so it looks hung
 *    forever — so we kill the entire process tree (`taskkill /T` on Windows,
 *    the process group on POSIX).
 *  - wall-clock timeout, 2 min default / 10 min max.
 *  - anti-hang environment: GIT_EDITOR=true and a hidden window stop an
 *    interactive editor or prompt from freezing the turn.
 *
 * The shell is PowerShell on Windows and bash elsewhere, falling back to `sh` only
 * on a machine that has no bash (see posixShell.ts — `/bin/sh` is `dash` on Debian
 * and Ubuntu, where ordinary bash syntax is a hard syntax error). The system prompt
 * names whichever it resolved to, so the model writes commands that will actually
 * run, and the label is computed rather than fixed so it cannot go stale. Deciding
 * WHAT to run is the model's job — this tool only executes it, with one
 * mechanical seatbelt (guard.ts) that refuses a handful of catastrophic,
 * irreversible commands.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { catastrophicCommandReason, sensitiveCommandReason } from "./guard.js";
import { forbiddenCommandReason, forbiddenCommandPatternReason } from "../governor/forbidden.js";
import { requestForbiddenLift } from "./approval.js";
import { posixShell, shellMismatchNote } from "./posixShell.js";
import { killTree, spawnManaged } from "./killTree.js";
import { captureAfterCommand, looksReadOnly, snapshotBeforeCommand } from "./shellCheckpoint.js";
import { canonicalRoot, relativize } from "./paths.js";
import { outputDetail, withOutcome } from "./detail.js";
import { powershellLintReason, powershellParseError, powershellReservedAssignmentReason } from "./shellLint.js";
import { findRunningDuplicate, guessNotifyPolicy, type NotifyPolicy } from "./backgroundShells.js";
import { fail, failQuietly } from "./results.js";

const IS_WINDOWS = process.platform === "win32";

/** Which shell to run in on Windows. Elsewhere everything is POSIX sh and this is
 *  ignored. PowerShell is the default; cmd is opt-in for cmd.exe-syntax commands. */
type Shell = "powershell" | "cmd";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
/**
 * How much command output reaches the model, split across the two ends.
 *
 * Keeping the FIRST 30,000 characters and dropping the rest throws away the part
 * that matters: a build or test run puts its banner and progress at the start and
 * its diagnosis — the failing assertion, the stack, "3 tests failed" — at the very
 * end. A verbose `tsc` or webpack run overflows the budget on progress noise alone,
 * so the model would receive a wall of chatter, a truncation notice, and nothing
 * about why the command failed.
 *
 * Both ends are kept instead, weighted toward the tail. The same total budget.
 */
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 22_000;
/** How long to wait after `exit` for `close` before settling anyway. See the listener
 *  in runShell: a surviving grandchild can hold the output pipe open forever. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Human label for the shell, kept in sync with the system prompt.
 *
 * Reports what will ACTUALLY run, resolved on this machine, rather than a fixed
 * string. It used to say "the POSIX shell (sh)" everywhere off Windows, which became
 * a false claim the moment bash was preferred — and a prompt that asserts something
 * untrue is worse than one that says nothing, because the model believes it and
 * writes to the wrong dialect.
 */
export function commandShellLabel(): string {
  if (IS_WINDOWS) return "Windows PowerShell";
  return posixShell().isBash ? "bash" : "a strict POSIX shell (sh)";
}

export const runCommand: Tool = {
  name: "run_command",
  readOnly: false,
  // Two claims in the previous version of this description were false, and both were
  // the kind a model obeys without being able to check. It promised that a backgrounded
  // command would report when it finished, which is true only for notify:'on_finish'
  // and flatly contradicted by 'on_failure' (the default for anything server-shaped).
  // And it warned that a never-terminating command would "hang the turn", which the
  // soft timeout has made untrue, while scaring the model away from the very feature
  // built for it. What replaced them is what actually happens.
  description:
    `Run a shell command in the project and return its combined output and exit ` +
    `code. The shell is ${commandShellLabel()}. Every turn starts at the project root; ` +
    `the working directory persists between calls WITHIN a turn (so 'cd' carries over ` +
    `mid-turn) but resets to the root next turn. ` +
    `A command still running after 2 minutes (or 'timeout' ms, up to 10 minutes) is ` +
    `MOVED TO THE BACKGROUND, not killed: you get a shell id and the session carries on. ` +
    `Read its output any time with the shells tool. WHAT YOU HEAR AFTERWARDS IS SET BY ` +
    `'notify', so choose it deliberately: only 'on_finish' reports that the command ` +
    `ended, and it is not the default for everything. ` +
    `Pass 'run_in_background: true' to background it from the start, and do that for a ` +
    `dev server, a long build or test you do not need to wait on, and anything ` +
    `interactive or never-terminating. Waiting on one of those inline will not hang the ` +
    `turn, but it burns the whole timeout before backgrounding itself, which is time ` +
    `spent for nothing. ` +
    `Write commands for ${commandShellLabel()} (see the shell section of the system prompt)` +
    `${IS_WINDOWS ? "; or pass shell:'cmd' to run in cmd.exe instead (for && / || chaining or cmd-only tools)" : ""}. ` +
    `Prefer Mindweave's read/edit/search tools over shelling out.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      shell: {
        type: "string",
        enum: ["powershell", "cmd"],
        description:
          "Windows only (ignored elsewhere): which shell to run in. Default 'powershell'. Choose " +
          "'cmd' for commands written in cmd.exe syntax — && / || chaining, or a tool that misbehaves " +
          "under PowerShell — Mindweave runs them as a batch script. Note: in cmd a for-loop uses %%i, and " +
          "cwd may not carry over when the command itself is a .cmd tool (chain in one call instead).",
      },
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        description: `How long to wait inline before moving it to the background, in ms (default 120000, max ${MAX_TIMEOUT_MS}).`,
      },
      run_in_background: {
        type: "boolean",
        description: "Start it in the background immediately and return a shell id (don't wait).",
      },
      notify: {
        type: "string",
        enum: ["on_finish", "on_failure", "never"],
        description:
          "What you want to be told about a backgrounded command. 'on_finish' (default for tasks): " +
          "you're told when it ends, whatever the result — use it for builds, tests, installs, " +
          "anything whose RESULT is the point. 'on_failure': you're told when it has come up, and if " +
          "it never does, but NOT when it stops — use it for dev servers and apps, because the user " +
          "closing their own app is not something to act on. 'never': you're told nothing at all. " +
          "Say which; guessing from the command name gets it wrong for anything unusual.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return failQuietly("`command` is required.");

    // A shell can change files in ways the checkpoint net never sees (a formatter, a
    // codegen step, a `git checkout`). Flag the turn so /undo says what it did NOT
    // cover instead of implying the whole turn was rolled back.
    ctx.checkpoints?.noteShell();

    const blocked = catastrophicCommandReason(command);
    if (blocked) {
      return fail(`Refusing to run this command: it looks like ${blocked}.`);
    }
    // A shell would sidestep every per-file gate the read/write tools enforce.
    const sensitive = sensitiveCommandReason(command);
    if (sensitive) {
      return fail(
        `Refusing to run this command: it would print the contents of ${sensitive} into ` +
          `the conversation. Checking whether the file exists, listing it, or copying it ` +
          `is fine — reading it out is not. If you genuinely need what's inside, use ` +
          `read_file, which asks the user first.`,
      );
    }
    const forbidden = forbiddenCommandReason(ctx.governance?.forbidden, command);
    if (forbidden) {
      const lift = await requestForbiddenLift(
        ctx,
        forbidden,
        "this command",
        `it references '${forbidden}', which the user has forbidden touching.`,
      );
      if (lift) return lift; // refused or deferred; an allow lifts it and falls through
    }
    // Forbidden COMMAND patterns: a command the user said never to run (e.g. `tauri
    // dev`). Deterministic — the model cannot bypass it; only the user can lift it
    // (same approval channel as forbidden paths, session-only).
    const forbiddenCmd = forbiddenCommandPatternReason(ctx.governance?.forbidden, command);
    if (forbiddenCmd) {
      const lift = await requestForbiddenLift(
        ctx,
        forbiddenCmd,
        "this command",
        `the user has forbidden running '${forbiddenCmd}'.`,
        "forbidden command",
      );
      if (lift) return lift;
    }

    let timeout = DEFAULT_TIMEOUT_MS;
    if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
      timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout)));
    }

    const shell: Shell = args.shell === "cmd" ? "cmd" : "powershell";

    // Already-running guard: don't start a second copy of something already running in
    // the background. Two dev servers collide on a port and the model then burns a long
    // loop fighting the conflict it created; two of anything else is nearly always a
    // mistake too.
    //
    // This deliberately does NOT ask whether the command looks like a server. It used to,
    // which meant the guard only covered the names in one regex: `cargo run`,
    // `docker compose up`, `flask run` and a plain path to a binary were all unprotected.
    // "Is this exact command already running" needs no such guess and covers everything.
    if (ctx.backgroundShells) {
      const dup = findRunningDuplicate(ctx.backgroundShells.running(), command);
      if (dup) {
        return {
          output:
            `\`${clip(command)}\` is already running in the background as shell #${dup.id}, so I'm not ` +
            `starting a second copy — a second one would collide with it. It's already up; if you want a ` +
            `fresh start, call kill_shell(${dup.id}) first, then relaunch.`,
          isError: true,
          summary: `already running as shell #${dup.id}`,
        };
      }
    }

    // Pre-execution gate: don't waste a run on a guaranteed PowerShell parse error
    // (`&&`/`||`) or an assignment to a read-only automatic variable (`$pid = …`). Catch
    // it here and hand back the fix so the model corrects in one step instead of running,
    // failing, and re-reading the error (the wall that spawned a long flailing loop).
    if (IS_WINDOWS && shell === "powershell") {
      const parseError = powershellParseError(command);
      if (parseError) return fail(parseError);
      const reserved = powershellReservedAssignmentReason(command);
      if (reserved) return fail(reserved);
    }

    const declared =
      args.notify === "on_finish" || args.notify === "on_failure" || args.notify === "never"
        ? (args.notify as NotifyPolicy)
        : undefined;

    // Bring shell-caused changes into /undo. Snapshot the read ledger first, run, then
    // check in whatever moved — this is the one mutation path that had no checkpoint at
    // all, which mattered precisely because improvising with a script is a capability we
    // rely on. Skipped for obviously read-only commands, and for background ones, whose
    // writes land long after this call has returned. See shellCheckpoint.ts for the
    // bounds and for what is honestly NOT covered.
    const background = args.run_in_background === true;
    const watch = !background && !looksReadOnly(command);
    const before = watch ? await snapshotBeforeCommand(ctx) : undefined;

    const result = await runShell(command, ctx, timeout, background, shell, declared);

    if (before && before.size > 0) {
      // Never let bookkeeping fail a command that already ran and succeeded.
      await captureAfterCommand(ctx, before).catch(() => undefined);
    }
    return result;
  },
};

async function runShell(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
  background: boolean,
  shell: Shell,
  declaredNotify?: NotifyPolicy,
): Promise<ToolResult> {
  // A unique temp file the wrapped command writes its final cwd into.
  const cwdFile = join(tmpdir(), `mindweave-cwd-${randomBytes(6).toString("hex")}.txt`);
  // Where we stood before the command ran — applyCwd may move ctx.cwd, and the model
  // needs telling when it does (see cwdChangeNote). CANONICALISED, because that
  // comparison is a string equality and the two sides otherwise come from different
  // places: this one from the session, the other from whatever form the shell prints.
  // On Windows those differ for any user whose name is over eight characters, since
  // one side carries the 8.3 short form, and the session then reports a move on every
  // command that never left the directory.
  const cwdBefore = await canonicalRoot(ctx.cwd);

  const { bin, args, wrapped, tempFile } = buildInvocation(command, cwdFile, shell);
  const child = spawnManaged(bin, [...args, wrapped], {
    cwd: ctx.cwd,
    env: {
      ...process.env,
      GIT_EDITOR: "true", // never drop into an interactive editor and hang
      GIT_PAGER: "cat",
      PAGER: "cat",
    },
  });

  const mgr = ctx.backgroundShells;

  // Explicit background: hand off immediately, don't wait for it.
  //
  // The abort listener below is only wired for the FOREGROUND path, so this branch
  // has to check the signal itself. Without it an interrupted turn still adopts the
  // process, and because backgrounding deliberately outlives the turn, Esc would
  // leave a dev server running that the user believed they had cancelled.
  if (background && mgr) {
    if (ctx.abortSignal?.aborted) {
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      return {
        output: "Command interrupted before it started.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      };
    }
    // Declared policy wins; the name guess is only the default when nothing was said.
    const notify = declaredNotify ?? guessNotifyPolicy(command);
    const info = mgr.adopt(child, { command, cwd: ctx.cwd, cwdFile, tempFile, notify });
    return backgroundedResult(info.id, command, `Started in the background as shell #${info.id}`, notify);
  }

  return new Promise<ToolResult>((resolve) => {
    let head = "";
    let tail = "";
    let dropped = 0;
    let timedOut = false;
    let settled = false;

    // Decode ACROSS chunks. A chunk boundary can fall inside a multi-byte UTF-8
    // sequence, and decoding each Buffer on its own turns that character into a
    // replacement glyph — which shows up in any non-English output and in the box
    // drawing most test runners use. The decoder holds the partial bytes back until
    // the rest arrives.
    const decoder = new StringDecoder("utf8");

    const collect = (chunk: Buffer) => {
      let rest = decoder.write(chunk);
      if (!rest) return;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += rest.slice(0, room);
        rest = rest.slice(room);
      }
      if (!rest) return;
      tail += rest;
      if (tail.length > TAIL_CHARS) {
        dropped += tail.length - TAIL_CHARS;
        tail = tail.slice(tail.length - TAIL_CHARS);
      }
    };
    /** Everything kept, with the gap named where it happened. */
    const collected = () => composeOutput(head, tail, dropped);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      if (settled) return;
      // Soft timeout: move the LIVE process to the background (preferred), so a long
      // test/build keeps running instead of being lost. With no manager (bare tests)
      // fall back to the old behavior — kill the tree.
      if (mgr) {
        settled = true;
        detachAbort();
        child.stdout?.off("data", collect);
        child.stderr?.off("data", collect);
        // Auto-backgrounded after running too long inline. Somebody was waiting on this,
        // so its completion is the point unless the caller said otherwise.
        const notify = declaredNotify ?? "on_finish";
        const info = mgr.adopt(child, { command, cwd: ctx.cwd, initial: collected(), cwdFile, tempFile, notify });
        resolve(
          backgroundedResult(
            info.id,
            command,
            `Still running after ${Math.round(timeoutMs / 1000)}s — moved to the background as shell #${info.id}`,
            notify,
          ),
        );
      } else {
        timedOut = true;
        killTree(child.pid);
      }
    }, timeoutMs);

    // Esc / interrupt: if the turn is aborted while this command is still running,
    // kill the whole process tree and settle immediately. Without this a hung command
    // (an installer waiting on a GUI, an interactive prompt) freezes the agent — the
    // engine only re-checks the abort signal BETWEEN steps, never mid-tool-call, so it
    // would stay blocked on this promise forever.
    const signal = ctx.abortSignal;
    const detachAbort = () => signal?.removeEventListener("abort", onAbort);
    function onAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", collect);
      child.stderr?.off("data", collect);
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      const body = collected().trim();
      resolve({
        output: body ? `${body}\n\n[interrupted]` : "Command interrupted before it finished.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      });
    }
    if (signal?.aborted) return void onAbort();
    signal?.addEventListener("abort", onAbort);

    const finish = async (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      await applyCwd(cwdFile, ctx);
      if (tempFile) await fs.rm(tempFile, { force: true }).catch(() => {});
      resolve(format(command, ctx, collected(), dropped > 0, timedOut, exitCode, signal, timeoutMs, shell, cwdBefore, child.pid));
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      resolve(fail(`could not start the command: ${error.message}`));
    });
    child.on("close", (code, signal) => void finish(code, signal));
    // `close` waits for every stdio stream to close, which a surviving grandchild (a
    // daemon the command started, inheriting stdout) holds open indefinitely. Without a
    // fallback the call sits here until the timeout and only then gets backgrounded, so a
    // command that merely starts something looks like it took two minutes. `exit` fires
    // when the process itself goes; the short grace lets `close` win normally, so no
    // ordinary command pays for this.
    child.on("exit", (code, signal) => {
      const grace = setTimeout(() => void finish(code, signal), CLOSE_GRACE_MS);
      grace.unref?.();
    });
  });
}

/**
 * The result returned when a command is (or becomes) a background shell.
 *
 * The text has to match what will ACTUALLY happen, and that differs by what was
 * started. A finite task notifies on completion, so telling the model to promise a
 * report is correct. A server or app does NOT: its stop is suppressed on purpose,
 * because a user closing their own app is not something to act on. Telling the model
 * it would be notified either way made it promise a report that never came, which is
 * the prompt asserting a capability that does not exist.
 */
function backgroundedResult(id: number, command: string, lead: string, notify: NotifyPolicy): ToolResult {
  const tail =
    notify === "never"
      ? `Nothing further will be reported about it. Say in ONE short line that it's running, then STOP ` +
        `(end your turn). Use shells({id: ${id}}) to inspect it and kill_shell(${id}) to stop it.`
      : notify === "on_failure"
        ? `You WILL be told once it has come up, so you can report that. You will NOT be told when it ` +
          `stops, because the user closing their own app is not an event to act on — so never restart ` +
          `it on your own. Say in ONE short line that it's starting, then STOP (end your turn). Use ` +
          `shells({id: ${id}}) to inspect it and kill_shell(${id}) to stop it.`
        : `You will be notified AUTOMATICALLY the moment it finishes, so do NOT poll it. Say in ONE ` +
          `short line that it started and that you'll report back when it's done, then STOP (end your ` +
          `turn). Only call shells({id: ${id}}) if you have a specific reason to inspect partial ` +
          `output; use kill_shell(${id}) to stop it.`;
  return {
    output: `${lead}. ${tail}`,
    summary: `bg shell #${id}: ${clip(command)}`,
    // UI-only, never sent to the model (`tail` above already told IT the real
    // notification policy) — just the command itself and which shell it landed
    // in, the same "$ command" convention run_command's own foreground detail
    // uses. Previously absent entirely, so a backgrounded command's row showed
    // nothing under it at all.
    detail: outputDetail(`$ ${command}\nBackgrounded as shell #${id}`),
    detailKind: "shell" as const,
  };
}

/** Build the shell invocation: which binary, its flags, and the wrapped command. */
function buildInvocation(
  command: string,
  cwdFile: string,
  shell: Shell,
): { bin: string; args: string[]; wrapped: string; tempFile?: string } {
  if (IS_WINDOWS && shell === "cmd") {
    // cmd.exe can't run a multi-line /c string (it executes only the first line), so
    // we materialize a tiny .bat: the command, then capture its exit code and final
    // cwd. Run line-by-line, so `cd` persists and `&&`/`||` chains work natively.
    // ComSpec is the reliable path to cmd.exe (a bare name may not resolve).
    const batFile = join(tmpdir(), `mindweave-run-${randomBytes(6).toString("hex")}.bat`);
    const script =
      `@echo off\r\n` +
      `${command}\r\n` +
      `set __ec=%ERRORLEVEL%\r\n` +
      `cd > "${cwdFile}"\r\n` +
      `exit /b %__ec%`;
    writeFileSync(batFile, script, "utf8");
    return {
      bin: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c"],
      wrapped: batFile,
      tempFile: batFile,
    };
  }
  if (IS_WINDOWS) {
    // After the command, record the final location and preserve its exit code.
    //
    // `$?` has to be captured on the very FIRST line after the command, because every
    // statement sets it — including an assignment, which always succeeds. Read it
    // second and you are reading whether `$__ec = …` worked, which is always true.
    //
    // Both signals are needed because they cover different halves of PowerShell.
    // `$LASTEXITCODE` is set ONLY by native executables, so a failing cmdlet
    // (`Get-Content` on a missing file, a failed `Remove-Item` — most of what a model
    // writes) leaves it null, which used to be coerced to 0 and reported to the model
    // as SUCCESS. `$?` catches those. It is not enough on its own either: it says
    // whether something failed, never with which code, and `exit 3` from a real
    // program has to survive as 3. So: take the native code when there is one, and
    // otherwise promote a cmdlet failure to 1.
    const wrapped =
      `${command}\n` +
      `$__ok = $?\n` +
      `$__ec = $LASTEXITCODE; if ($null -eq $__ec) { $__ec = 0 }\n` +
      `if (-not $__ok -and $__ec -eq 0) { $__ec = 1 }\n` +
      `$PWD.Path | Out-File -FilePath ${psQuote(cwdFile)} -Encoding utf8\n` +
      `exit $__ec`;
    return {
      bin: "powershell.exe",
      // -ExecutionPolicy Bypass (process-scoped only) so the model can actually run
      // npm/npx/tsc/jest — their Windows shims are .ps1 scripts, which a Restricted
      // execution policy blocks ("npm.ps1 cannot be loaded because running scripts is
      // disabled"). Without this the verify/test/build story silently can't run.
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      wrapped,
    };
  }
  // Prefer bash. `/bin/sh` is `dash` on Debian/Ubuntu, where ordinary bash syntax a
  // model writes — `[[ ]]`, `source`, arrays — is a hard syntax error. See posixShell.
  //
  // `pwd -P` reports the PHYSICAL path, with symlinks resolved. That is deliberate and
  // it is why `canonicalRoot` exists: macOS puts /tmp and the whole of os.tmpdir()
  // behind symlinks (/tmp → /private/tmp), so a logical path and a physical one for the
  // same directory differ constantly. Recording the physical form on both sides is what
  // keeps them comparable; recording one of each is what silently moved a session off
  // its own root.
  const wrapped =
    `${command}\n` +
    `__ec=$?\n` +
    `pwd -P > ${shQuote(cwdFile)} 2>/dev/null\n` +
    `exit $__ec`;
  return { bin: posixShell().bin, args: ["-c"], wrapped };
}

/**
 * Join the kept head and tail of a long output, naming the gap (pure).
 *
 * The marker sits WHERE the loss happened rather than at the end, so the model can
 * see that the two halves are not contiguous. A trailing "output truncated" note
 * after a head-only excerpt reads as "there was a bit more", which is exactly the
 * wrong impression when the missing part is the answer.
 */
export function composeOutput(head: string, tail: string, dropped: number): string {
  if (dropped <= 0) return head + tail;
  return `${head}\n… [${dropped.toLocaleString("en-US")} characters omitted from the middle] …\n${tail}`;
}

/**
 * The line appended to a command's output when it moved the shell (pure).
 *
 * `cd` persisting across calls within a turn is a real convenience, but it is also
 * invisible: the model composes the next command's relative paths from the project
 * root, because nothing ever told it the floor moved. That produces a doubled path
 * (`code-blue/backend/code-blue/backend/manage.py`), which fails, and looks to the
 * model like the file is missing rather than like it is standing somewhere else.
 *
 * So we say it, once, exactly when it happens. `shown` is the new location relative
 * to the project root — the same form paths are addressed in everywhere else.
 * Returns null when the command did not move, which is nearly every command, so
 * ordinary output is untouched.
 */
export function cwdChangeNote(before: string, after: string, shown: string): string | null {
  if (before === after) return null;
  const where = shown === "." ? "the project root" : shown;
  return (
    `[Working directory is now ${where}. It stays there for the rest of this turn, so ` +
    `relative paths in your next command resolve from ${where}, not from the project root.]`
  );
}

/** Read the cwd the command ended in and adopt it (if it still exists). */
async function applyCwd(cwdFile: string, ctx: ToolContext): Promise<void> {
  try {
    const text = (await fs.readFile(cwdFile, "utf8")).trim();
    if (text) {
      // Confirm it's a real directory before adopting — a half-written file or a
      // deleted dir must not strand the session somewhere invalid.
      const stat = await fs.stat(text);
      // Canonicalise on the way in, so the session only ever holds ONE form of a
      // path. The shell prints whatever form it was handed; adopting that verbatim is
      // how a session ends up describing one directory two ways.
      if (stat.isDirectory()) ctx.cwd = await canonicalRoot(text);
    }
  } catch {
    // No file / unreadable → command didn't change dir (or failed early); keep cwd.
  } finally {
    await fs.rm(cwdFile, { force: true }).catch(() => {});
  }
}

function format(
  command: string,
  ctx: ToolContext,
  output: string,
  truncated: boolean,
  timedOut: boolean,
  exitCode: number | null,
  signal: string | null,
  timeoutMs: number,
  shell: Shell,
  cwdBefore: string,
  /** The killed process, named only when something WAS killed (see withOutcome). */
  pid?: number,
): ToolResult {
  const body = output.trim();
  const parts: string[] = [];

  if (timedOut) {
    parts.push(
      `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. ` +
        `If it was a long-running or watching process, run a form that terminates.`,
    );
  } else if (signal) {
    // A process ended by a signal reports no exit code at all. Treating that as "not
    // non-zero" made a killed command read as a success, and the summary said
    // "exit null" — so a command someone stopped looked like a command that worked.
    parts.push(`Command was terminated by ${signal} before it finished.`);
  } else if (exitCode !== 0 && exitCode !== null) {
    parts.push(`Command exited with code ${exitCode}.`);
  }

  if (body) {
    parts.push(body);
    // The gap is already marked inline, at the point it happened; this only names
    // the shape of what arrived so the model doesn't read the two halves as one run.
    if (truncated) parts.push("(long output: the start and the end are shown, the middle was dropped)");
  } else if (!timedOut) {
    parts.push("(no output)");
  }

  // In PowerShell, nudge the model when it wrote a bash-ism that breaks there
  // (advisory only — never blocks; the linter is conservative). Not for cmd, which
  // supports && / || natively.
  if (IS_WINDOWS && shell === "powershell") {
    const lint = powershellLintReason(command);
    if (lint) parts.push(lint);
  }
  // The POSIX mirror of the same idea. Silent on any machine that has bash (nearly
  // all of them), because there the mismatch cannot arise — it only speaks up on a
  // minimal box where the command genuinely could not have parsed, and then it names
  // the construct rather than leaving a bare `dash: syntax error` to be decoded.
  if (!IS_WINDOWS) {
    const mismatch = shellMismatchNote(command);
    if (mismatch) parts.push(mismatch);
  }

  const shown = relativize(ctx, ctx.cwd);
  // Did this command move the shell? If so the model must hear it here, in the tool
  // OUTPUT — the summary line below is display-only and never reaches the model.
  const moved = cwdChangeNote(cwdBefore, ctx.cwd, shown);
  if (moved) parts.push(moved);
  const status = timedOut ? "timed out" : signal ? `killed (${signal})` : exitCode === 0 ? "ok" : `exit ${exitCode}`;
  return {
    output: parts.join("\n"),
    isError: timedOut || signal !== null || (exitCode !== 0 && exitCode !== null),
    summary: `ran \`${clip(command)}\` in ${shown} (${status})`,
    // The outcome is appended to what is SHOWN, not just to what the model reads. A
    // command that printed output previously ended its row with the last line of that
    // output and nothing else, so a build that failed and a build that passed looked
    // identical unless you recognised the text — the exit code was known here and
    // simply never displayed.
    // The command leads its own block on its own row. Inline in the header it was
    // clipped to 48 characters, which for a real command line lost the half that said
    // what it actually did (`Run(mkdir -p ..\astra-backup; Move-Item .\astra.htm…)`).
    detail: withOutcome(shellBody(command, body), timedOut, exitCode, signal, timeoutMs, pid),
    detailKind: "shell" as const,
  };
}

/** The `$ command` header row above a command's captured output. */
function shellBody(command: string, body: string): string {
  const out = outputDetail(body);
  return out ? `$ ${command}\n${out}` : `$ ${command}`;
}

/** Single-quote a string for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** Single-quote a string for PowerShell (double any embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.split("'").join("''")}'`;
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

