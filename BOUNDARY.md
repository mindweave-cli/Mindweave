# Before you build: universal or driver?

**Read this before writing any code in this repo.** Every fix, every feature, every
bug. It takes a minute and it exists because skipping it has already cost us real
bugs, listed at the bottom.

Mindweave runs several model providers through one engine. That only works if two
things stay true:

- **Core never knows which model is running.** It owns the agent loop, the tools,
  their safety gates, what the system prompt says, memory, and compaction.
- **A driver never teaches a model how to work.** It owns one provider's wire
  format, request shape, cache breakpoints, model list, prices, context window, and
  any parsing repairs that provider needs.

A driver controls **format, not craft**. The system prompt is byte-identical
whichever provider you pick. If that stops being true, the architecture is gone and
every provider added afterwards makes the product worse instead of better.

---

## The three questions

Answer all three, in order, before writing code. If you are working with an AI
agent in this repo, it must give you these answers **before** it starts, not after.

### 1. Should this exist at all?

The default answer is **no**. This project is deliberately finished at the core and
the bar for adding to it is high.

Say yes when:

- it fixes a **reproduced** bug, and you can state what you observed
- it closes a correctness gap you can demonstrate with a failing test
- it is a new **driver** (those are additive and cost the core nothing)

Say no when:

- it is a feature nobody hit a wall without
- it is a guess at what a model might need
- it makes core bigger to work around one model's behavior (see question 2)

Being able to build something is not a reason to build it. A smaller core that does
its job well beats a larger one that does more.

### 2. Where does it go?

One test decides it:

> **If a different provider were the only one installed, would this still be
> correct and still be needed?**

- **Yes** → core.
- **No** → `drivers/<provider>/`.
- **Unsure** → it is a driver. Wrong-in-a-driver affects one provider;
  wrong-in-core affects all of them and every future one.

Faster signals:

| Signal | Goes in |
|---|---|
| Names a provider, model id, endpoint, or wire field | driver |
| Compensates for how one model behaves | driver, or nowhere (see below) |
| Would become dead code if that provider were removed | driver |
| Is about files, sessions, tools, safety, or the user's project | core |
| Every provider needs it and none needs it differently | core |
| Is a number you measured about your model | driver, as a manifest fact |
| Is a threshold, a bar, a placement, or an ordering | core, always |

**The trap.** "This model keeps doing X, add an instruction telling it not to" feels
like a core prompt change. It is not. It is one model's crutch, and core hands it to
every other model that never needed it. Prefer fixing it in the driver, or accepting
the behavior, or concluding the model is wrong for the job. Instructions to core
that exist because of one provider are the main way this architecture rots.

**Facts belong to the driver. Decisions belong to core.** A manifest reports things
about a model that someone measured: its usable window, its prices, the effort rungs
it accepts, the ceiling the driver puts on a buffered call. Core reads those and
decides what to do with them: where the compaction bars land, how much headroom to leave,
what order things go in, which tools exist. Both halves are needed and the split is
what keeps them honest.

A hook that returns a threshold instead of a measurement fails this test even
though it looks like the same kind of field. `contextWindow()` is a fact. A
hypothetical `compactAt()` is not: "when do I summarize" is a policy that should be
identical everywhere, and once eight providers each answer it separately there is no
way to know any of the answers are right. Nobody will measure them, and a guess
sitting in a manifest reads like evidence. Same for tool lists (behaviour, not a
property of the model) and prompt-block placement (no measurement exists).

Two rules follow, and PRs are checked against both:

- **A driver never contains a decision about what the agent does.** If your new
  manifest field's value would be argued about rather than measured, it is core's.
- **Every manifest value comes from measurement, and the reasoning goes in the
  file.** DeepSeek's 256K carries its published NIAH-2/MRCR curve; Flash's 192K
  says outright that it is a judgment call under absent data. Either is fine.
  A number with no stated basis is not.

### 3. What breaks for the other providers?

If the answer to question 2 was **core**, you must answer this one too.

- Does it assume a field, value, default, or behavior that only one provider has?
- Does it add prompt text every model will now read, whether or not it needs it?
- Does it use a vocabulary term (an effort level, a stop reason, a role) that some
  provider does not accept? Shared types are the **union** of every provider's
  vocabulary, so a value being in the type does **not** mean your provider takes it.
- If a provider fails this, does it fail loudly, or does it silently do nothing?

Silent is worse than loud. A rejected request gets noticed. A value quietly ignored
can sit there for weeks.

---

