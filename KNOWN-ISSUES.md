# Known issues

Written down rather than quietly carried. Several are good places to start if you want to
contribute, and each says what it would actually take.

## Windows only for now

Mindweave is developed and tested on Windows, and that is the platform it currently
supports. The test suite does not yet pass on macOS or Linux: it hangs partway through
rather than failing outright, which points at process handling that has only ever been
exercised on Windows. CI runs Windows alone until that is fixed, so a green run means
something.

Making a platform work is the single most useful thing an outside contributor can take
on, and it is genuinely open. See [CONTRIBUTING.md](CONTRIBUTING.md).

## The out-of-memory crash is contained, not cured

Loading the OCaml grammar can exhaust V8 when the machine is already under memory
pressure. Test runs are given heap headroom and the grammar-heavy files run in their own
sequential phase, which holds, but the underlying cost of that grammar is unchanged.

## Some models look things up one at a time

A model that asks for several things at once finishes a task in fewer calls than one
that asks for them one after another, and how much of that a model does is largely its
own habit. Mindweave gives it the room to batch: reads take a list, search pages, and
repeated reads of the same content are caught rather than re-sent.

## MCP has been driven against one real published server

Tools have been exercised end to end; resources and prompts have only been tested against
servers written for the purpose. Real servers will find edges these did not.

Deliberately not being worked on right now: OAuth for remote servers (they report
`needs-auth` and stop), multi-round tool requests and elicitation, and attaching a
resource yourself with `@`.

## npm has a placeholder, not a release

The `mindweave` package on npm is version `0.0.1`, published only to hold the name. It is
not the agent. Install from source until the first real version ships.
