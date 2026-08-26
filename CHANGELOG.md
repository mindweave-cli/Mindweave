# Changelog

Notable changes to Mindweave. Dates are release dates.

The 1.x line is the build-in-the-open phase. The next milestone is Release 1, when
Mindweave lands on npm and the numbering resets.

---

## Unreleased

Work since v1.9.9, not yet given a version.

### /mcp add and /mcp remove never ran

The guard routing those sub-commands read as a word-boundary pattern and held a stray
control byte where the escape belonged, so it required a control character to be typed
and never matched anything. Every `/mcp add` opened the server-health view instead,
while the command advertised itself in its own help text. The code behind it was correct
and covered by tests; only the route to it was dead.

Command routing now lives in one place as data rather than a pattern, and is tested. The
eighteen built-in commands had no coverage before this, because the routing was a chain
of conditions inside a view component with nothing to call. A test also holds the command
list and the handlers together, so a command cannot be advertised with nothing behind it
or work while appearing in no list.

### Two new commands, and arguments that are no longer discarded

`/clear` starts a fresh conversation without leaving the folder; until now the only way
was to quit, or to take the third option in the session picker. `/init` has the model
write MINDWEAVE.md, the file loaded into context every turn that nothing had ever been
able to create.

`/model`, `/think` and `/compact` accepted an argument and threw it away in silence.
All three take it now. A name that is ambiguous or unrecognised is refused with the real
options rather than resolved to the nearest match, because the wrong model is billed on
the next turn. A `/compact` focus is additive and says so in the prompt: that summary
replaces the older conversation, so a focus read as a narrowing instruction would
destroy the rest of it permanently.

Starting a fresh conversation also stopped quietly shrinking the workspace. Folders added
with `/include` or `/link` were dropped, so every tool silently searched one folder
instead of several, and undo history went with them even though the files stayed edited.

### Messages queued while it works can be taken back

Typing while Mindweave is working queues the message, and that was a one-way door.
Pressing up looked like editing the queued message but replayed it from history, leaving
the queued copy live, so editing and sending produced two messages. Up, or escape,
now pulls the whole queue back into the input as editable text; clearing the box is how
a queued message is cancelled. Escape during a turn still means stop and leaves the queue
alone, so one key never carries two decisions. Consecutive queued messages are sent as a
single turn rather than one turn each.

### The interface stopped talking about itself

Every turn printed lines about the tool's own housekeeping — which prompt cache had been
invalidated, that a checkpoint had been sealed, how close the context was to a
compaction, that a background command had started and then been stopped by the person
who stopped it. None of it was news, several fired more than once a turn, and together
they crowded out the work. What survives is the small set that reports something wrong
and actionable.

Prose between tool calls is no longer capped at one block per turn. The cap could not
tell a repetitive model from a sparing one, so against a model that narrates rarely it
only guaranteed silence for the rest of a long turn. Each block is still trimmed, which
is what bounds the wall.

A shell command reads as `Run(npm test)` now, the same shape as `Read(index.ts)`,
instead of a sentence with the command on a row beneath it. Output no longer waits on a
three-second beat before appearing: an earlier version held every block back on the
theory that a visible pause reads as deliberate work, and in use it read as an animation.


### Forbidden paths now cover every folder in the workspace

v1.9.9 recorded the opposite, and it was accurate at the time: patterns were measured
only against the project you opened, so a rule refusing a folder did nothing in one
added with `/include` while still being listed and still appearing to be in force.
Paths are now measured against every root in the workspace.

Matching also became case-insensitive. Windows and macOS filesystems are, so `.env` and
`.ENV` are one file, and a case-sensitive comparison let the second spelling past a rule
written with the first.

### DeepSeek can read images

`deepseek-v4-flash-vision-exp` shipped on 2026-08-21 and is now offered by `/model`.
It reads images; the other two DeepSeek models still do not, and pointing a picture at
one of those still says so rather than sending the message without it.

