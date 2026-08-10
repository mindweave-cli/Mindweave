<h1 align="center">Mindweave</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent.<br>
  You bring your own key. It runs on your machine. Nothing goes anywhere else.
</p>

<p align="center">
  <a href="https://github.com/mindweave-cli/Mindweave/blob/main/LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="CHANGELOG.md">Changelog</a> &nbsp;•&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a> &nbsp;•&nbsp;
  <a href="https://github.com/mindweave-cli/Mindweave/stargazers">Stars</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X</a>
</p>

---

## What it is

Mindweave is a coding agent that lives in your terminal and works inside your
repository: reading, searching, editing, running commands, and checking its own work.

It runs **entirely on your machine**. There is no backend, no telemetry, and no account.
Your code and your API key never reach a Mindweave server, because there isn't one.

It is built lean on purpose. Most of a coding agent's context budget goes on scaffolding
the model never needed. Mindweave keeps prompts thin and leaves the room for the model to
reason about your code.

How the project is run, what gets into the core and what does not: [PHILOSOPHY.md](PHILOSOPHY.md).
It is short, and it is the honest version.

> ## ⚠ Hold off on using Mindweave for now!
>
> A deep audit of the agent as of lately 8/10 found real problems we want fixed
> before anyone builds on this. We're telling you now rather than letting you
> find out mid-session:
>
> - **Token consumption is much higher than it should be.** Task-critical
>   context is re-sent uncached on every model step, and a few prefix blocks
>   (MINDWEAVE.md, the memory index) grow without a cap and can invalidate the
>   prompt cache mid-session. Even a short session costs noticeably more than
>   it needs to on premium providers, several times more.
> - **File writes were not atomic.** A crash at exactly the wrong moment could
>   truncate a file being edited. The fix (temp file + fsync + rename) is
>   written and being verified.
> - **Too many tools are advertised at once.** 39 always-on tools measurably
>   degrade the model's tool selection. We're moving rare tools behind the
>   same deferred pool MCP tools already use, and merging overlapping ones.
> - Smaller issues from the same audit: process cleanup on POSIX, a
>   sub-agent result contract, and per-session cost instrumentation.
>
> None of this loses your data in normal use the worst finding needs a
> crash at exactly the wrong moment but the token cost alone is reason to
> wait. The fixes are in progress and will land as v1.10.x with the audit
> notes in the changelog, as usual. If you want to try Mindweave anyway,
> set spending limits (`MINDWEAVE_MAX_TASK_USD`) and know the above going in.
>
> Niman

## Coming up: Release 1

Mindweave has been built in the open through the 1.x line, and **that line is now
finished**. v1.9.9 closed the last of it: every part of the core has been read end to
end, and the audit queue is empty.

**The next release is the official one: Mindweave 1.** It lands on npm, installable in
one command, with the numbering reset to match. It is the first version meant for people
who were not watching it get built, and it carries the most in a single release so far.

The headline is the interface. **The new UI is fully designed and ships with it** —
drawn from scratch rather than borrowed, because a terminal is not a small browser and
pretending otherwise is why so many CLI tools feel busy. It is quieter than what ships
today and it gets out of the way while the agent works. For a tool that lives in a
terminal, the interface is the product, which is why it is the thing gating the release
rather than another feature.

What the 1.x line built up to it: web search on both providers, seeing your app through
a window capture, a plan you approve to start, sixty-odd defects found by auditing every
tool, every shell path, and every store, and a security pass over everything that
reaches outside your machine.

See the [changelog](CHANGELOG.md) for the whole road here.

## Install

Requires **Windows**, **Node.js 20+**, and a model API key.

macOS and Linux are coming later. They are not supported today, and the reason is
written down under [Known problems](#known-problems) rather than glossed over.

```bash
git clone https://github.com/mindweave-cli/Mindweave
cd Mindweave
npm install
npm run build
npm link          # makes the `mindweave` command available globally
```

Then, in any project:

```bash
cd your-project
mindweave
```

On first launch it asks for your API key and saves it to `~/.mindweave/.env`, so it works
in every project afterwards. Then type what you want done.

`mindweave --help` covers setup and the launch flags; `mindweave --version` prints the
version. Everything else is configured in a session, not on the command line.

Optional: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) makes search faster.
Without it Mindweave uses a built-in walker.

### Your key

Two providers ship today. You only need the key for the one you use.

```
DEEPSEEK_API_KEY=your-key-here     # deepseek-v4-flash, deepseek-v4-pro
ANTHROPIC_API_KEY=your-key-here    # claude-sonnet-5, claude-opus-5
```

Set both and you can switch between them in the same project with `/provider`.

## Using it

| Command | What it does |
| --- | --- |
| `/help` | Lists every command |
| `/provider` | Picks who serves this project |
| `/model` | Picks which of that provider's models answers |
| `/think` | Picks how hard it reasons |
| `/continue` | Resumes an earlier session |
| `/undo` | Reverts what the last turn changed |
| `/mcp` | Manages connected MCP servers |
| `shift-tab` | Cycles interaction modes |

Your provider and model choice is remembered per project. See
[`src/drivers/PROVIDERS.md`](src/drivers/PROVIDERS.md) for the model list.

## What it does well

