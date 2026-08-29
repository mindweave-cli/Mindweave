<h1 align="center">Mindweave (mwcode)</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent.<br>
  You bring your own key. It runs on your machine. Nothing goes anywhere else.
</p>

<p align="center">
  <a href="LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="CHANGELOG.md">Changelog</a> &nbsp;•&nbsp;
  <a href="KNOWN-ISSUES.md">Known issues</a> &nbsp;•&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X</a>
</p>

---

## What it is

Mindweave is a coding agent that lives in your terminal and works inside your repository:
reading, searching, editing, running commands, and checking its own work.

It runs entirely on your machine. There is no backend, no telemetry and no account. Your
code and your API key never reach a Mindweave server, because there isn't one.

It is built lean on purpose. Most of a coding agent's context budget goes on scaffolding
the model never needed. Mindweave keeps prompts thin and leaves the room for the model to
reason about your code.

## Mindweave 1

This is Mindweave 1 which is finally out, tagged `mindweave-1`. Everything in it is here and works from a
clone; the npm package and the website follow shortly. Until then, install from source
with the steps below.

What landed in it is in the [changelog](CHANGELOG.md): thirteen model providers, a
rebuilt terminal interface, reworked prompt caching and token accounting, project notes
the agent maintains across sessions, and a long list of things that were quietly wrong.

## Install

Requires **Windows** and **Node.js 20+**. macOS and Linux are not supported yet, and the
reason is written down in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) rather than glossed over.

macOS and Linux support is coming soon.

## NEWS FLASH 

Bug: Task Continuation & Deferred Tools Issues

When resuming an interrupted or closed task via /continue, the system fails to cleanly restore execution context. This manifests as the screenshot tool entering a loop the model cannot locate or properly reference the tool but this is only a symptom of a deeper problem.

Root Cause: The deferred tools implementation in Mindweave removes tools from the request array entirely rather than keeping them available in a deferred state (as seen in other implementations where tools remain in the array and are simply deferred until searched). Once removed, these tools are never re-added, meaning the model permanently loses access to them after deferral.

This fundamental architectural difference breaks tool availability during task continuation and is a primary contributor to the looping behavior and flow issues we're observing.

Status: Multiple root causes have been identified. Fixes are in progress and will also address additional bugs uncovered during internal testing and agent evaluation.

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

It asks for an API key on first launch and saves it to `~/.mindweave/.env`, so every
project afterwards just works. `mindweave --help` covers the launch flags; everything
else is configured inside a session.

> The `mindweave` package on npm is a name placeholder, not a release. Install from
> source until the first published version lands.

## What it can do

**13 providers, 47 models, one key.** DeepSeek, Anthropic, OpenAI, Gemini, xAI, Mistral,
Groq, Cerebras, Qwen, Kimi, GLM, Meta and MiniMax. Each family gets its own driver so it
runs at its best without bloating the shared core, and only the driver you are using is
ever loaded. Switch with `/provider` and `/model`; the choice is remembered per project.
Full list: [PROVIDERS.md](src/drivers/PROVIDERS.md).

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

**Images and web search.** Drag a screenshot into the prompt or write `@shot.png`; a model
that can see gets the image, and one that cannot says so plainly. Ask about a recent
release and the agent looks it up instead of guessing, through your own provider, with no
second account to manage.

**Seeing your app.** It can capture one window and look at it, which is how you tell an
app that started from an app that works. One window, never the whole screen, and it asks
first, naming the window it is about to capture.

**Project notes that carry across sessions.** MINDWEAVE.md is loaded every session and
maintained by the agent, so a new conversation continues rather than starts over. Split
it with `@./path` imports, keep machine-wide notes in `~/.mindweave/MINDWEAVE.md`, and
put a MINDWEAVE.md inside a folder for conventions that are true only there — that one
is loaded only while the agent works in it. `/init` writes the first one.

**Per-project governor.** Give a project standing rules, reusable skills, and forbidden
paths or commands the agent has to respect.

## Using it

| Command | What it does |
| --- | --- |
| `/help` | Lists every command |
| `/init` | Writes MINDWEAVE.md, the project notes loaded every session |
| `/provider` · `/model` · `/think` | Who answers, which model, how hard it reasons |
| `/clear` · `/continue` | Start fresh, or resume an earlier session |
| `/undo` | Reverts what the last turn changed |
| `/mcp` | Manages connected MCP servers |
| `shift-tab` | Cycles interaction modes |

Type while it works and your message queues; press up to take it back and edit it.

## Read more

| | |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and what each fix actually was |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | What is broken or unfinished, written down rather than carried quietly |
| [PHILOSOPHY.md](PHILOSOPHY.md) | How the project is run and what gets into the core. Short, and the honest version |
| [BOUNDARY.md](BOUNDARY.md) | What belongs in the core versus a driver |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Mechanics, and what is most useful to report |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [docs/MCP.md](docs/MCP.md) | Connecting and trusting MCP servers |

## Contributing

Contributions are welcome, especially **model drivers**: Ollama is a stub waiting for
someone, and a driver is a smaller job than people expect, owning one provider's wire
format and nothing about how the agent behaves.

Small fixes and reproduced bugs with a failing test can go straight to a pull request.
For anything larger, start a Discussion first. AI-assisted contributions are fine; the
one rule is that you understand and have tested what you are submitting.

Bug reports are genuinely the most useful thing you can send. Mindweave is developed by
running it on real projects and fixing what breaks, and nearly everything in the
changelog started as a failure someone watched happen. [What to include, and what is
especially worth reporting.](CONTRIBUTING.md#reporting-a-bug)

## License

[Apache License 2.0](LICENSE).