Adding it exposed a gap underneath. The shared transport used by eleven providers had
no way to send an image at all: the field carrying one was our own, spread onto the
request untouched, so a provider saw an unknown key and the bytes never left the
machine. A request built that way looks perfectly well formed. That transport now emits
proper multimodal content, which every provider on it inherits.

The model is offered without a reasoning ladder. DeepSeek documents the request shape,
the formats and the image budget for it, and says nothing about reasoning effort. This
driver has already shipped a reasoning level the API does not accept once, so an
unverified one is not advertised again.

### Eleven more providers

Mindweave shipped the 1.x line with two. It now speaks to thirteen: DeepSeek, Anthropic,
OpenAI, Gemini, xAI, Mistral, Groq, Cerebras, Qwen, Kimi, GLM, Meta and MiniMax, across
45 models. Each family keeps its own driver, so a provider's quirks live with that
provider and never leak into the shared core, and only the driver you are using is
loaded. Mindweave also identifies itself to every provider now, rather than arriving
anonymously.

### The terminal interface was rebuilt

It runs on its own screen instead of scrolling your history away, with a pinned header
and footer and the whole conversation scrollable behind them.

The changes underneath were mostly things that had been quietly wrong. Resizing could
fuse an old frame onto the new one, because the screen was repainted without being
erased first. Prose was capped narrower than the window, so a maximised terminal wasted
half its width. The conversation and the input box could end up flush against each other.
Diffs and shell output were hard to tell apart at a glance. The input box lost its border
in one revision and got it back. The caret is a blinking bar rather than a static block,
which is the difference between a cursor and a rendering artifact.

A terminal left in a bad state by a crash is also repaired on the next launch, rather
than leaving every scroll writing escape codes into your shell.

### Prompt caching, token accounting, and the tools

The cacheable part of a request was being invalidated by things that did not need to
touch it, so a conversation paid to re-send its own prefix. Reworked, along with how
tokens are counted and reported.

Reading and searching changed shape. A whole-file read that is too large now answers with
the file's structure instead of a truncation, so the model can ask for the part it wants.
A read of several files with a line range no longer drops the files the range did not
apply to. Symbol ranking was deleted outright after measuring zero uses across 774 calls.
Twenty-two copies of "this tool failed" became one. And a model mistyping a tool call no
longer paints a red row: it is told what was wrong and writes the call again a moment
later, which is not news, and training people to skim past error rows is how the ones
that matter get missed.

### The first run

The path a new user takes had never been audited, and it had five dead ends. A key for
any provider except the default one left you stuck on a prompt with no way past. The
config template listed two providers of thirteen. A wrong key could only be fixed by
finding and hand-editing a file, because none of the commands could replace one. Escape
could not leave the key field. Scrolling the wheel while typing a key corrupted it.

What replaces it: a trust prompt that asks once per folder and says plainly when the
folder is an entire drive, a provider list you can add as many keys to as you like, and
`/key` as a real manager, three levels deep, where you can show, switch, edit or remove
any key for any provider. The screens are centred and carry a welcome, the version, and
four things worth knowing while you are pasting a key.

A second screen that asked for a key you had already entered was deleted.

### Plan mode, permissions, and sub-agents

An approved plan now actually ends, and can start the work from a clean slate while
keeping the planning conversation. Two approval questions can no longer cancel each
other. A permission answer grants what it was asked about rather than everything of that
shape, and a sub-agent no longer inherits a grant you gave in person about different
work. A sub-agent also stopped paying for session notes that nobody keeps.

Switching provider mid-session no longer lets one vendor's opaque data reach another.

### The governor

A scoped rule is decided when a file is touched, not when the prompt happens to render,
which is what makes a rule reliable rather than incidental. The governor re-reads its own
files when they change on disk. Standing rules stay in force across a summary and inside
an added folder. Two ways round the file protections were closed: a deny list that
ignored case, so `.ENV` walked past a rule written for `.env`, and a floor that missed
`prod.env` and `.envrc`.

