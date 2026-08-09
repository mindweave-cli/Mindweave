# Security Policy

## Supported versions

Mindweave ships from `main`. Security fixes land there and go out in the next release; there are no maintained older branches yet.

| Version | Supported |
| ------- | --------- |
| `main` / latest release | Yes |
| Anything older | No |

---

## The threat model, honestly

Mindweave is a local, single-user tool. It runs on your machine, with your API key, inside your repository, and it edits files and runs shell commands on your behalf. That is the product, and it means the interesting risks are not the ones a web app has:

- **There is no Mindweave server.** No backend, no telemetry, no account. Your code and your key go to your model provider and nowhere else.
- **The agent has real capability.** It writes files and executes commands. A model that makes a bad call can do damage, the same way you can.
- **The model is not trusted input.** A model can be wrong, and a repository can contain text written to manipulate one. Anything that must hold has to be enforced mechanically, not asked for in a prompt.

That last point is the design rule for everything below. A sentence in the system prompt is a request. A check in the tool layer is a wall.

## What is enforced mechanically

These live in `src/tools/guard.ts` and the governor, and none of them depend on the model cooperating.

- **Secrets are never readable.** `.env`, `.ssh`, `*.pem`, private keys, and `.git` internals are refused by the file tools, excluded from search results, and blocked from shell commands that would print them. All three paths are gated, not just the obvious one, because `grep -r` and `cat` walk straight around a per-file check.
- **A short list of catastrophic commands is refused.** Wiping a filesystem root, reformatting a disk, writing to a raw device, fork bombs. Deliberately narrow and high-confidence. This is a seatbelt, not a sandbox.
- **Another tool's private data is asked about first.** If a project has been worked on by a different coding agent, its saved conversations and rules are not ours to read. Mindweave asks you before touching them rather than helping itself, and search skips them outright.
- **Per-project forbidden paths and commands.** `/forbidden <path>` makes a path untouchable and the tools refuse it. Only you can lift it, per session, through an approval prompt. The model cannot lift it or work around it.
- **Plan mode changes nothing.** In Architect mode the mutating tools are withheld from the request entirely, and refused if called anyway.
- **Sentinel mode asks before every mutating action**, at the single execution choke point, so it covers every tool including sub-agent edits. It fails closed: no approval channel, or an unclear answer, refuses.

What this is **not**: a sandbox, a jail, or a defense against a model deliberately trying to evade a string check. A single-user local tool does not ship a shell analyzer, and pretending otherwise would be worse than saying so. If you need true isolation, run Mindweave in a container or a VM.

## MCP servers

An MCP server is third-party code you pointed Mindweave at, and its tool descriptions go straight into the model's prompt where they are read as instructions. That makes a description an injection surface, not documentation. Three attacks follow from it: **tool poisoning** (hidden instructions in a description or schema), **rug pulls** (a clean server ships an update that poisons one), and **cross-server shadowing** (one server's description steering the agent into misusing another server's tools).

What Mindweave does about it:

- **Descriptions and schemas are fingerprinted.** Every tool is hashed on first sight and the record is kept per project. If a description or its parameter schema moves, the tool is **blocked** and you are asked, with the change named. Decline and it stays blocked, and the old fingerprint is kept so you are asked again next session rather than the change being silently accepted. With no way to ask, it fails closed.
- **The check runs again whenever a catalog moves, not only at startup.** A server can announce a changed tool list at any moment, and until v1.4 those new descriptions were reloaded without being compared to anything, which left the rug pull open in the one case the fingerprints existed to cover. A mid-session change now blocks the affected tools and tells you, rather than interrupting a running turn with a prompt.
- **A server cannot flood the context.** Tool results and resources over a size ceiling, and anything binary, are written to a file in the project's state directory. The model gets the beginning plus a path, so a large payload costs a few hundred tokens instead of a turn.
- **Server output is framed as data.** Results come back inside a delimited block marked as external content to reason about, never as instructions to follow.
- **Descriptions are length-capped** before they reach the prompt, which bounds what one server can inject or cost you.
- **`forbid_mcp_tool <name>`** bans a single tool across sessions without disabling the rest of its server. It is removed from every path: advertised list, search, activation, and dispatch, not just the obvious one.
- **A failing or hostile server cannot take the session down.** Connection failures become states, not exceptions.

What this is **not**: verification that a server is trustworthy. **A server that is malicious the first time you connect passes every check above.** First sight is trusted by construction, since there is no signature to check and no reputation to consult. This catches *change*, not badness. No MCP client currently solves the day-one case, so treat adding an MCP server with the same care as installing a dependency: read what it is before you point at it.

## Your key

Mindweave is bring-your-own-key. Keys are read from `~/.mindweave/.env`, a project `.env`, or your shell environment, and that file is written with `0600` permissions. Keys are never logged, never printed into the transcript, and never sent anywhere except the provider they belong to. Nothing about a key crosses a driver boundary: each provider's driver only ever sees its own.

---

## Reporting a vulnerability

**Do not open a public issue or discussion for a security problem.**

1. **Preferred:** the repository's **Security** tab, then **Report a vulnerability** (GitHub private vulnerability reporting).
2. If that is unavailable, contact the maintainer privately.

### What to include

- What the vulnerability is, and what an attacker gets out of it.
- Steps to reproduce, ideally a minimal example.
- OS, terminal, and which model provider or driver was involved.
- Relevant logs, with keys, tokens, and personal paths redacted.

### Especially worth reporting

- Any way to get a secret's contents into the transcript, since that means it reaches the provider and the saved session file.
- A mutating action that runs without approval in Sentinel mode, or at all in Plan mode.
- A forbidden path or command that a tool touches anyway.
- A driver reading, logging, or transmitting anything belonging to a different provider.
- Prompt injection from repository content that causes a real action rather than just odd output. Odd output is a model problem; a file being written is ours.

### Response

- Acknowledgement within 48 hours.
- Updates as the fix progresses, and credit in the release notes unless you would rather not be named.

---

## For contributors

- Never commit a key, token, or `.env`. Sanitize logs in issues and pull requests.
- If you add a tool that reads files or runs commands, route it through the existing guards. A new path to file contents that skips `guard.ts` is a vulnerability even if nothing has exploited it yet, and that has happened here before.
- Enforce in the tool layer, not the prompt. See [BOUNDARY.md](BOUNDARY.md).