**Deterministic code intelligence.** A background lane indexes your repo with tree-sitter
and language servers, costing no tokens, so the agent understands your codebase rather
than just the file you opened.

**Real tools.** File read and edit, multi-file edits, ripgrep search, a shell with
background jobs, sub-agents, and compiler diagnostics. Read-before-edit is enforced, and
`/undo` is a real net rather than a hope.

**Session memory.** Long sessions stay sharp through automatic compaction plus a running
state summary that survives it. The agent can read its own earlier sessions in a project,
so "what did we do last time" gets a real answer instead of a guess.

**MCP servers.** Connect external tool servers (GitHub, Postgres, your own) with
`/mcp add` or by asking in plain words. They start with your session, and their output is
treated as untrusted by default. Full guide: [docs/MCP.md](docs/MCP.md).

**Images.** Drag a screenshot into the prompt, or write `@shot.png`. A model that can see
gets the image. A text-only model says so plainly rather than pretending.

**Web search.** Ask about a current API or a recent release and the agent looks it up
instead of guessing from training data, then follows any source for the full page. It runs
through your model's own provider, so there is no second account and no key to manage.

**Seeing your app.** The agent can capture one window and look at it, which is how you
tell an app that started from an app that works. One window, never the whole screen, and
it asks first, naming the window it is about to capture.

**Per-project governor.** Give a project standing rules, reusable skills, and forbidden
paths or commands that the agent has to respect.

**Model-adaptive drivers.** Each model family gets its own driver so it runs at its best
without bloating the shared core. Only the driver you are using is ever loaded.

## Recently

**v1.9.9 closes the 1.x line.** Compaction, session resume, and the governor were the
last parts of the core never read end to end, and they were left for last because none
of them fails loudly. Six defects came out of it, every one of which type-checked,
passed the suite, and could never throw.

The worst: before the older conversation is thrown away and a summary kept instead, the
reply is checked for the ways it can be unusable, and it checked one of the four. A
refusal became the session's record of itself. Alongside that, an attached image could
be dropped while the model was still looking at it, a sub-agent inherited an "allow all"
answer you gave about different work, a rule's file patterns could rewrite the rule that
contained them, and forbidding `rm` also refused `npm run warm`.

Two of the six were sitting under comments describing the safeguard that was missing,
which is why reading the files had not been enough to find them.

Full detail in the [changelog](CHANGELOG.md).

## Known problems

Written down rather than quietly carried. Several are good places to start if you want to
contribute, and each links to what it would actually take.

**Windows only for now. macOS and Linux are coming later.** Mindweave is developed and
tested on Windows, and that is the platform it currently supports. The test suite does
not yet pass on macOS or Linux: it hangs partway through rather than failing outright,
which points at process handling that has only ever been exercised on Windows. CI runs
Windows alone until that is fixed, so a green run means something.

Making a platform work is the single most useful thing an outside contributor can take
on, and it is genuinely open. See CONTRIBUTING.md.

**The out-of-memory crash is contained, not cured.** Loading the OCaml grammar can
exhaust V8 when the machine is already under memory pressure. Test runs are given heap
headroom and the grammar-heavy files run in their own sequential phase, which holds, but
the underlying cost of that grammar is unchanged.

**The agent explores in more round trips than it needs.** It tends to look things up one
at a time rather than asking for everything it needs at once, and each round is a full
model call. Repeated reads of the same content are now caught and refused, so a round
costs less, but the shape is unchanged. This is partly model behaviour and partly prompt
work, and it is measurable: `scripts/narration.mjs` reports it against a real session.


**MCP has been driven against one real published server.** Tools have been exercised end
to end; resources and prompts have only been tested against servers written for the
purpose. Real servers will find edges these did not.

**MCP gaps, deliberately not being worked on right now:** OAuth for remote servers (they
report `needs-auth` and stop), multi-round tool requests and elicitation, and attaching a
resource yourself with `@`.

## Found a bug?

**Please open an issue.** Mindweave is developed by running it on real projects and fixing
what breaks, so a reproduction from someone else's setup is genuinely the most useful
thing you can send. Nearly everything in the changelog started as a failure someone
watched happen.

Useful to include: your OS and terminal, which model you were on, and the steps that led
to it. If the agent did something odd rather than crashed, the transcript around it helps
more than a description.

Especially worth reporting:

- **Anything MCP**, particularly a server that serves resources or prompts.
- **A tool the agent was offered but could not call**, or one it insisted did not exist.
- **A prompt or menu that says something untrue.** Those cannot crash and do not fail
  tests, so they survive until a person notices. Several changelog entries are exactly
  this.

## Contributing

Contributions are welcome, especially **model drivers**. OpenAI, Qwen, Ollama and others
are unclaimed, and a driver is a smaller job than people expect: it owns one provider's
wire format and nothing about how the agent behaves.

Small fixes and reproduced bugs with a failing test can go straight to a pull request. For
anything larger, start a Discussion first. The [Contributing Guide](CONTRIBUTING.md) has
the mechanics, [BOUNDARY.md](BOUNDARY.md) answers what belongs in the core versus a
driver, and [PHILOSOPHY.md](PHILOSOPHY.md) explains where the two bars sit.

AI-assisted contributions are fine. The one rule is that you understand and have tested
what you are submitting.

## License

[Apache License 2.0](LICENSE).