### Durability

A long session holds together across a summary. A provider blip is survived rather than
losing the turn. A dropped connection keeps the reply you had already seen. Sessions are
written the same careful way files are, so a crash mid-write cannot leave a truncated
one, and a restore puts a file back with the same care. A failing tool can no longer take
the whole session with it, and a saved memory can no longer become unfindable.

### MCP

Requests now mirror the body fields Streamable HTTP requires into headers, which is what
some servers check rather than the body. A tool call is carried through however many
round trips a server asks for, instead of being abandoned after the first.

---

## v1.9.9 (2026-08-09): the last three audits

Compaction, session resume, and the governor were the only parts of the core never
read end to end. They were left for last because none of them fails loudly: a bad
summary replaces a session's history with something wrong and the model carries on as
if it were true.

Six defects, none of which could throw, all of which type-checked and passed the suite.
Two were sitting under comments describing the safeguard that was missing, which is why
reading the files had not been enough.

### A refused summary could replace the conversation

Before the older transcript is thrown away and a summary kept instead, the reply is
checked for the ways it can be unusable. It checked one of them. A refusal, a context
overflow, and an overloaded provider all returned text that passed every other check
and became the session's record of itself.

Only a cleanly finished reply is accepted now, so a new failure mode arriving with a
future provider is rejected rather than admitted by omission. A reply is also checked
for the numbered structure it was asked to produce, because a refusal is fluent, long,
and shaped nothing like a summary — length alone could not tell them apart.

### An image could be dropped while the model was still looking at it

Old tool output is cleared on a window that deliberately spares whatever the model has
not acted on yet. Attached images were cleared on a different window that did not,
despite the code saying the two matched, so a screenshot could be evicted while every
result around it was kept.

### A sub-agent inherited "allow all"

In the mode that asks before each action, answering "allow all" applies to the work in
front of you. A sub-agent started afterwards inherited that answer, and since a
sub-agent has no way to reach you, nothing would have asked. It now starts vigilant:
its changes are refused and it reports back instead.

### A rule's file patterns could rewrite the rule

Rules and skills are stored with a small header, and every value written into it is
flattened to one line first, because a line break starts what the loader reads as a new
setting. Every value except the file patterns — the field that decides when a rule
applies. Flattening now happens where the header is built, so a field added later
cannot miss it.

### Forbidding a command could block unrelated ones

Forbidden commands matched anywhere in the text, so forbidding `rm` also refused
`npm run warm` and `npm run format`. They match whole words now, and still match
patterns that begin or end in punctuation such as `--force` or `./deploy`.

### Also

The security policy now states three things it did not: that forbidden paths are
relative to the project root and do not extend into folders added with `/include`
(built-in secret protection still covers every root), that "allow all" is not inherited
by a sub-agent, and how forbidden commands match.

---

## v1.9.8 (2026-08-09): DeepSeek can search the web

Web search is a capability of the model's own provider rather than a service
Mindweave buys, so it worked on Claude models and reported itself unavailable on
DeepSeek. DeepSeek does have native search; it is simply served over a different
protocol than the one used for chat.

DeepSeek now searches. It runs on DeepSeek's own servers, with the key already
configured, and nothing third-party is involved. There is no second key, no account
to create, and nothing to choose: chat continues over the endpoint it always used and
only the search call speaks the other protocol. Moving everything there would have
cost the prompt cache, images, and MCP support, none of which that endpoint carries.

Searching on DeepSeek costs more than an ordinary turn, because their side makes
further requests to summarise what it finds.

This is the pattern for every provider added from here: a provider declares whether it
has native search, and the driver routes that one call over whichever protocol carries
it. Providers without native search continue to say so plainly and point at
`web_fetch`.

### Fixes

**A malformed search result reached the model.** A live DeepSeek search returned a
result carrying neither a title nor an address, which rendered in the source list as
"undefined — undefined". Results without a usable address are now dropped, and a
result with an address but no title is listed by its address.

