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

Add the package to `opencode.json` — one global entry serves every tier:

```jsonc
{
  "plugin": [
    ["opencode-workspace-mailbox", { "wake": true }]
  ]
}
```

Local path variant during development:

```jsonc
{
  "plugin": [
    ["D:\\WORKSHOP\\mr-wolf-rsh\\tools\\opencode-workspace-mailbox", { "wake": true }]
  ]
}
```

With no `mailboxDir`, the tier is discovered from the folder tree (see below), which is what a
single global config should use.

## Config

| Option         | Default                          | Description                                                        |
| -------------- | -------------------------------- | ------------------------------------------------------------------ |
| `mailboxDir`   | discovered from the folder tree  | Pin one mailbox directory and disable discovery.                   |
| `project`      | resolved per session (see below) | Explicit override of this instance's mailbox identity.             |
| `storage`      | `file`                           | Storage backend. `file` is the MVP; the store interface is pluggable. |
| `maxAutoRounds`| `2`                              | Auto-prompts in a row with no progress, clamped to `0..20`.        |
| `cooldownMs`   | `30000`                          | Minimum gap between auto-prompts (and notices).                    |
| `enabled`      | `true`                           | Master switch.                                                     |
| `wake`         | `false`                          | Poll the mailbox and wake an idle session on a new message.        |
| `pollMs`       | `10000`                          | Wake poll interval, clamped to `100..600000`.                      |
| `spawnOnSend`  | `false`                          | Create a session in the recipient's directory when sending.        |
| `spawnCooldownMs` | `60000`                       | Minimum gap between spawns.                                        |
| `maxSpawnsPerTurn` | `1`                           | Spawns allowed per human turn, clamped to `0..10`.                 |
| `projectDirs`  | `{}`                             | Explicit `{ "<recipient>": "<directory>" }` map for spawning.      |
| `stateFile`    | `<directory>/.atl/mailbox-state.json` | Persisted dedupe/round state (must stay inside the project). |

## Tiers and identity

Three tiers, keyed to the folder a session opens in. Each tier's `handoffs/` holds its own
`workspace.md` plus one file per immediate child.

| Tier | Folder | Inbox |
|---|---|---|
| **Meta** | `D:\WORKSHOP` | `handoffs/workspace.md` |
| **Account** | `D:\WORKSHOP\mr-wolf-rsh` | `mr-wolf-rsh/handoffs/workspace.md` |
| **Repo** | `.../mr-wolf-rsh/tools/opencode-workspace-mailbox` | `mr-wolf-rsh/handoffs/opencode-workspace-mailbox.md` |

Discovery is derived from the tree, not hardcoded: a directory with `handoffs/` is a tier root
(meta when nothing above has one, account when the parent does); anything else belongs to the
nearest ancestor with `handoffs/`, whatever the bucket depth. The inbox file is created on first
run, and an account session also gets its file at the root.

**Routing:**

- `to: workspace` → this tier's `workspace.md`.
- `to: <account>` (from an account or repo) → the root tier's `<account>.md` — escalate up, or
  lateral between accounts.
- `to: <anything else>` → a sibling/child file in this tier — lateral, or delegate down.

An explicit `mailboxDir` in config pins the mailbox and bypasses discovery (kept for
single-directory setups and tests).

## Storage

Mailboxes sit behind a `MailboxStore` interface — `ensure` / `listOpen` / `read` / `append` /
`ack` / `query`. The file backend is the MVP; the message format and file layout stay the
contract, so a SQLite backend (atomic append, indexed OPEN-by-project, WAL concurrency) can
replace it without touching the tools, the wake path, or spawning. `createFileStore(dir)` is the
reference implementation.


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

## Spawn on send

With `"spawnOnSend": true`, `mailbox_send` also creates a session in the recipient's project
directory (SDK `session.create` with `query.directory`), titled `mailbox: <recipient>`.

**Directory resolution**, in order:

1. `projectDirs[recipient]`, if configured.
2. `workspace` → this tier's own root directory.
3. An account name → that account's directory under the workspace root.
4. A sibling of `mailboxDir` named after the recipient, if it exists.

If none resolves, the send still succeeds (the message is appended) and the tool reports why no
session was created. It never guesses a directory.

**Guards** (why this cannot loop):

- `spawnOnSend` is off by default.
- A session whose title starts with `mailbox:` never spawns — the cascade stops at depth one, and
  the prefix is visible to every plugin instance, not just the one that created it.
- One spawn per message hash, a cooldown, and a per-turn cap.
- No spawn when a session already exists in the recipient directory, or when the recipient is the
  sender's own project.

**What spawning does not do:** it creates a server-side session; it does not attach a terminal
window. The recipient still needs a plugin instance serving that directory for the wake path to
deliver the turn, and a headless session that hits a permission prompt has nobody to answer it.

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
- Max auto-rounds per human turn, restored by an ack or a drained inbox.
- Never react to the plugin's own writes.
- Cooldown between prompts.
- Idempotent ack (already-`DONE` is a no-op, not an error).
- Spawns: opt-in, one per message, cooldown, per-turn cap, no spawn from a `mailbox:` session, and
  no spawn when the recipient already has a session.

## Safety

- **Append-only mailbox.** `mailbox_send` only appends; it never rewrites, reorders, or deletes.
- **Minimal ack diff.** `mailbox_ack` replaces only the status line's content
  (`OPEN (annotations)` → `DONE`). Every other byte — spacing elsewhere, line endings, bodies — is
  preserved, and the tests assert exactly that.
- **Path containment.** Recipients must be lowercase kebab-case and resolved paths must stay inside
  `mailboxDir`; traversal (`..`, separators, absolute paths) is rejected. The state file must
  resolve inside the project directory.
- **Bodies are data.** Message content is never executed, evaluated, or turned into commands.
- **Bounded state.** Only hashes are persisted (last 500) and the file is written atomically.
- **Failure isolation.** Mailbox and toast errors are caught and logged; a broken mailbox never
  takes down the session.

## Limitations

- Delivery needs a plugin instance serving the recipient directory. With no session open there,
  the message waits in the file; `spawnOnSend` creates a session but cannot attach a terminal
  window to it.
- Scoped to one project per plugin instance (no cross-project session activation beyond
  `session.create`); identity is resolved per session, not per config.
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
