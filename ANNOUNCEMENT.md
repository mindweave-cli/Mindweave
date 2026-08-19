# Mindweave 1

*Draft announcement. Not committed, not published. Update this file as each
feature or fix ships; it goes out as-is once the full version is released.*

---

Since v1.9.9, Mindweave has been rebuilt where it mattered most: the screen you
actually look at, the models you can talk to, what a turn costs you, and how it
finds the code you asked about. Here's what changed.

A note on where the ideas came from. Terminal coding agents are a young field
with a few very good examples in it, and we took a lot of inspiration from the
best of them, especially on prompt caching, tool surface, and how a search tool
should behave. Every line here is our own, and several of the choices below go
the other way on purpose. Where we found a better answer, we took it.

## A real terminal interface

Mindweave runs on its own screen instead of scrolling your terminal history
away. A pinned header and footer stay put, you can scroll back through the whole
conversation, and tool output appears once, already finished, instead of a
placeholder that changes its mind a second later. Long plans and permission
prompts no longer tear the screen when they run past the window.

Every block lands on a steady three-second beat, on purpose, so the tool never
feels like it's rushing through a turn or stalling on you. Summaries that used to
render as a wall of text now break into real paragraphs and tables again, with a
reading width that keeps answers legible even on a maximized window. Compaction
shows a before-and-after bar with the exact token count it just reclaimed, every
time it runs, not only when you ask for it.

**Typing is fast now.** It used to lag in long conversations, and the cause was
not the work being done. The renderer was capped at 30 frames a second, which put
a 34-millisecond floor under every keystroke no matter how little there was to
draw. Raising the cap took a keypress from 41ms to 12ms. Scrolling got the same
fix for free.

## A new rendering engine

The interface draws itself the way a game does. Mindweave keeps a grid of what is
actually on your screen, works out which individual character cells changed, and
sends the terminal only those, instead of erasing and redrawing everything on
every update. On a long conversation that is about thirteen times less data going
to the terminal per frame.

## Twelve new model providers

Mindweave launched speaking only DeepSeek and Anthropic. It now also speaks
OpenAI, Gemini, Meta, MiniMax, Qwen, Kimi, GLM, xAI, Mistral, Groq, and Cerebras,
with a wider Anthropic lineup alongside them. Switching is the same `/provider`
and `/model` you already know, no new concepts to learn per provider.

Meta's Muse Spark is offered two ways: the normal tier, and a "Contributor" tier
that runs roughly 12x cheaper in exchange for letting Meta train on your prompts
and completions. Both are real, and Mindweave never picks the cheaper one for
you. The default is always the one that keeps your data yours.

## DeepSeek tuned, not just supported

DeepSeek's fast model runs at its higher reasoning tier by default and uses
sampling settings tuned for tool-calling instead of generic chat defaults,
straight out of the box.

## The prompt cache actually holds now

This is the change that costs you the least and took the most work to find.

Every provider caches the front of your request and reuses it if the next request
starts with the same bytes. Change one character anywhere in that region and the
whole thing is re-read at full price. Nothing fails when that happens. The reply
is normal. The only trace is on your bill.

Two things in Mindweave were breaking it constantly:

- The skill catalog rendered into the system prompt was filtered by which files
  had been read, so reading a matching file rewrote the prompt and threw away the
  entire cache.
- Searching for a tool added it to the advertised tool list, which changed the
  request's tool section mid-session and cost a full rewrite to save a few hundred
  tokens of schema.

Both are fixed. The catalog no longer varies, and tool discovery is now
append-only: searching hands the model the tool's full definition in the search
result, and the advertised list never moves for the life of a session.

The effect is visible in real sessions. Before, the cached portion of a request
sat frozen at the fixed prefix while the conversation grew, so every word you and
Mindweave exchanged was re-billed on every single call. Now it grows with the
conversation. On a recent session a request of 55,000 tokens was served 49,000
from cache.

**And it now tells you when the cache breaks.** Mindweave fingerprints the model,
the system prompt, every tool definition and every message before each request. If
the cached prefix stops matching, you get a line saying which part moved and why.
A cache break is one of the most expensive events in a session and it used to be
completely silent.

## It tells you where the tokens went

Mindweave was reporting a number for what a turn cost that could run up to 4.5x
higher than what the provider actually billed. It was adding the same cached
context back up on every tool call inside a turn instead of counting it once.
Fixed, and it now reflects exactly what providers report back.