**`--version` and `--help` now work.** Both flags were ignored: the interactive
session started instead, and without a terminal attached it hung rather than exiting.
They print and exit immediately, which is what a script or a packaging tool expects.

---

## v1.9.7 (2026-08-09): hardening what reaches outside the machine

A review of the tools that leave the machine found that none of them went through a
guard. Every file tool passes through `guard.ts` and every MCP result is framed as
external data; web pages, search results, and screen captures went through neither.

### A redirect could reach a private address

`web_fetch` checked the address it was given and then followed redirects without
checking again. A public URL answering with a redirect to `127.0.0.1`, an internal
host, or a cloud instance metadata address was fetched anyway, and its contents
returned. Redirects are now followed one hop at a time and each destination is checked
before anything connects to it.

The address check itself was thin. It now covers private and link-local IPv6, addresses
written in decimal or hexadecimal to slip past a text match, IPv4 addresses wrapped in
IPv6 notation, and carrier-grade NAT ranges. Redirects to schemes other than http and
https are refused rather than followed.

### Web content is marked as data

Pages and search results now arrive inside a delimited block that says plainly it is
external content to reason about rather than instructions to follow, which is the
treatment MCP output already had. Search results need it most: the model chooses the
query, and whatever answers chooses the words, including page titles that sit next to
a real answer.

This is a boundary the model is asked to respect, not a wall, and the documentation
says so rather than claiming more.

### Screenshots no longer accumulate

Each capture was written to a temporary folder and never removed, so every window ever
photographed stayed on disk indefinitely, holding whatever was on screen at the time.
Captures are now cleared after a retention period, swept at startup so a crash cannot
leave them behind.

### The security policy describes the product again

SECURITY.md gained sections on web content and on screen capture, including the honest
limit: a screenshot can capture a secret that is visible on screen, which the file
tools would have refused to read. The approval prompt naming the window is the control,
which is why it appears every time.

### Both search engines are tested

Search runs on ripgrep when it is installed and a built-in walker otherwise, and a
given machine only ever exercised one of them. The two had already drifted apart once.
The engine can now be forced, and the build runs the search tests on both paths.

---

## v1.9.6 (2026-08-09): approving a plan starts the work

Plan mode could produce a plan and then had no way to finish. Approving one meant
switching modes by hand and asking again for the thing that had just been described,
and the plan itself often arrived in pieces.

### The plan is shown whole

A plan used to be ordinary prose, and prose written before a tool call is treated as
narration: shortened to two sentences, and dropped entirely after the first one in a
turn. That is right for "checking the config now" and wrong for the plan itself, so a
plan composed between lookups reached the screen in fragments.

Plans now come through their own channel and are shown in full, once.

### Approving it is the instruction

The plan arrives with four answers: approve and let it work, approve and confirm each
action, reject, or send it back for changes. Approving starts the work immediately,
in the same turn, following the plan that was just read rather than a version of it
recovered from the conversation.

Approval covers that piece of work and not the session. When the work ends, planning
resumes, including after an interruption or an error. Anything unrecognised coming
back from the prompt counts as a refusal, so an empty or unexpected answer can never
start work.

Decisions that are genuinely the user's are asked during planning rather than assumed.

---

## v1.9.5 (2026-08-09): the agent can look things up, and look at your app

Two things the agent could not do before, and four fixes to how commands are reported.

### Searching the web

`web_fetch` could read a page you already knew the address of. There was no way to
find one, so any question whose answer changed after the model was trained had no
route to an answer: current library APIs, recent releases, whether a package still
exists.

`web_search` fills that in. It returns an answer with the pages behind it, so the
common question resolves in one step instead of a search followed by a fetch, and you
can follow any source with `web_fetch` for the full page.

Searching belongs to the model's own provider. Mindweave does not sign up to a search
service, hold a second API key, or route your queries through anything of its own. A
model that cannot search says so plainly and points you at `web_fetch` rather than
failing in a way that invites the agent to keep retrying.

