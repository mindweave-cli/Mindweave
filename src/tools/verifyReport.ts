/**
 * verifyReport.ts — the contract a verification worker answers under.
 *
 * A normal worker reports on ITSELF: `STATUS: complete` means "I did what you asked".
 * A verifier has to report on something else — the code — and those two are genuinely
 * different claims. A verifier can do its job perfectly and still have to say the work is
 * broken, which under the worker contract would be a "complete" report carrying a failure,
 * or worse, a "failed" report implying the verifier malfunctioned. So verification gets
 * its own word, `VERDICT`, and its own parser.
 *
 * THE PROBLEM THIS WHOLE FILE EXISTS FOR: a model asked to verify will, under load,
 * read the code, narrate the checks it would run, and write PASS. That is not a rare
 * failure — it is the default one, and no amount of asking nicely fixes it. So the
 * contract is mechanical instead: a PASS must carry command output, `evidenceCount`
 * counts it, and `parseVerdict` DOWNGRADES a PASS that carries none. The model cannot
 * talk its way past a function that counts.
 */

/** What the verifier concluded about the CODE, not about its own run. */
export type Verdict = "pass" | "fail" | "partial" | "unstated";

export interface VerdictReport {
  verdict: Verdict;
  /** The report with the verdict line removed — protocol stripped from content. */
  body: string;
  /** How many checks carried real command output. */
  evidence: number;
  /** True when a claimed PASS arrived with no evidence and was downgraded. */
  downgraded: boolean;
  /** Things the caller must not read past. Empty when the report is clean. */
  concerns: string[];
}

/**
 * The verifier's own instructions, appended to its system prompt.
 *
 * Deliberately about the MODEL's failure modes rather than about testing technique. The
 * strategy half of this ("start the server, hit the endpoint") is engineering judgment the
 * model already has and the thin-prompt boundary says we do not teach. What it does NOT
 * reliably have is resistance to its own urge to skip the check — so that is what this
 * spends its words on, named specifically enough to be recognised in the moment.
 */
export const VERIFIER_PROMPT = `You are verifying someone else's work. Your job is not to confirm it works — it is to try to break it.

You have two failure modes, and naming them is the point:

1. VERIFICATION AVOIDANCE. Faced with a check, you find reasons not to run it: you read the code, describe what you would test, write "PASS", and move on. Reading is not verification. If you catch yourself writing an explanation where a command should be, stop and run the command.
2. THE FIRST 80%. A screen that renders and a green test suite feel like success. They are the easy part. The value is entirely in the last 20% — the button that does nothing, the state that vanishes on reload, the input that crashes it. Go looking for that.

These are the exact sentences you will reach for. Each one is wrong:
- "The code looks correct based on my reading" — run it.
- "The existing tests already pass" — those were written by the same kind of model that wrote the code. Check independently.
- "This is probably fine" — probably is not verified.
- "I don't have the tools for this" — check what you actually have before deciding that.

YOU CANNOT MODIFY ANYTHING. Your edit and write tools are removed, not discouraged — this is enforced, so do not plan around it. Read, search, and run commands. A scratch file under the system temp directory is fine; the project is not.

WHAT TO DO. Run the build. Run the tests, including the full suite when the change is broad enough to warrant it. Run the typechecker and any linter. Then — and this is the part that matters — exercise the change itself: call the function, hit the endpoint, run the command, drive the UI. Finally, try to break it: boundary values, empty and malformed input, the same operation twice, an id that does not exist.

Test results are context, not evidence. Note them and move on to checking the thing itself.

EVERY CHECK IS REPORTED LIKE THIS:

### Check: <what you are verifying>
$ <the exact command you ran>
<the real output, pasted — trimmed if long, but never paraphrased>
=> PASS   (or FAIL, with what you expected and what you got)

A check with no command and no output is not a PASS, it is a skip, and it is counted as one. At least one of your checks must be an attempt to BREAK the code, and you must report what happened even if it held up correctly.

BEFORE YOU REPORT FAIL, rule out three things: something upstream already handles it; a comment or the project's own notes say it is deliberate; or it is a real limit that cannot be fixed without breaking something external. Any of those makes it an observation, not a failure. Do not use them to wave away a real bug either.

END WITH EXACTLY ONE LINE, nothing after it:
VERDICT: pass
VERDICT: fail
VERDICT: partial

\`partial\` is ONLY for something that stopped you — a tool you do not have, a server that will not start, no test framework. It is not for "I am unsure whether this is a bug". If you were able to run the check, decide.`;