Sessions also keep a **per-call breakdown** now: prompt size, how much was served
from cache, how much was fresh, output, and which model produced it. A turn total
can't tell one expensive call apart from six cheap ones, and until now nothing on
your machine recorded which model ran, so neither question had an answer after
the fact. Both do now.

The running spend also survives `/continue`. It used to be rebuilt empty on
resume, and the next save overwrote the file with a smaller number, permanently
destroying the earlier total.

The live counter while Mindweave works shows output as it streams, eased so it
counts rather than jumps. It deliberately does not show input: input doesn't
arrive over time, so putting it there made the number leap the moment a request
went out and then sit still for thirty seconds.

## Reading a file the way you'd actually read one

Two changes, both aimed at the same habit.

**`read_file` takes a list.** Reading four files used to mean four separate model
round trips, each re-sending your entire conversation to the provider. One call
with four paths costs a quarter of that and takes a quarter as long. A bad path in
the list is reported in place instead of throwing away the files that read fine.

**A large file comes back as its structure, not its text.** Asking to read a
1,700-line file whole costs its full length on that request and on every request
afterwards for the rest of the turn, so one careless read is paid for five or ten
times over. Past roughly 8,000 tokens, Mindweave answers with the file's symbols
and their line numbers instead, so the follow-up is an exact range rather than
another guess. A request for specific lines is never second-guessed.

That second one is where Mindweave's code map finally earns its keep. The usual
answer elsewhere is a hard cap that refuses the read and tells the model to use a
line range, which it can't act on, because not knowing which lines it wants is
exactly why it asked for the whole file.

## Search you can steer

Mindweave's search gained the three things that decide whether it can locate
something or gives up and reads the file:

- **Paging.** A capped result used to say "narrow the search" and nothing else.
  When you can't narrow it, reading whole files is the only move left. It now
  tells you the offset that continues it.
- **Asymmetric context.** `before` and `after` separately, because the commonest
  question a search asks is "what is this thing", and the answer is the lines
  after a declaration, not a window centred on it.
- **Multiline matching.** Patterns can cross line breaks, so you can find a
  construct that isn't on one line.

**ripgrep now ships with Mindweave.** It installs as a per-platform binary, so a
fresh install gets a fast, `.gitignore`-aware search without you installing
anything. It's optional by design: on an architecture it doesn't cover, or behind
a registry that blocks it, install still succeeds and search falls back to the
built-in walker. Search getting slower is an acceptable failure. Installation
failing is not.

## Mindweave finally remembers what it's looking at

Two quiet bugs used to make Mindweave dumber than it should have been on real
projects. The file you were actively editing could get left out of what Mindweave
believed it already had in view, without telling you, so it would go re-read a
file it had just changed. And on any project with both frontend and backend code,
the map Mindweave builds of your codebase was counting every repeated CSS
selector as its own symbol, which buried your actual UI code so badly that a
frontend task could come back with backend suggestions and nothing else. Both are
fixed and verified against a real mixed-stack project, not just tests.

## Mindweave now identifies itself

Every request Mindweave sends to any provider carries its own name in the
standard client-identification header, the same way every other terminal coding
agent already does. It doesn't change how anything works today. It just means
Mindweave's traffic reads as Mindweave's traffic wherever a provider looks,
instead of an anonymous SDK call.

## Leaner under the hood

The tool surface Mindweave puts in front of the model went from 39 tools to 8.
The rest are still there and still callable; they're loaded on demand when a task
needs one, which costs a fraction of advertising all of them on every request.
Fewer tools also means better choices: a model picking among 8 picks better than
one picking among 39, at any context length.

Every file write goes through an atomic path, so a crash or a killed process
can't leave you with a half-written or zero-byte file.

## What we took out

Mindweave used to rank your codebase by structural centrality, a PageRank walk
over the reference graph, and expose it as a tool that answered "what matters
here". It was a genuinely interesting idea and we removed it. Across every stored
session it was called zero times out of 774 tool calls. The code map stays, and
it's now doing the job it's actually good at: reading one symbol instead of a
whole file, and describing a large file's shape.

We'd rather ship the thing that gets used.

## What's next

A handful of things are actively being explored for the versions after this one:
a desktop app alongside the CLI, the Mindweave website going live, and usage
insights that let you see what you're spending and where.

macOS and Linux support is the one honest gap left, and it's open. Mindweave has
only ever been run and verified on Windows; the core is written to be portable,
but someone needs to actually drive it on macOS and Linux, find what breaks, and
fix it. If that's you, this is the place to jump in.

---

*(Sections above will be revised as more ships before release. Do not publish
this file until told to.)*