### Seeing a window

A process being alive is not the same as an app working: a window rendering a stack
trace is alive. `screenshot` captures one window so the agent can look at it and tell
you what is actually on screen, which also covers a layout that is subtly wrong, a
chart with no data, or a dialog nobody expected.

It captures **one window and never the whole screen**, and it asks before every
capture, naming the window it is about to photograph and saying the image goes to the
model. A screenshot is the one thing here that can pick up what the agent was never
pointed at, so the narrow scope and the question are the design rather than a setting.
There is no clicking or typing: seeing closes the loop, acting is a different tool with
a much larger risk surface.

On a model without vision the file is captured and named rather than sent, because
being told a picture exists is more useful than being handed one that cannot be read.

### Commands report what actually happened

**A failed PowerShell command could report success.** Exit codes were read from
`$LASTEXITCODE`, which only native programs set. A cmdlet that failed left it unset,
that was read as zero, and the agent was told the command worked. It hit most of what
gets written day to day, `Get-Content`, `Remove-Item`, `Copy-Item`, and the agent would
then build on work that had not happened. Both signals are now read, so a cmdlet failure
is a failure and a program's own exit code still survives intact.

**Long output kept the wrong end.** Only the first 30,000 characters reached the model.
Builds and test runs put their banner at the start and their diagnosis at the end, so a
verbose run filled the budget with progress and the failure was discarded. Both ends are
kept now, and the gap is marked where it falls.

**Backgrounded `cmd` commands left their script behind** in the temp directory, once per
run, forever. They are cleaned up when the shell ends.

**Non-English output could arrive corrupted.** Output was decoded one chunk at a time, so
a character split across two reads became a replacement glyph. Decoding now spans chunks.

### Also

Process cleanup on macOS and Linux, carried over from work that was diagnosed but held
back: killing a process group silently did nothing when the child was not spawned as a
group leader, a killed process could be reported as still running while it waited to be
reaped, and shutdown skipped shells whose wrapper had exited while their children had
not. Windows is unaffected by all three. Three test files that had never run in the
suite are now part of it.

---

## v1.9.4 (2026-08-07): the first automated build, and the two bugs it found

v1.9.3 shipped without an automated build. Adding one took a few hours and found two
real defects in that time, both of which had been present for a while and neither of
which any test on a developer machine could have caught.

### One directory, two names

Windows keeps an 8.3 short alias for any path component longer than eight characters,
so `C:\Users\johnsmith\...` and `C:\Users\JOHNSM~1\...` are two names for one place.
`run_command` decides whether a command moved the shell by comparing the working
directory before and after as text, and the two sides came from different places: one
from the session, the other from whatever spelling the shell printed.

When they disagreed, every command reported a working-directory change it had not
made, and the recorded directory no longer matched the project root, which is what
makes Mindweave give up on relative paths and show you absolute ones everywhere.

This affects any Windows account whose name is over eight characters, which is most
of them. It stayed invisible because it cannot happen on a short account name, and it
appeared within minutes of the suite running somewhere else.

Paths are now resolved through the operating system rather than Node's own
implementation of the same idea. The difference is the whole fix: Node's version
follows symbolic links but leaves a short name exactly as it found it, so it can
never bring the two spellings together.

### Search could list the files it refuses to open

With ripgrep installed, `glob` listed `.env` and private keys. Ripgrep applies its
filename rules last-match-wins, like `.gitignore`, and the exclusions were registered
BEFORE the caller's pattern, so a pattern as ordinary as `**/*` matched last and
cancelled every one of them. `read_file` refuses those files and `grep` never searches
them, so this was the one route that did not hold the line. The caller's pattern is
now registered first and the guards after it.

Two smaller disagreements between the two search engines went with it: a leading slash
matched under ripgrep and not under the built-in walker, and multi-root results came
back with paths that no longer pointed at a root.

