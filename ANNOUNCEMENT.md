# Mindweave 1

*Draft announcement. Not committed, not published. Update this file as each
feature or fix ships; it goes out as-is once the full version is released.*

---

Since v1.9.9, Mindweave has been rebuilt where it mattered most: the screen
you actually look at, the models you can talk to, and the numbers it tells
you about your own usage. Here's what changed.

## A real terminal interface

Mindweave now runs on its own screen instead of scrolling your terminal
history away. A pinned header and footer stay put, you can scroll back
through the whole conversation, and tool output appears once, already
finished, instead of a placeholder that changes its mind a second later.
Long plans and permission prompts no longer tear the screen when they run
past the window.

Every block lands on a steady three-second beat, on purpose, so the tool
never feels like it's rushing through a turn or stalling on you. Summaries
that used to render as a wall of text now break into real paragraphs and
tables again, with a reading width that keeps answers legible even on a
maximized window. Compaction shows a before-and-after bar with the exact
token count it just reclaimed, every time it runs, not only when you ask
for it.

## Twelve new model providers

Mindweave launched speaking only DeepSeek and Anthropic. It now also speaks
OpenAI, Gemini, Meta, MiniMax, Qwen, Kimi, GLM, xAI, Mistral, Groq, and
Cerebras, with a wider Anthropic lineup alongside them. Switching is the
same `/provider` and `/model` you already know, no new concepts to learn
per provider.

Meta's Muse Spark is offered two ways: the normal tier, and a
"Contributor" tier that runs roughly 12x cheaper in exchange for letting
Meta train on your prompts and completions. Both are real, and Mindweave
never picks the cheaper one for you — the default is always the one that
keeps your data yours.

## Token counts you can trust

Mindweave was telling you a number for what a turn cost that could run up
to 4.5x higher than what the provider actually billed you for. It was
adding the same cached context back up on every tool call inside a turn
instead of counting it once. Fixed, and it now reflects exactly what
providers report back.

## DeepSeek tuned, not just supported

DeepSeek's fast model now runs at its higher reasoning tier by default and
uses sampling settings tuned for tool-calling instead of generic chat
defaults, straight out of the box.

## Mindweave finally remembers what it's looking at

Two quiet bugs used to make Mindweave dumber than it should have been on
real projects. The file you were actively editing could get left out of
what Mindweave believed it already had in view, without telling you, so it
would go re-read a file it had just changed. And on any project with both
frontend and backend code, the map Mindweave builds of your codebase was
counting every repeated CSS selector as its own symbol, which buried your
actual UI code so badly that a frontend task could come back with backend
suggestions and nothing else. Both are fixed and verified against a real
mixed-stack project, not just tests.

## A new rendering engine

The interface now draws itself the way a game does. Mindweave keeps a grid of
what is actually on your screen, works out which individual character cells
changed, and sends the terminal only those — instead of erasing and redrawing
everything on every single update. On a long conversation that is about
thirteen times less data going to the terminal per frame.

Scrolling is noticeably better for it. Typing in very long conversations is
still slower than it should be, and that work is not finished.

## Mindweave now identifies itself

Every request Mindweave sends to any provider now carries its own name in
the standard client-identification header, the same way every other
terminal coding agent already does. It doesn't change how anything works
today — it just means Mindweave's traffic reads as Mindweave's traffic
wherever a provider looks, instead of an anonymous SDK call.

## Leaner and safer under the hood

The tool surface Mindweave advertises to the model shrank from 39 to 21,
with related tools folded together instead of scattered, which makes every
request cheaper before you even factor in the token fix above. Every file
write now goes through an atomic path, so a crash or a killed process can't
leave you with a half-written or zero-byte file.

## What's next

A handful of things are actively being explored for the versions after
this one: a desktop app alongside the CLI, the Mindweave website going
live, and usage insights that let you actually see what you're spending
and where.

macOS and Linux support is the one honest gap left, and it's open. Mindweave
has only ever been run and verified on Windows; the core is written to be
portable, but someone needs to actually drive it on macOS and Linux, find
what breaks, and fix it. If that's you, this is the place to jump in.

---

*(Sections above will be revised as more ships before release. Do not
publish this file until told to.)*
