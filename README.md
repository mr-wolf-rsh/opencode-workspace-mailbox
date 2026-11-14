# opencode-workspace-mailbox

A per-project handoff mailbox for [OpenCode](https://opencode.ai) sessions.

Every session gets it: a file-based inbox that other sessions write to, automatic delivery when the
session goes idle, and loop guards so an agent can never talk itself into a spin. One global config
serves a whole folder tree — **meta → account → repo** — because the tier is derived from the
directory a session opens in, not from what you remember to configure.

Built for OpenCode today; the storage layer is behind a `MailboxStore` interface, so the file
backend can be swapped for SQLite or Engram — see [Backlog](#backlog).

> Status: the code is complete (81 tests, `typecheck` and `build` green, repo at
> [opencode-workspace-mailbox](https://github.com/mr-wolf-rsh/opencode-workspace-mailbox)).
> It is not yet published to npm — see [Install](#install).

## The metaphor

The mailbox is a **chain of command made of files**. Each tier owns a `handoffs/` folder holding its
own `workspace.md` plus one file per immediate child. Messages only ever move along that ladder:
escalate up, delegate down, or talk to a sibling.

| In an organisation | In opencode-workspace-mailbox |
|---|---|
| The chief of staff | **Meta** tier — `C:\work` reads `handoffs/workspace.md` |
| Account leads | **Account** tier — `acme` reads `acme/handoffs/workspace.md` |
| The team doing the work | **Repo** tier — `<account>/handoffs/<project>.md` |
| Memos, never rewrites | Append-only markdown; history is the audit trail |
| "Received" stamp | `**Status:**` flips `OPEN` → `DONE`, one line, nothing else touched |
| Handing over a task | `mailbox_send({ to: "scraper-service", ... })` |
| Standing instructions | `wake: true` — an idle session picks up new mail within one poll |
| Opening a desk for the recipient | `spawnOnSend: true` — creates a session in the recipient's folder |
| A message that needs a decision | Only then does the agent reply in chat |

Tiers are **discovered from the folder tree**, not configured: a directory with `handoffs/` is a
tier root, and anything under it resolves to its nearest ancestor that has one.

## Why this exists

Multi-repo workspaces talk through asynchronous handoffs: one file per project, append-only,
addressed `from X → to Y`. The protocol works. The human relay does not.

A message sits `OPEN` until somebody opens the right session, reads it, acts on it, and flips it to
`DONE` — and "somebody remembers" is exactly the step that fails. Worse, once you have a parent
strategy session and several implementation repos, the relay has to survive closed sessions,
restarts, and a working day that never lines up.

So this plugin closes the loop **inside the session that receives the message**. No daemon, no
scheduler, no `opencode run` spawning a session per message: if a session is closed, the message
simply waits in its file. When the session is open, the message surfaces on its own.

The file format is the product, not an implementation detail: it is readable, diffable, reviewable
in a PR, greppable, and it survives every process that ever touched it.

## What it does

Delivered as tools the agent calls and two hooks the runtime calls:

- **`mailbox_read`** — list `OPEN` messages for a project (or any routed recipient).
- **`mailbox_send`** — append a message to the recipient's mailbox, optionally spawning a session
  in the recipient's directory.
- **`mailbox_ack`** — flip one message's `**Status:**` line to `DONE`, byte-preserving everywhere
  else.

On `session.idle` (and, with `wake: true`, on a timer) the plugin reads the session's own mailbox,
finds `OPEN` messages it has not handled yet, and prompts the session **once** to deal with them.

### Delivery is automatic when you opt in

`wake: true` makes an already-idle session notice new mail. Without it, the plugin only reacts to an
idle *transition* — which means a session that has been sitting idle all afternoon never learns
about the message your other session just wrote.

### Spawning opens the recipient's desk

`spawnOnSend: true` creates a session in the recipient's project directory when you send to it, so a
project with nothing open can still be reached. Guarded so it cannot ping-pong — see
[Spawn on send](#spawn-on-send).

## Install

1. Add the plugin to your `opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       ["opencode-workspace-mailbox", {
         "wake": true,
         "spawnOnSend": true
       }]
     ]
   }
   ```

   Both flags are off by default: `wake` costs tokens while nobody is watching, and spawning creates
   sessions on its own. Turn them on deliberately.

   Do **not** set `mailboxDir` unless you deliberately want one pinned mailbox: it disables tier
   discovery, which is the whole point of a single global config.

2. If your config directory declares plugin dependencies (some setups keep a `package.json` next to
   `opencode.json`), add the package there too:

   ```powershell
   cd C:\Users\<you>\.config\opencode
   npm install opencode-workspace-mailbox --save
   ```

3. Restart OpenCode.

Local path variant during development (no publish needed — `prepare` builds it):

```powershell
npm install file:C:\work\acme\tools\opencode-workspace-mailbox --save
```

```jsonc
["C:\\work\\acme\\tools\\opencode-workspace-mailbox", { "wake": true }]
```

## Configuration

```jsonc
["opencode-workspace-mailbox", {
  // Master switch. false = the plugin does nothing at all.
  "enabled": true,

  // Pin ONE mailbox directory and disable tier discovery. Leave unset normally.
  "mailboxDir": null,

  // Override the derived identity ("workspace" for a tier root, else the folder name).
  "project": null,

  // Storage backend. "file" is the MVP; the store interface is pluggable.
  "storage": "file",

  // Auto-prompts in a row without progress, then one toast instead. 0..20.
  "maxAutoRounds": 2,

  // Minimum gap between auto-prompts (and between notices).
  "cooldownMs": 30000,

  // Poll the mailbox and wake an idle session on a new message.
  "wake": false,
  "pollMs": 10000,

  // Create a session in the recipient's directory when sending.
  "spawnOnSend": false,
  "spawnCooldownMs": 60000,
  "maxSpawnsPerTurn": 1,

  // Explicit recipient -> directory map for spawning. Discovery covers most trees.
  "projectDirs": {},

  // Where dedupe/round/spawn state is persisted (must stay inside the project directory).
  "stateFile": null
}]
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `mailboxDir` | discovered | Pin a mailbox directory; disables discovery. |
| `project` | resolved | Explicit identity override. |
| `storage` | `file` | Backend selector (`file` implemented). |
| `maxAutoRounds` | `2` | Auto-prompts in a row without progress, `0..20`. |
| `cooldownMs` | `30000` | Gap between auto-prompts and notices. |
| `wake` | `false` | Poll and wake an idle session. |
| `pollMs` | `10000` | Wake poll interval, `100..600000`. |
| `spawnOnSend` | `false` | Create a session in the recipient's directory. |
| `spawnCooldownMs` | `60000` | Gap between spawns. |
| `maxSpawnsPerTurn` | `1` | Spawns per human turn, `0..10`. |
| `projectDirs` | `{}` | Explicit recipient → directory map. |
| `stateFile` | `<dir>/.atl/mailbox-state.json` | Persisted dedupe/round/spawn state. |

## Tiers and identity

| Tier | Folder | Reads at start | Holds |
|---|---|---|---|
| **Meta** | `C:\work` | `handoffs/workspace.md` | `workspace.md` + one file per account |
| **Account** | `C:\work\acme` | `acme/handoffs/workspace.md` | `workspace.md` + one file per repo |
| **Repo** | `.../acme/tools/opencode-workspace-mailbox` | `acme/handoffs/opencode-workspace-mailbox.md` | its own file, at the account level |

Discovery rules, for a session opened in `D`:

1. `project` is set in config → use it verbatim (and `mailboxDir` if set).
2. `D` has `handoffs/` → `D` is a tier root. Parent has one too → **account**, else **meta**.
   Identity is `workspace`; its mailbox is `D/handoffs`.
3. Otherwise → walk up to the nearest ancestor with `handoffs/`; that is the **account**, `D` is a
   **repo**. Identity is `D`'s folder name, kebab-cased, and the mailbox is the account's
   `handoffs/` — so bucket layouts like `<account>/tools/<repo>` work without configuration.

For this workspace:

| Session opened at | Tier | Mailbox |
|---|---|---|
| `C:\work` | meta | `C:\work\handoffs\workspace.md` |
| `C:\work\acme` | account | `C:\work\acme\handoffs\workspace.md` |
| `C:\work\acme\tools\opencode-workspace-mailbox` | repo | `C:\work\acme\handoffs\opencode-workspace-mailbox.md` |
| `C:\work\globex\scraper-service` | repo | `C:\work\globex\handoffs\scraper-service.md` |

### Routing

- **`to: workspace`** → this tier's own `workspace.md`.
- **`to: <account>`** → the root tier's `<account>.md` — escalate up, or lateral between accounts.
- **`to: <anything else>`** — a sibling or child file in this tier: lateral, or delegate down.

The inbox for a tier is created on first run; an account session also creates its file at the root.
Unknown recipients are created on first send. Reads never create files.

## Mailbox format

Files are `<mailboxTier>/handoffs/<project>.md`. Append-only: messages are never rewritten,
reordered, or "tidied". The **only** permitted edit to history is the `**Status:**` line.

```markdown
### YYYY-MM-DD HH:MM — from <source> → to <recipient>
**Status:** OPEN | DONE
**Topic:** one-line subject
Body — what needs attention, the question, exact paths/commits/commands.
```

`mailbox_ack` replaces the status line's content with `DONE`, so an annotated
`**Status:** OPEN (confirm the wording)` becomes `**Status:** DONE`. Every other byte — spacing
elsewhere, line endings, bodies — is unchanged; the tests assert that on CRLF fixtures, and it was
verified by hand against a real 113 KB mailbox file.

## Storage

Mailboxes sit behind a `MailboxStore` interface:

```ts
interface MailboxStore {
  ensure(project: string): string
  listOpen(project: string): MailboxMessage[]
  read(project: string): MailboxMessage[]
  append(project: string, input: AppendInput): SendResult
  ack(project: string, target: { hash?: string; header?: string }): AckResult
  query(project: string, filter?: MailboxFilter): MailboxMessage[]
}
```

`createFileStore(dir)` is the reference backend. The message format and file layout are the contract:
a SQLite backend (atomic append, indexed OPEN-by-project, WAL concurrency) or an Engram-backed store
only has to implement those six operations — the tools, wake path, and spawning never change.

## Loop guards

| Guard | Behaviour |
|---|---|
| Hash dedupe | One prompt per message, persisted across restarts. |
| Own writes | Messages this plugin appended never wake anybody. |
| Round cap | `maxAutoRounds` prompts in a row without progress, then a toast instead. |
| Progress reset | An `mailbox_ack`, or a drained inbox, restores the budget. |
| Cooldown | `cooldownMs` between prompts; one notice per distinct pending set. |
| Idempotent ack | Acking an already-`DONE` message is a no-op, not an error. |
| Spawn guards | Opt-in, one per message hash, cooldown, per-turn cap, never from a spawned session, never when a session already exists. |

## How delivery decides

1. **Trigger** — `session.idle`, or a `wake` poll tick for the most recently active non-busy session.
2. **Skip** — plugin is disabled, this session was just prompted by the plugin, or the session is
   mid-turn.
3. **Filter** — keep `OPEN` messages whose hash is not in `prompted` and not in `ownWrites`.
4. **Budget** — if the inbox is empty, reset the round budget; if the cap or cooldown is hit, stop
   (surfacing a one-line toast at most once per pending set).
5. **Dispatch** — record every hash *before* prompting, then send one prompt: load the
   `workspace-mailbox` skill, read the file, handle the messages, ack them, reply only if a decision
   is needed.

Hashes are recorded before dispatch on purpose: a failed prompt is retried, never silently dropped.

## Spawn on send

With `spawnOnSend: true`, `mailbox_send` also creates a session in the recipient's directory
(`session.create` with `query.directory`), titled `mailbox: <recipient>`.

**Directory resolution**, in order:

1. `projectDirs[recipient]`, if configured.
2. `workspace` → this tier's own root directory.
3. An account name → that account's directory under the workspace root.
4. A sibling of the mailbox directory, or a bounded search for a nested bucket
   (`<account>/tools/<repo>`).

If nothing resolves, the send still succeeds and the tool reports why no session was created. It
never guesses a directory.

**What spawning does not do:** it creates a server-side session; it does not attach a terminal
window. A headless session that hits a permission prompt has nobody to answer it.

## Limitations

- **Delivery needs a plugin instance serving the recipient directory.** With no session there, the
  message waits in its file. `spawnOnSend` creates a session but cannot attach a TUI to it.
- **One project per plugin instance.** Cross-project activation beyond `session.create` is out of
  scope; identity is resolved per session, never shared.
- **`wake` spends tokens with nobody watching**, at the pace messages arrive. Leave it off for
  idle-only delivery.
- **No migration of old layouts.** Pointing the plugin at a mailbox directory that still holds
  pre-hierarchy files leaves them in place; account files appear alongside.
- **Busy detection is event-driven.** If a runtime never emits `session.status`, the wake path can
  queue a prompt behind an active turn instead of waiting.
- **Message bodies are data only.** They are never executed, evaluated, or turned into commands.
- **New recipient files are not registered in the tier's `README.md`.** The plugin writes mailboxes,
  not documentation.

---

## Backlog

Ideas for the future — not implemented yet.

- **SQLite backend** — implement `MailboxStore` over SQLite: atomic append, an index on
  `(project, status)`, WAL for concurrent sessions, and `query` without re-parsing files. The
  interface and the message format already allow it.
- **Engram backend** — reuse the persistent-memory store for teams that want mailboxes outside the
  repo. Same six operations.
- **`to: all` broadcast** — the protocol allows a broadcast copied into every file in a tier; today
  `all` is treated as a normal recipient name.
- **Migration helper** — move legacy top-level files into the tier layout with an explicit,
  reviewable command instead of leaving them behind.
- **Watermark** — a `since` option so a fresh install does not replay a mailbox's entire `OPEN`
  history on first contact.

---

## Development

```bash
npm install
npm test          # vitest: parser, ack byte-identity, send, paths, wake, spawn, tiers, store
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/
```

## Author

- **Renzo S.** — [mr-wolf-rsh](https://github.com/mr-wolf-rsh/)

## Contributing

All sorts of suggestions and pull requests are welcome.

## License

[MIT](./LICENSE)