### Builds now run on every push

Windows, on Node 20 and 22. Failures are reported as annotations, which are readable
without special access, unlike run logs.

macOS and Linux are not covered. They were tried, and the suite HANGS there rather
than failing, which is a real defect with a real starting point rather than something
to leave running red. Windows is the supported platform today and the README says so.

---

## v1.9.3 (2026-08-07): the same answer either way, and installs that cannot hang

Mostly about search and indexing telling the truth, plus the first automated test runs.

### Search gave different answers depending on your machine

Mindweave searches with ripgrep when it is installed and with a built-in walker when it
is not. Only ripgrep respected `.gitignore`, while both tools described that behaviour as
though it always applied. The same query on the same project therefore returned different
results on two machines, and nothing in the reply said which engine had answered.

The built-in walker now honours `.gitignore` too: nested ignore files, negated rules,
directory-only rules, and last-match-wins precedence. An unsupported rule is treated as
matching nothing, so the walker errs toward showing a file rather than hiding one, since
a wrongly hidden file looks exactly like a file that does not exist.

Symlinked directories are now skipped deliberately rather than by accident. They used to
fall through an `isDirectory`/`isFile` check and vanish with no decision behind it.
Ripgrep does not follow them either, and code that lives elsewhere is better added as a
workspace root with `/link`, which labels and indexes it properly.

### The code map indexed files every other tool refuses to open

`definition`, `references`, `relevant` and the folder rollup all read out of the code
map, and the code map was built from an unfiltered walk. So symbols from `.env`-adjacent
files and from other coding agents' directories could be surfaced by a lookup, even
though `read_file`, `grep` and `glob` all decline those paths directly. The exclusion is
now applied when indexing, at the source, rather than at each query.

### Answers that claimed more certainty than they had

* `references` asked the language server about only the first definition of a name, then
  reported the result as compiler-resolved. A name defined in three places returned one
  set of callers with full confidence. It now covers every definition and removes
  duplicate call sites.
* A symbol the language server confirms has no callers is now reported as unused. It
  previously fell back to matching the name as text, which invented callers for it.
* In a multi-root workspace, a merged list is only labelled resolved when every root
  resolved it. One root running a language server no longer vouches for a root that is
  not, which had been suppressing the "verify this" note on the half that needed it.
* `outline` on a large directory now says how many files it actually covered. It stops
  after 40, and a partial survey that does not say so reads as the shape of the whole
  folder.

### Sessions that hung, and processes that piled up

Installing a language server ran `npm install` with no timeout and never killed it, and
downloads had no deadline. A stalled install waited forever, left its process tree
running, and because installs are shared, handed that same never-finishing wait to
everything that asked afterwards. This is why fresh project directories could hang for
ten minutes or more while background processes accumulated: a fresh directory is exactly
when a server gets installed, and a warm one skips the step.

Every step now has a deadline and kills its whole process tree when it expires. A failed
install is a normal outcome that leaves the language on the tree-sitter tier, which
works.

### Tests now run automatically

There is a CI workflow, running on Windows on Node 20 and 22.

macOS and Linux were tried and then removed again. The suite does not fail there, it
HANGS: the test step ran past fifteen minutes with no end while the same suite finished
on Windows in three. That points at process handling which has only ever been exercised
on one platform. Reporting a hang nobody is working on says nothing about whether a
change is good, so those jobs come back with the work that makes them pass. Windows is
the supported platform today, and the README says so plainly.

The suite's intermittent crash under load was diagnosed rather than worked around: it is
`Fatal process out of memory: Zone`, caused by the size of the OCaml grammar rather than
by test scheduling. It survived forcing single-file concurrency, and it followed the
OCaml cases when they were moved between files. Test runs now have heap headroom, and
the grammar-heavy files run in their own sequential phase. The language cases were also
rebalanced by grammar size, with a guard test that fails if that balance drifts.

---