## The report, before any work starts

State this and get agreement before writing code:

```
What:        one line, plainly.
Should we:   yes / no, and why. Evidence if it is a bug.
Where:       core  |  drivers/<provider>
Why there:   answer to the "different provider" test.
Risk:        what could break for other providers, or "none, driver-local".
Verify by:   the check that proves it works, and the check that proves
             it did not break anyone else.
```

If "Where" is core and "Risk" is empty, the risk section was not thought about.
There is always something, even if the answer is that it is genuinely universal.

---

## Before you call it done

- `npm run typecheck` clean
- `npm test` clean, with the **new test that fails without your change** (write it,
  watch it fail, then fix it; a test that never failed proves nothing)
- if you touched a driver: every **other** provider's tests still pass
- if you touched core: name which providers are affected and why that is fine
- if you added prompt text: state which models now read it and why each needs it

---

## Traps we have actually hit

Not hypothetical. Each of these shipped or nearly shipped.

**A shared type is not a permission slip.** `Effort` is the union of every
provider's ladder (`low | medium | high | xhigh | max`). DeepSeek accepts only
`low | high | max`. Pro's "Maximum" sent `xhigh` for weeks and did nothing, because
`xhigh` is Anthropic's rung and type-checked fine. A driver must clamp to its own
accepted set in `normalize()` and test it.

**Omitting a field is not the same as disabling it.** DeepSeek defaults `thinking`
to *enabled* when the field is absent, so "Standard" mode silently ran full
reasoning on every call, including internal ones. Send the explicit value. Read the
provider's documented default rather than assuming absence means off.

**Search and shell walk around per-file gates.** `read_file` refused `.env` while
`grep -r` printed its contents and `cat .env` read it whole. If you gate a file,
gate every path to its contents, not just the obvious one.

**Enumerating names does not generalize.** A deny-list of competitor tool
directories is always one tool behind and encodes their names in your source
forever. Prefer a boundary the project itself declares.

**Behavioral instructions in core are one model's crutch.** The reliability rules in
`dynamo/prompt.ts` were written as "universal" when there was exactly one provider,
so universal and DeepSeek were the same set. They are not anymore. Anything that
tells a model *how to behave* deserves the question 2 test.

This has since been audited and acted on. Two lines were removed: one telling the
model not to repeat a summary (written for an observed failure, and captured
transcripts show the model doing it anyway, with the line present), and one telling
it not to blindly retry (already enforced deterministically by `REPEAT_FAIL_LIMIT`).
The lesson generalizes: **a sentence the model ignores costs every provider and
helps none.** When one model misbehaves, prefer a mechanical guard, because the harness can
enforce, a sentence can only ask. `promptAssembly.test.ts` now asserts those lines
stay gone.

**Core must never name a model id.** `/model`'s autocomplete described "DeepSeek V4
Flash / Pro" long after a second provider had shipped four models, plainly false,
and read by the user every session. The `/think` overlay separately fell back to a
hardcoded `"deepseek-v4-flash"`. Both type-checked, both passed every test, and
neither could ever throw. Provider identity leaks into the **UI layer** as readily as
into the prompt, and audits that only look at `prompt.ts` miss it entirely.
`providerNeutrality.test.ts` scans all of core for model ids and is the guard.
Read model names from the registry (`allModels()`, `DEFAULT_MODEL_CONFIG`), never
from a literal.

**A prompt line that was true when written becomes a lie, and the model obeys it.**
The prompt told the model *"You cannot see what was said in [your past sessions]
from here… tell them `/continue` resumes a past session."* That was accurate when
nothing could read a transcript. The sessions, the loaders, and the need all existed
long before anyone revisited the sentence. Asked what happened last session, the
model dutifully refused to look and paraphrased a project file instead. It read as a
stupid model. It was an obedient one following a stale instruction. Prefer pointing
at a tool (`call list_sessions`) over asserting an absence: a dead tool pointer fails
loudly, a false negative claim never fails at all. Any sentence describing what the
agent *cannot* do needs a test pinning it, so shipping the capability turns that test
red, which is exactly how this one was finally caught.

**Hardcoded UI strings are the same bug wearing different clothes.** The banner read
`v0.0.1` for three releases while `package.json` said otherwise. `/model` described
"DeepSeek V4 Flash / Pro" long after four models across two providers existed. Both
type-check, neither can throw, every test passed. The pattern is always a literal
standing in for something that has a real source of truth, in a place no assertion
looks. Read from the source (`package.json`, `allModels()`, `DEFAULT_MODEL_CONFIG`),
and guard it with a test that compares the two. `version.test.ts` and
`providerNeutrality.test.ts` are those guards.