/** The line the verifier must end on, restated at the end of the task where it is closest
 *  to the work. The system prompt says it once; a long run buries a single mention. */
export const VERDICT_INSTRUCTION =
  "End your reply with a final line of exactly `VERDICT: pass`, `VERDICT: fail`, or `VERDICT: partial` — " +
  "pass only if you RAN checks that prove it works, fail if something is broken, partial only if " +
  "something prevented you from checking at all. Every check you claim must show the command you ran " +
  "and the output you got back.";

/**
 * Same leniency as the worker status line, for the same reason: asked for a bare line,
 * models reliably produce `**VERDICT: pass**` or `> VERDICT: PASS.` and a verdict that
 * fails to parse reads as "never reached a conclusion", which would flag every
 * well-behaved verifier and train the caller to ignore the flag.
 */
const VERDICT_LINE = /^[ \t>*_#-]*VERDICT[:\s]+\s*(pass|fail|partial)[ \t*_.!]*$/im;

/**
 * Count the checks that actually show their working (pure).
 *
 * Two shapes are accepted because the prompt asks for one and models drift to the other:
 * a `$ command` line, and a fenced block introduced by "Command run". Both require the
 * OUTPUT to follow, which is the half that cannot be produced without running anything.
 */
export function evidenceCount(text: string): number {
  let count = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isCommand = /^\s*\$\s+\S/.test(line) || /^\s*\*{0,2}Command run/i.test(line);
    if (!isCommand) continue;
    // A command with nothing after it is a command someone typed into a report, not one
    // they ran. Something non-empty has to follow before the next check heading.
    const next = lines.slice(i + 1, i + 6).find((l) => l.trim() && !/^\s*\$\s+\S/.test(l));
    if (next && !/^#{1,6}\s/.test(next)) count += 1;
  }
  return count;
}

/**
 * Read the verifier's conclusion, and refuse to take an unevidenced PASS at face value.
 *
 * The downgrade is the whole mechanism. A model that skipped the work and wrote `pass`
 * produces a report with no command output in it, and that is a property of the text that
 * a function can check — unlike sincerity, which is not. `fail` and `partial` are NOT
 * downgraded: claiming something is broken, or that you were blocked, is not a claim that
 * benefits the claimer, so there is no incentive to fake it and no reason to second-guess.
 */
export function parseVerdict(reply: string): VerdictReport {
  const text = (reply ?? "").trim();
  const match = VERDICT_LINE.exec(text);
  const stated = (match?.[1]?.toLowerCase() ?? "unstated") as Verdict;
  const body = match ? text.replace(VERDICT_LINE, "").trim() : text;
  const evidence = evidenceCount(body);
  const concerns: string[] = [];

  let verdict = stated;
  let downgraded = false;
  if (stated === "pass" && evidence === 0) {
    verdict = "partial";
    downgraded = true;
    concerns.push("claimed pass without showing a single command and its output — treat as unverified, not as working");
  }
  if (stated === "unstated") {
    concerns.push("never stated a verdict");
  }
  if (stated === "pass" && evidence === 1) {
    // Not downgraded — one real check is a real check — but a single one is rarely the
    // adversarial probe the contract asks for as well as the happy path.
    concerns.push("only one check carried evidence; nothing here looks like an attempt to break it");
  }
  return { verdict, body, evidence, downgraded, concerns };
}

/** One line for the transcript. The caller gets the body; the user gets this. */
export function renderVerdict(report: VerdictReport): string {
  const label =
    report.verdict === "pass"
      ? "verified"
      : report.verdict === "fail"
        ? "FAILED verification"
        : report.verdict === "partial"
          ? "could not fully verify"
          : "no verdict";
  const checks = report.evidence === 1 ? "1 check" : `${report.evidence} checks`;
  return `${label} · ${checks}`;
}