## v1.9.2 (2026-08-07): what it says, and what it reads twice

Two problems, both found by running the agent on a real project rather than by reading
code. Neither could fail a test, which is why they survived nine releases.

### The agent talked more than it worked

A turn that made 23 tool calls printed 24 paragraphs of narration. Each one was short,
but two dozen of them is a wall, and the same function names came round in four
separate blocks: a plan stated, then restated, then restated again.

The cause was in the system prompt, which said the user could not see tool calls, and
then demonstrated `"Let me read the file."` as the house style. Both were wrong. Every
tool call is rendered on screen as it happens. So the model was being told to narrate
work the user was already watching, and shown an example of how.

* The prompt now states what is actually true: your text sits alongside a visible record
  of every call, so it has to add to that record rather than repeat it.
* **One line of narration per turn**, enforced where it renders rather than requested in
  prose. However many tool calls a turn takes, the tool rows are the progress indicator.
* Final answers now match the question. A finished task gets a line or two. A question
  that genuinely asks for an account ("what did we do last session", "why did that
  break") gets as many plain paragraphs as the answer needs. Headings, bullet lists and
  status recaps on a short answer are gone.

### The same lines were paid for repeatedly

Files the agent is working on are rebuilt into its context every turn. `read_symbol`
did not check that, so it re-sent a function body that was already on screen. Ranged
`read_file` had the same hole for large files, which are shown as focused regions
rather than whole. One session read the same file four separate times while its
contents sat in front of the model.

* Both now compare the request against what the working set **actually rendered this
  turn**, and point at it instead of re-sending. Checked against what was drawn, never
  against a record of what was read once: a stale claim that the model already has
  something is far worse than a wasted read, and a sub-agent has no working set at all.
* An edited file is always re-sent. Freshness beats saving tokens.

### Also

* A saved session whose tool calls and their results were stored out of order could not
  be resumed at all. Those are now repaired on load, with nothing dropped.
* Reminders the engine writes to itself (verify your changes, batch these edits) were
  indistinguishable from something you typed. They showed up as your own prompts in a
  resumed chat, and one could become the session's title in `/continue`. They are marked
  as engine-written and no longer surface as yours.
* `scripts/narration.mjs` reports how much a session talks against how much it does:
  prose per tool call, how many blocks ran over budget, and which identifiers were
  discussed in three or more separate blocks. Useful if you are working on this area.

---

## v1.9.1 (2026-08-07): tool audit

Every one of the 36 tools the agent can call was read against its own implementation,
one at a time. The rule for the pass was simple: read the code before writing a word
about it. Every defect below was invisible from the description alone.

Two causes accounted for nearly all of it. Some descriptions were accurate when written
and were never updated as the tool grew. Others were written as a one-line summary of a
feature and never revisited. Descriptions written against an observed failure were the
accurate ones, which is a useful thing to know when writing the next one.

21 of the findings were code, not wording.

### Answers that were quietly wrong

* **`diagnostics` checked the wrong files.** With no path given it picked the files to
  check by insertion order rather than recency, so the file you had just edited was
  skipped. It then reported "No diagnostics" while naming files it had never looked at.
* **`list_dir` showed a symlinked directory as a file.** A directory reached through a
  symlink or junction reports as neither a file nor a directory, so the trailing slash
  that tells them apart never appeared. Common in `node_modules/.bin` and linked
  monorepo packages. Symlinks are now marked, and a broken one says so.
* **`list_dir` said "directory not found" when pointed at a real file**, which sent the
  agent looking for something it had already located. Missing, is-a-file and
  permission-denied are now told apart.
* **`find_mcp_tools` silently returned only the first 8 matches.** Search is the only way
  to reach a large MCP catalog, so the tools it did not return also stayed unloaded and
  invisible. It now says when it hit the limit.
* **`list_mcp_resources` and `read_mcp_resource` disagreed about server names.** For some
  configured names the listing rejected the exact name the read accepted.

### Data that could be lost

* **Skill bodies were corrupted.** Placeholder substitution treated any `$` followed by
  digits as an argument, so `$100` became empty and, with no arguments passed, every
  `$1` in the body was deleted. A skill containing `awk '{print $1}'` silently became
  `awk '{print }'`. The steps the agent followed were not the steps on disk.
* **Saving one memory could delete another.** The index updater removed any line
  containing the saved file's name, so an entry whose text referenced another memory was
  deleted when that memory was next saved.
* **Two memory names that reduce to the same filename silently replaced each other.**
  Saving is deliberately not confirmed with you because memory is non-destructive; this
  was the one case where that was untrue, and it is now reported.
* **A standing rule could exist twice in a session and once on disk**, so a rule you had
  just set appeared to vanish on restart.
* **Frontmatter injection in three writers.** Memory, rules and skills all wrote
  user-supplied text into a line-oriented header that is read back and trusted. A line
  break in a name or description could forge fields, for example re-scoping a rule to
  every file. No malice required; a pasted title does it.

### Consent

* **Pressing Escape on a question returned the second option as your answer.** Correct
  for a yes/no prompt, wrong for `ask_user`, where the options are arbitrary. Dismissing
  "Postgres or SQLite?" told the agent you had chosen SQLite.
* **Sub-agents could put approval dialogs on your screen.** A parallel fan-out could
  stack several with nothing to say which agent asked. Sub-agents now proceed on a
  sensible default and report the assumption, which is what their briefing already
  assumed.
* **`add_directory` and `link_workspace` treated "no way to ask" as permission granted**,
  on the widest change either makes: pulling every discovered sibling repository into the
  workspace. Both now decline and say so.
* **`add_mcp_server` did not say what it was about to do.** It asked to "add" a server
  while replacing an existing one of the same name, and never mentioned that credentials
  were being written to a config file. Both are stated before the question now, naming
  the credential keys but never their values.

### Accuracy

* **`add_mcp_server` recommended something that cannot work.** It told the agent to
  reference an environment variable, with `"$TOKEN"` as the example. Nothing expands that,
  so it reached the server as those literal characters and failed as a bad credential.
  The server already inherits your environment, so a variable already set in your shell
  needs no entry at all.
* **`add_directory` could add the same folder several times** under different labels,
  because paths were compared as text. A case variant or a symlink produced a second
  root, and searches then walked the same tree twice.
* **`glob` listed secrets that every other tool refuses.** `read_file` declines `.env`,
  `grep` never searched it, `glob **/*` listed it.
* **MCP resource template listings were unbounded**, so a server could put as much into
  your context as it liked.
* **`link_workspace` reported only its successes**, so a partial link read as a complete
  one.
* Background shell output that had been dropped to stay within its buffer was recorded as
  truncated and never shown, so an incomplete log looked complete.

### Descriptions

The other 15 findings were wording, but the kind that changes behaviour: caps that were
enforced and never stated, results that looked identical whether they meant "clean" or
"I could not check", and tools that promised more certainty than they had. Every stated
number is now pinned to the constant it describes, so prose cannot drift from the code.

---

## v1.0 to v1.9.0

This changelog starts at v1.9.1. Earlier versions were released as commits rather than
tagged releases, so the detail lives in `git log`. What landed across that line:

* **v1.1** the Anthropic driver alongside DeepSeek, and providers loaded on demand
* **v1.2** sessions the agent can read back, so "what did we do last time" gets a real
  answer
* **v1.3, v1.4** MCP, including protection against a server changing a tool's description
  after you trusted it
* **v1.5** rebuilt editing tools and per-model compaction
* **v1.6** background jobs that report when they are actually up, not just when they exit
* **v1.7** undo that will not overwrite your own edits, and `/provider` split from
  `/model`
* **v1.8** images you can attach and have looked at
* **v1.9.0** core hardening, subsystem by subsystem, and POSIX process handling. Feature
  freeze starts here.
