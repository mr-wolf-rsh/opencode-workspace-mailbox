# opencode-workspace-mailbox

A plugin-only package that makes an OpenCode session aware of its per-project
mailbox and handles `OPEN` handoff messages automatically — with loop guards.

## Why

Multi-repo workspaces talk to each other through asynchronous handoff files: one
file per project, append-only, addressed `from X → to Y`. The problem is the
human relay. A message sits `OPEN` until someone remembers to open the file in
the right session, read it, act on it, and flip it to `DONE` — and "someone
remembers" is exactly the step that fails.

This plugin closes that loop **from inside the session that receives the
message**. There is no CLI, no daemon, no scheduler, and no `opencode run`
spawning: when the session is closed, nothing happens, by design.

## What it does

Each project has an append-only mailbox file. When a session goes idle, this
plugin reads the project's mailbox, finds `OPEN` messages it has not yet acted
on, and prompts the session once to handle them (load the mailbox skill, read
the file, flip each message to `DONE`). It never runs a daemon or spawns a new
session: if no session is open, nothing happens.

## Install

Add the package to `opencode.json`:

```jsonc
{
  "plugin": [
    ["opencode-workspace-mailbox", {
      "mailboxDir": "D:\\LABS\\absolute-winners\\handoffs",
      "wake": true
    }]
  ]
}
```

Local path variant during development:

```jsonc
{
  "plugin": [
    ["D:\\LABS\\opencode-mailbox", { "mailboxDir": "D:\\LABS\\absolute-winners\\handoffs" }]
  ]
}
```

Point `mailboxDir` at the workspace handoff directory. Each project then owns one
`<mailboxDir>/<project>.md` file; `workspace` is the parent's mailbox.

## Config

| Option         | Default                          | Description                                                        |
| -------------- | -------------------------------- | ------------------------------------------------------------------ |
| `mailboxDir`   | `<directory>/handoffs`           | Directory holding `<project>.md` mailbox files.                    |
| `project`      | resolved per session (see below) | Explicit override of this instance's mailbox identity.             |
| `maxAutoRounds`| `2`                              | Auto-prompts in a row with no progress, clamped to `0..20`.        |
| `cooldownMs`   | `30000`                          | Minimum gap between auto-prompts (and notices).                    |
| `enabled`      | `true`                           | Master switch.                                                     |
| `wake`         | `false`                          | Poll the mailbox and wake an idle session on a new message.        |
| `pollMs`       | `10000`                          | Wake poll interval, clamped to `100..600000`.                      |
| `stateFile`    | `<directory>/.atl/mailbox-state.json` | Persisted dedupe/round state (must stay inside the project). |

## Which project am I?

Identity is resolved **per session**, so one global config serves every repo:

1. `project` set in the options → use it verbatim.
2. `mailboxDir` is configured and lives **inside** the session directory → this session is the
   parent, so `project` is `workspace`.
3. Otherwise → the session directory's basename, kebab-cased.

For a workspace where the parent is `D:\LABS\absolute-winners` and children live inside it:

| Session opened at | Reads/writes |
|---|---|
| `D:\LABS\absolute-winners` | `handoffs\workspace.md` |
| `D:\LABS\absolute-winners\absolute-scrapers` | `handoffs\absolute-scrapers.md` |

The containment rule only applies to an explicitly configured `mailboxDir`, so the per-project
default (`<directory>/handoffs`) never turns every project into the parent.

## Mailbox format

Files are `<mailboxDir>/<project>.md`. Append-only: messages are never
rewritten, reordered, or "tidied". The **only** permitted edit to history is
flipping a message's `**Status:**` line to `DONE`.

```
### YYYY-MM-DD HH:MM — from <source> → to <recipient>
**Status:** OPEN
**Topic:** one-line subject
Body...
```

## Behaviour

- **Idle detection**: on `session.idle`, read the project's mailbox and select
  `OPEN` messages.
- **Wake (opt-in)**: with `"wake": true`, poll the mailbox every `pollMs` and
  prompt the most recently active session that is not mid-turn. This is what
  makes a cross-project message arrive in an already-idle session — an idle
  *transition* never fires again on its own.
- **One prompt per message hash**: each message has a stable hash
  (header + topic + body); a given hash is prompted once, persisted across
  restarts.
- **Round cap**: at most `maxAutoRounds` auto-prompts in a row without progress;
  after that a one-line notice is surfaced instead (a toast, deduped per message
  set). An inbox that drains, or an `mailbox_ack`, restores the budget.
- **Cooldown**: at least `cooldownMs` between auto-prompts.
- **Own-write suppression**: messages the plugin appends via `mailbox_send` are
  never prompted.
- **Human-turn reset**: a human message resets the round budget.

## Tools

- `mailbox_read({ project? })` — list OPEN messages for a project.
- `mailbox_send({ to, topic, body, status? })` — append a message to a mailbox.
- `mailbox_ack({ project?, hash?, header? })` — flip a message's status to `DONE`.

## Loop guards

- Dedupe by stable hash (persisted).
- Max auto-rounds per human turn.
- Never react to the plugin's own writes.
- Cooldown between prompts.
- Idempotent ack (already-`DONE` is a no-op, not an error).

## Safety

- **Append-only mailbox.** `mailbox_send` only appends; it never rewrites, reorders, or deletes.
- **Minimal ack diff.** `mailbox_ack` replaces only the bytes of the `**Status:**` token
  (`OPEN` → `DONE`). Every other byte — spacing, line endings, bodies — is preserved, and the tests
  assert exactly that.
- **Path containment.** Recipients must be lowercase kebab-case and resolved paths must stay inside
  `mailboxDir`; traversal (`..`, separators, absolute paths) is rejected. The state file must
  resolve inside the project directory.
- **Bodies are data.** Message content is never executed, evaluated, or turned into commands.
- **Bounded state.** Only hashes are persisted (last 500) and the file is written atomically.
- **Failure isolation.** Mailbox and toast errors are caught and logged; a broken mailbox never
  takes down the session.

## Limitations

- Only runs while a session is open in that project — a closed session picks up
  the message when it is next opened.
- Scoped to one project per plugin instance (no cross-project session
  activation); identity is resolved per session, not per config.
- `wake` spends tokens with nobody watching, at the pace messages arrive. Leave
  it off if you prefer idle-only delivery.
- Message bodies are data only; they are never executed.
- New recipient files are not registered in `handoffs/README.md`.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