**A test fixture can be the one input that does not hit the bug.** The stdio transport
spawned MCP servers by name, and every test drove it with `process.execPath`, which is
an absolute path to a real `.exe`. On Windows that is the single shape that works
without a shell. Every other shape, including `npx`, which is how nearly every MCP
server in existence is configured, failed with `ENOENT` on the platform this project is
developed on. Twelve tests passed for a feature that could not start a real server. When
a test constructs its own input, ask what makes that input convenient, and whether
convenience is what makes it work.

**A check that runs once guards a moment, not a property.** Tool descriptions were
fingerprinted when a server connected, which reads like protection against a server
changing its descriptions. It is not. It is protection against a server that had already
changed them *before* connecting. A server that connected clean and then announced a new
tool list had the new descriptions loaded unexamined, which is the precise attack the
fingerprints exist to catch. When a guard runs at one point in a lifecycle, write down
which events can move the thing it guards, and check that each one re-enters the guard.

**A tool description biases a choice. It cannot make one hold.** Two tools existed for
editing, one for a single change and one for several in the same file, and each named the
other so the model could route between them. Measured against a real model, the identical
task with identical descriptions produced three different shapes across four runs: one
batched call, one batched plus one single, and five separate single edits. Not a wrong
description, and not a model that needs a better one. Sampling variance. The tempting
next move is to fix it in that provider's driver, and it is not available: a driver owns
format, never behaviour, and the system prompt is byte-identical across providers by
design. So a property that must hold on every model has nowhere to live except the
harness. If you catch yourself writing a sentence to make the model do something
reliably, you are writing a preference, not a guarantee, and the thing you actually
wanted belongs next to the verify gate and the repeat-failure breaker.

**Measure the cost before building the fix.** The same routing variance looked expensive
until it was counted: five separate edit calls still cost two model round trips, because
they arrive batched in one message. What it actually cost was five UI rows and five undo
points instead of one, which is a reviewability problem, not a token problem. The fix was
worth building for that reason and not the one originally assumed, and the difference
would have been invisible without instrumenting the event stream.

**A store may own a fact. It may not own a claim about what the model can see.** The
read ledger recorded "this file was read whole, at this mtime and size." That is a
fact, it is what the edit freshness gate needs, and it stays true forever. The same
bit was also read as "so the content is in context, skip the re-read." That is not a
fact about the past, it is a property of the bytes about to be sent, and
microcompaction can delete those bytes at any moment. The bit went stale exactly as
often as compaction ran, and the model was answered "unchanged, use your earlier read"
for content that no longer existed. The repair was to delete the file's ledger entry
after every clear, which fixed the lie by destroying the fact: staleness state, focus
regions and working-set candidacy went with it, so a large file quietly stopped being
refreshed at all. Note the shape. The lie and the repair for it were both consequences
of one store holding two kinds of thing.

The rule that falls out, and the one to apply when adding any knowledge layer:

- **Records** are append-only facts. The transcript, the filesystem, the ledger's
  mtime/size. Compaction changes what is *rendered* from a record, never the fact.
- **Derivations** are pure functions of the records, recomputed every step, holding
  nothing of their own: the working set, the relevance map, presence. A derivation
  cannot drift, because there is nothing in it to go stale.
- **Standing knowledge** is injected whole into every request: todos, the rendered
  governor, the memory index. Its fidelity is full by construction.

**Only a derivation may claim that content is in context.** `workingSetFull` answers it
for the volatile tail and `memory/presence.ts` answers it for the transcript, both
recomputed after compaction and before assembly, so neither can disagree with what is
sent. A new layer either contributes records or registers as standing knowledge. There
is no third category where the engine consults something nobody recomputes, and that
missing category is where this bug lived. Reconciliation code between two stores is the
smell: it is the tax on a claim filed in the wrong place.

---

## Where things live

```
src/dynamo/     the agent loop, prompt, compaction   ← core
src/tools/      tools and their safety gates          ← core
src/memory/     sessions, memory, working set         ← core
src/cli/        the terminal UI                       ← core
src/drivers/    types.ts + registry.ts                ← core (the seam)
src/drivers/<provider>/                               ← that provider only
```

`src/drivers/README.md` has the full driver contract and the manifest/driver split.
`registry.test.ts` enforces the boundary and is the test a new provider must keep
passing.
