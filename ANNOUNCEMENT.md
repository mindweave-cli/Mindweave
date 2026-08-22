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

## Remote MCP servers work against the current spec

Mindweave connects to MCP servers, and it targets the current revision of that
protocol, where a request repeats a few of its own details in HTTP headers so a
gateway can route it without reading the body. Servers check those headers against
the request and reject the call outright if the two disagree.

Three of them were wrong, and each fault broke calls rather than merely slowing them
down. The header naming what a call is aimed at carried the name of the operation
instead of the name of the tool, so every tool call to a remote server contradicted
itself. The protocol version header, required on every request, was not sent at all.
And where a server asks for particular tool arguments to be repeated in headers,
Mindweave was not repeating them, which quietly made any tool using that feature
impossible to call.

All three are fixed and checked against a real server rather than a stand-in. A tool
whose definition breaks the rules for those headers is now left out of the listing
with a note naming it and the reason, rather than being offered and then failing when
you reach for it. One bad definition costs a server that one tool and no others.

Local servers, the ones Mindweave starts as a program on your machine, were never
affected. They do not speak HTTP and have no headers to get wrong.

## A tool call can take more than one trip

Some servers cannot finish a job in a single exchange. The protocol has them say so
and hand back a token, and the client calls again with it until the work is done.
Mindweave was not reading that answer. It took "I need another round" to mean "here
is your result", and passed the model whatever partial content happened to come with
it. Nothing failed and nothing was logged. The call simply looked like it had worked.

It now carries the call through as many trips as the server asks for, up to a limit,
because a server is allowed to keep asking indefinitely and stopping is the client's
job. If a server asks for something Mindweave has no way to supply, the call fails
saying what was wanted, instead of returning an empty answer dressed as a success.

## Long sessions hold together

Mindweave summarises the older part of a conversation when it grows too large, keeps
the recent part, and carries on. That is what lets a session outlive the model's
context window. Six things around it were wrong, and they had a habit in common:
each of them failed quietly.

**Compaction that gave up said nothing.** After three failed attempts it stopped
trying, which is right, and then the session kept running past its own limit with
nothing on screen to say so. The first sign of trouble was an error nobody could
connect to the cause. A failure now says what went wrong, the stop is announced, and
you get a heads-up before a compaction rather than after it.

**A conversation that outgrows the window now recovers on every provider.** It used
to recover on two of thirteen. Two of them report the problem as part of an
otherwise normal reply; the other eleven reject the request, which looked identical
to Mindweave sending something broken. It is now told apart from the provider's own
words and handled the same way: drop the oldest exchanges and carry on.

**Compacting is often free now.** Mindweave already keeps a running set of notes on
what the session is doing, maintained outside the conversation. When those notes are
current enough to cover the part being dropped, they are used instead of paying a
model to write a summary of what they already say. When they are not, the summary
still happens. It declines rather than guessing.

**And the work continues afterwards.** Mindweave tracks which files it has read, and
that record lived outside the conversation, so it survived a compaction that had just
removed the file contents it described. The check that stops Mindweave editing a file
it has not read then agreed the file had been read. Nothing was corrupted, but the
tool and the model disagreed about what was on screen. The record is now rebuilt from
what actually survives, and the handful of files being worked in are read back, so a
long task picks up where it left off instead of retracing its steps.

## A rate limit no longer ends your turn

Eleven of the thirteen providers had no retries at all. A single rate limit, or one
gateway hiccup, ended the turn partway through. You had already paid for the request,
the work was gone, and the only option was to type it again. Providers return those
constantly and mean nothing by them.

Those are retried now, with a growing, jittered wait. Only the failures that deserve
it: a malformed request is not retried, because it will not work the second time
either and repeating it only makes a real bug harder to spot. The waiting is kept
short on purpose, so it reads as working rather than as a freeze, and a cooldown
longer than that is reported to you instead of sat through in silence.

**And if the connection drops mid-answer, you keep what you saw.** Words already on
screen used to be thrown away, because the failure unwound the turn before anything
was written down: you would watch an answer arrive that the conversation had no
record of, and the next turn could not see it either. It is now kept and marked
incomplete.

## Your session is written the way your files are

Mindweave already wrote every file it edits for you through a temporary file and a
rename, so a crash can never leave one half written. Your session was not going
through that path. The transcript is rewritten in full every time it saves, and it
saves constantly, so the unsafe moment was crossed many times a minute. A crash
inside it takes the whole conversation, and takes it in the worst way: an empty
transcript reads as nothing to resume rather than as something to repair.

Sessions, cross-session memory and approved plans now write the same careful way.

## Your rules stay in force

Rules you set are meant to be standing instructions, and there were two ways one could
stop applying without saying so.

A rule can be scoped to a set of paths, so it switches on once the session is working in
them. That was decided from the record of which files were currently in view, and
summarising a long conversation clears that record. So a rule scoped to a folder quietly
stopped applying the moment the session got long enough to compact, and came back only
if the same folder was opened again. What is on screen changes when a conversation is
summarised; what you are working on does not, and those are now tracked separately.

The second is about workspaces. `/include` adds another project to a session, but a
forbidden path was only ever measured against the project you started in. A rule
refusing to touch a folder did nothing in the folder you added, while still being listed
and still looking active. Paths are now measured against every folder in the workspace.

Folders you add stay workable, and a folder that is not part of your workspace is still
none of the rule's business.

## Two ways round the file protections, closed

Mindweave has two guards on what it will touch: the deny-list you write per project,
and a fixed floor of files it will never read or write whatever it is asked, which is
where secrets and keys live. Both had a hole.

The deny-list compared paths with case, and Windows and macOS filesystems do not. A
project forbidding `.env` still allowed `.ENV`; one forbidding `src/legacy` still
allowed `src/Legacy`. Same file, either way. Nothing clever was needed to reach it, as
writing a name in a different case is something a model does on its own, and the rule
then quietly did not apply.

The floor recognised `.env` and `.env.local` but not `prod.env`, `staging.env` or
`.envrc`. A per-environment file is one of the commonest places a real secret sits.

Both are fixed, and ordinary source stays readable: `environment.ts` and `env.ts` are
not secrets and Mindweave still reads them.

## One command puts your terminal back

If Mindweave is killed outright, by running out of memory or by a force quit, it
never reaches its own cleanup, and your terminal is left reporting mouse movement.
Every scroll after that writes stray characters into your shell, and it survives
closing Mindweave because Mindweave is already gone.

`mindweave --reset-terminal` puts it back, and is safe to run at any time. Closing
the terminal window is now handled properly as well, so the ordinary ways of quitting
do not leave anything behind either.

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
