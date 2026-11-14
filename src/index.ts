import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs"
import path from "node:path"
import { normalizeConfig, type MailboxConfig, type NormalizedConfig } from "./config.js"
import { discoverTier, routeRecipient, type TierContext } from "./discovery.js"
import { messageHash, normalizeForHash } from "./hash.js"
import {
  type AckRequest,
  type AckResult,
  type ReadResult,
  type SendRequest,
  type SendResult,
} from "./mailbox.js"
import { assertInside, isSafeRecipient, mailboxFile, PathSafetyError, resolveInside } from "./paths.js"
import { isOpen, parseMailbox, type MailboxMessage } from "./parser.js"
import { buildCapNotice, buildDeliveryPrompt, buildIdlePrompt } from "./prompt.js"
import { emptyState, StateStore, type MailboxState, type SessionState } from "./state.js"
import { createFileStore, type MailboxStore } from "./store.js"
import { createSqliteStore } from "./sqlite-store.js"
import { exportStoreIntoFile, importFileIntoStore, missingMessages, statusUpdates } from "./migrate.js"

/**
 * opencode-workspace-mailbox plugin entry — makes a session aware of its per-project
 * mailbox and auto-handles OPEN messages on idle, with loop guards.
 *
 * On the `session.idle` event we read the project's mailbox file, find OPEN
 * messages we have not yet prompted for (and did not write ourselves), and —
 * subject to a per-human-turn round cap and a cooldown — dispatch a single
 * prompt asking the agent to handle them. The message is appended-only; the
 * only permitted edit is flipping a `**Status:**` line to DONE via the
 * `mailbox_ack` tool.
 */
export const server: Plugin = async (input, options) => {
  const cfg: NormalizedConfig = normalizeConfig(options, input.directory)
  const store = new StateStore(cfg.stateFile)
  const { client } = input

  // Tier is derived from the folder tree unless the config pins a mailboxDir.
  const tier: TierContext = cfg.explicitMailboxDir
    ? discoverTier(input.directory, { mailboxDir: cfg.mailboxDir, project: cfg.project })
    : discoverTier(input.directory)

  // One store per backend + directory; the backend is swappable behind MailboxStore.
  const stores = new Map<string, Promise<MailboxStore>>()

  /** Database file for a directory: an explicit sqlitePath only pins the primary mailbox. */
  function databaseFileFor(dir: string): string {
    const resolved = path.resolve(dir)
    if (cfg.sqlitePath && resolved === path.resolve(tier.mailboxDir)) return cfg.sqlitePath
    return path.join(resolved, ".mailbox.db")
  }

  function storeForBackend(
    kind: "file" | "sqlite",
    dir: string,
    options: { autoImport?: boolean } = {},
  ): Promise<MailboxStore> {
    const resolved = path.resolve(dir)
    const autoImport = options.autoImport ?? true
    const cacheKey = `${kind}:${resolved}:${autoImport}`
    let found = stores.get(cacheKey)
    if (!found) {
      found =
        kind === "sqlite"
          ? createSqliteStore(databaseFileFor(resolved), {
              legacyDir: resolved,
              mirror: cfg.sqliteMirror,
              autoImport,
            })
          : Promise.resolve(createFileStore(resolved))
      stores.set(cacheKey, found)
    }
    return found
  }

  const storeFor = (dir: string): Promise<MailboxStore> => storeForBackend(cfg.storage, dir)
  const own = (): Promise<MailboxStore> => storeFor(tier.mailboxDir)

  // Dynamic discovery creates the inboxes a tier is supposed to have.
  try {
    const ownStore = await own()
    ownStore.ensure(tier.project)
    if (tier.tier === "account" && tier.rootMailboxDir && tier.accountName) {
      const rootStore = await storeFor(tier.rootMailboxDir)
      rootStore.ensure(tier.accountName)
    }
  } catch (error) {
    console.error(`[opencode-workspace-mailbox] inbox bootstrap failed: ${String(error)}`)
  }

  const MAX_ENTRIES = 500
  /**
   * How long a plugin-dispatched prompt stays "pending" while waiting for its
   * own `chat.message` echo. A prompt that never arrives must not suppress the
   * idle handler forever.
   */
  const PENDING_TTL_MS = 120_000

  const pendingPluginPrompts = new Map<string, { count: number; at: number }>()

  function pendingCount(sessionID: string): number {
    const entry = pendingPluginPrompts.get(sessionID)
    if (!entry) return 0
    if (Date.now() - entry.at > PENDING_TTL_MS) {
      pendingPluginPrompts.delete(sessionID)
      return 0
    }
    return entry.count
  }

  function recordHashes(list: string[], hashes: string[]): void {
    for (const hash of hashes) {
      if (!list.includes(hash)) list.push(hash)
    }
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  }

  function dispatchPrompt(sessionID: string, text: string): void {
    pendingPluginPrompts.set(sessionID, { count: pendingCount(sessionID) + 1, at: Date.now() })
    const body = { parts: [{ type: "text" as const, text }] }
    const promise = client.session.promptAsync
      ? client.session.promptAsync({ path: { id: sessionID }, body })
      : client.session.prompt({ path: { id: sessionID }, body })
    promise.catch((error) => {
      const remaining = pendingCount(sessionID)
      if (remaining > 0) pendingPluginPrompts.set(sessionID, { count: remaining - 1, at: Date.now() })
      console.error(`[opencode-workspace-mailbox] prompt dispatch failed: ${String(error)}`)
    })
  }

  function notify(sessionID: string, message: string): void {
    try {
      const promise = client.tui.showToast({ body: { message, variant: "info" } })
      promise.catch(() => {})
    } catch {
      // best-effort; never break the session over a toast
    }
  }

  // ---------------------------------------------------------------------------
  // Session registry: the wake path needs a session ID to prompt, and Events
  // alone do not guarantee one for a session that never had a turn.
  // ---------------------------------------------------------------------------
  type SessionTrack = { lastSeen: number; busy: boolean; title?: string }
  const sessions = new Map<string, SessionTrack>()

  /** Prefix applied to every session this plugin creates, so other instances can spot it. */
  const SPAWN_TITLE_PREFIX = "mailbox:"

  function track(sessionID: string, busy?: boolean, title?: string): void {
    if (!sessionID) return
    const entry = sessions.get(sessionID) ?? { lastSeen: 0, busy: false }
    entry.lastSeen = Date.now()
    if (busy !== undefined) entry.busy = busy
    if (title) entry.title = title
    sessions.set(sessionID, entry)
  }

  function restoreBudget(sessionID: string): void {
    const state = store.read()
    const session = state.sessions[sessionID] ?? { autoRounds: 0, lastPromptAt: 0 }
    session.autoRounds = 0
    session.noticeKey = undefined
    state.sessions[sessionID] = session
    store.write(state)
  }

  /**
   * Shared decision path for both triggers: the idle transition and the poll
   * timer. `poll` additionally refuses to interrupt a busy session.
   */
  async function consider(sessionID: string, source: "idle" | "poll"): Promise<void> {
    if (!cfg.enabled) return
    if (pendingCount(sessionID) > 0) return
    if (source === "poll" && sessions.get(sessionID)?.busy) return

    const open = (await own()).listOpen(tier.project)
    const state = store.read()
    const session = state.sessions[sessionID] ?? { autoRounds: 0, lastPromptAt: 0 }

    if (open.length === 0) {
      // Inbox drained — a later delivery starts with a full budget.
      if (session.autoRounds !== 0 || session.noticeKey !== undefined) {
        session.autoRounds = 0
        session.noticeKey = undefined
        state.sessions[sessionID] = session
        store.write(state)
      }
      return
    }

    const fresh = open.filter(
      (m) => !state.prompted.includes(m.hash) && !state.ownWrites.includes(m.hash),
    )
    if (fresh.length === 0) return

    if (session.autoRounds >= cfg.maxAutoRounds) {
      // One notice per distinct pending set: repeated triggers must not turn
      // into a toast loop.
      const noticeKey = fresh
        .map((m) => m.hash)
        .sort()
        .join(",")
      if (session.noticeKey === noticeKey) return
      const now = Date.now()
      if (session.noticeKey !== undefined && now - (session.lastNoticeAt ?? 0) < cfg.cooldownMs) return
      session.noticeKey = noticeKey
      session.lastNoticeAt = now
      state.sessions[sessionID] = session
      store.write(state)
      notify(sessionID, buildCapNotice(tier.project, fresh.length, cfg.maxAutoRounds))
      return
    }

    if (Date.now() - session.lastPromptAt < cfg.cooldownMs) return

    recordHashes(state.prompted, fresh.map((m) => m.hash))
    session.autoRounds += 1
    session.lastPromptAt = Date.now()
    session.noticeKey = undefined
    state.sessions[sessionID] = session
    store.write(state)
    dispatchPrompt(
      sessionID,
      buildIdlePrompt(
        tier.project,
        fresh,
        cfg.storage === "sqlite" && !cfg.sqliteMirror
          ? `call \`mailbox_read\` for ${tier.project}`
          : `read \`${mailboxFile(tier.mailboxDir, tier.project)}\``,
      ),
    )
  }

  /** The most recently active session that is not mid-turn, if any. */
  function wakeTarget(): string | undefined {
    let best: { id: string; at: number } | undefined
    for (const [id, entry] of sessions) {
      if (entry.busy) continue
      if (!best || entry.lastSeen > best.at) best = { id, at: entry.lastSeen }
    }
    return best?.id
  }

  let polling = false

  async function poll(): Promise<void> {
    if (!cfg.enabled || polling) return
    const sessionID = wakeTarget()
    if (!sessionID) return
    polling = true
    try {
      await consider(sessionID, "poll")
    } catch (error) {
      console.error(`[opencode-workspace-mailbox] poll error: ${String(error)}`)
    } finally {
      polling = false
    }
  }

  // Opt-in wake path: an idle transition only fires on a *change*, so a session
  // that is already idle would never notice a message written by another
  // project. The timer makes delivery independent of session transitions.
  let timer: ReturnType<typeof setInterval> | undefined
  if (cfg.wake) {
    timer = setInterval(() => {
      void poll()
    }, cfg.pollMs)
    timer.unref?.()
  }

  function sameDirectory(candidate: string | undefined): boolean {
    if (!candidate) return false
    const rel = path.relative(path.resolve(input.directory), path.resolve(candidate))
    return rel === ""
  }

  /**
   * A resumed session emits no creation event, so seed the registry from the
   * server once at startup. `lastSeen` uses each session's own update time, so a
   * stale session can never outrank one that is actually in use.
   */
  async function seedSessions(): Promise<void> {
    if (!cfg.wake) return
    try {
      const result = await client.session.list({ query: { directory: input.directory } })
      const list = (result as {
        data?: Array<{ id?: string; directory?: string; parentID?: string; title?: string; time?: { updated?: number } }>
      }).data
      for (const entry of list ?? []) {
        if (!entry?.id || entry.parentID || !sameDirectory(entry.directory)) continue
        if (sessions.has(entry.id)) continue
        sessions.set(entry.id, { lastSeen: entry.time?.updated ?? 0, busy: false, title: entry.title })
      }
    } catch {
      // Session registry unavailable — chat.message and idle events still
      // register sessions as they are used.
    }
  }

  void seedSessions()

  /**
   * Recipient directory for spawn-on-send: an explicit `projectDirs` entry first,
   * then the workspace root itself for `workspace`, then a sibling of `mailboxDir`.
   * Anything unresolvable is a documented no-op, never a guess.
   */
  /** Bounded search for a child directory by basename (buckets like `tools/<repo>`). */
  function findChildDir(root: string, name: string, depth = 3): string | undefined {
    if (!existsSync(root)) return undefined
    const target = name.toLowerCase()
    const skip = new Set(["node_modules", "dist", "build", "bin", "obj", "target", "out"])
    const queue: Array<{ dir: string; level: number }> = [{ dir: root, level: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.level > 0 && path.basename(current.dir).toLowerCase() === target) return current.dir
      if (current.level >= depth) continue
      let entries: Dirent[]
      try {
        entries = readdirSync(current.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith(".") || skip.has(entry.name.toLowerCase())) continue
        queue.push({ dir: path.join(current.dir, entry.name), level: current.level + 1 })
      }
    }
    return undefined
  }

  function resolveProjectDir(to: string): string | undefined {
    const mapped = cfg.projectDirs[to]
    if (mapped) return mapped
    const tierRoot = path.dirname(path.resolve(tier.mailboxDir))
    if (to === "workspace") return existsSync(tierRoot) ? tierRoot : undefined
    // Escalating to an account spawns that account's directory, not a sibling file.
    if (tier.rootDir && to !== tier.project) {
      const account = path.join(tier.rootDir, to)
      if (existsSync(account)) return account
    }
    const sibling = path.join(tierRoot, to)
    if (existsSync(sibling)) return sibling
    // Bucket layouts: `<account>/tools/<repo>`, `<account>/labs/<repo>`, ...
    return findChildDir(tierRoot, to)
  }

  async function findSession(directory: string): Promise<string | undefined> {
    try {
      const result = await client.session.list({ query: { directory } })
      const list = (result as {
        data?: Array<{ id?: string; directory?: string; parentID?: string; time?: { updated?: number } }>
      }).data ?? []
      const wanted = path.resolve(directory)
      const candidates = list.filter(
        (entry) =>
          entry.id &&
          entry.directory &&
          !entry.parentID &&
          path.relative(wanted, path.resolve(entry.directory)) === "",
      )
      if (candidates.length === 0) return undefined
      candidates.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      return candidates[0].id
    } catch {
      return undefined
    }
  }

  type DeliverOutcome = { delivered: boolean; created: boolean; detail: string }

  /** Start a turn in a session that lives in another directory (sender-driven delivery). */
  function dispatchDelivery(targetID: string, directory: string, text: string): void {
    const body = { parts: [{ type: "text" as const, text }] }
    const params = { path: { id: targetID }, query: { directory }, body }
    try {
      const promise = client.session.promptAsync
        ? client.session.promptAsync(params)
        : client.session.prompt(params)
      promise.catch((error: unknown) => {
        console.error(`[opencode-workspace-mailbox] delivery prompt failed: ${String(error)}`)
      })
    } catch (error) {
      console.error(`[opencode-workspace-mailbox] delivery prompt failed: ${String(error)}`)
    }
  }

  /**
   * Deliver a just-sent message into the recipient's session.
   *
   * Modes: `off` does nothing; `reuse` prompts an existing session and never
   * creates one; `spawn` always creates a fresh session and prompts it; `auto`
   * reuses when one exists, otherwise creates, then prompts either way.
   *
   * Guards, in order: enabled mode, self-send, cascade (a session this plugin
   * spawned never delivers), duplicate message, cooldown, per-turn cap, then
   * directory resolution.
   */
  async function maybeDeliver(
    sessionID: string,
    to: string,
    hash: string,
    topic: string,
  ): Promise<DeliverOutcome> {
    const mode = cfg.deliverOnSend
    if (mode === "off") return { delivered: false, created: false, detail: "deliverOnSend is off" }
    if (to === tier.project) {
      return { delivered: false, created: false, detail: "recipient is this project" }
    }

    const state = store.read()
    const currentTitle = sessions.get(sessionID)?.title
    if (currentTitle?.startsWith(SPAWN_TITLE_PREFIX) || state.spawnedSessions.includes(sessionID)) {
      return { delivered: false, created: false, detail: "loop guard: this session was spawned" }
    }
    if (state.spawnedHashes.includes(hash)) {
      return { delivered: false, created: false, detail: "already delivered for this message" }
    }

    const now = Date.now()
    if (now - (state.lastSpawnAt ?? 0) < cfg.spawnCooldownMs) {
      return { delivered: false, created: false, detail: `spawn cooldown (${cfg.spawnCooldownMs} ms)` }
    }
    const session = state.sessions[sessionID] ?? { autoRounds: 0, lastPromptAt: 0 }
    if ((session.spawnsThisTurn ?? 0) >= cfg.maxSpawnsPerTurn) {
      return { delivered: false, created: false, detail: `max ${cfg.maxSpawnsPerTurn} spawn(s) per turn reached` }
    }

    const directory = resolveProjectDir(to)
    if (!directory) {
      return { delivered: false, created: false, detail: `no directory known for "${to}" (set projectDirs)` }
    }

    let targetID = mode === "spawn" ? undefined : await findSession(directory)
    if (!targetID && mode === "reuse") {
      return { delivered: false, created: false, detail: `no session to reuse in ${directory}` }
    }

    let createdID: string | undefined
    if (!targetID) {
      try {
        const created = await client.session.create({
          query: { directory },
          body: { title: `${SPAWN_TITLE_PREFIX} ${to}` },
        })
        targetID = (created as { data?: { id?: string } }).data?.id
        if (!targetID) return { delivered: false, created: false, detail: "session.create returned no id" }
        createdID = targetID
        track(targetID, false, `${SPAWN_TITLE_PREFIX} ${to}`)
      } catch (error) {
        return { delivered: false, created: false, detail: `session.create failed: ${String(error)}` }
      }
    }

    const route = routeRecipient(to, tier)
    const mailboxPath = mailboxFile(route.mailboxDir, route.project)
    const readInstruction =
      cfg.storage === "sqlite" && !cfg.sqliteMirror
        ? `call \`mailbox_read\` for ${to}`
        : `read \`${mailboxPath}\``
    dispatchDelivery(
      targetID,
      directory,
      buildDeliveryPrompt(tier.project, to, topic, readInstruction),
    )

    session.spawnsThisTurn = (session.spawnsThisTurn ?? 0) + 1
    state.sessions[sessionID] = session
    state.lastSpawnAt = now
    if (createdID) recordHashes(state.spawnedSessions, [createdID])
    recordHashes(state.spawnedHashes, [hash])
    store.write(state)

    const verb = createdID ? "spawned" : "reused"
    return { delivered: true, created: createdID !== undefined, detail: `${verb} session ${targetID} in ${directory}` }
  }

  return {
    event: async ({ event }) => {
      if (!cfg.enabled) return
      try {
        if (event.type === "session.idle") {
          track(event.properties.sessionID, false)
          await consider(event.properties.sessionID, "idle")
          return
        }
        if (event.type === "session.status") {
          track(event.properties.sessionID, event.properties.status.type !== "idle")
          return
        }
        if (event.type === "session.created" || event.type === "session.updated") {
          const info = (event.properties as { info?: { id?: string; directory?: string; parentID?: string; title?: string } }).info
          if (info?.id && !info.parentID && sameDirectory(info.directory)) track(info.id, undefined, info.title)
        }
      } catch (error) {
        console.error(`[opencode-workspace-mailbox] event handler error: ${String(error)}`)
      }
    },

    dispose: async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      for (const pending of stores.values()) {
        try {
          const opened = await pending
          opened.close?.()
        } catch {
          // a store that failed to open has nothing to close
        }
      }
      stores.clear()
    },

    "chat.message": async ({ sessionID }) => {
      try {
        track(sessionID)
        const count = pendingCount(sessionID)
        if (count > 0) {
          pendingPluginPrompts.set(sessionID, { count: count - 1, at: Date.now() })
          return
        }
        const state = store.read()
        state.sessions[sessionID] = { autoRounds: 0, lastPromptAt: 0 }
        store.write(state)
      } catch (error) {
        console.error(`[opencode-workspace-mailbox] chat.message handler error: ${String(error)}`)
      }
    },

    tool: {
      mailbox_read: tool({
        description:
          "Read the OPEN mailbox messages for a project. Returns each message's header, hash, " +
          "topic, and body so the agent can decide how to handle them. Pass a `project` to read a " +
          "different recipient, or omit it to read the current project.",
        args: {
          project: tool.schema
            .string()
            .optional()
            .describe("Project/recipient name (lowercase kebab-case). Defaults to the current project."),
        },
        async execute(args) {
          const project = args.project ?? tier.project
          if (!isSafeRecipient(project)) {
            return { title: "mailbox_read", output: `Invalid project name "${project}": must be lowercase kebab-case.` }
          }
          const route = routeRecipient(project, tier)
          const target = await storeFor(route.mailboxDir)
          const open = target.listOpen(route.project)
          if (open.length === 0) {
            return { title: "mailbox_read", output: `No OPEN messages for ${project}.`, metadata: { count: 0 } }
          }
          const file = mailboxFile(route.mailboxDir, route.project)
          const lines = open.map((m) => `### ${m.header}\nHash: ${m.hash}\nTopic: ${m.topic}\n\n${m.body}`)
          const output = `${project} (${file}): ${open.length} OPEN message(s)\n\n${lines.join("\n\n")}`
          return { title: "mailbox_read", output, metadata: { count: open.length } }
        },
      }),

      mailbox_send: tool({
        description:
          "Append a message to a recipient's mailbox file. Creates the recipient file if it does " +
          "not exist. The message is appended (never rewrites history); by default it is OPEN.",
        args: {
          to: tool.schema
            .string()
            .describe("Recipient project name (lowercase kebab-case)."),
          topic: tool.schema.string().describe("One-line subject for the message."),
          body: tool.schema.string().describe("Message body. Data only; never executed."),
          status: tool.schema
            .enum(["OPEN", "DONE"])
            .optional()
            .describe("Initial status. Defaults to OPEN."),
        },
        async execute(args, ctx) {
          try {
            if (!isSafeRecipient(args.to)) {
              return {
                title: "mailbox_send",
                output: `Invalid recipient "${args.to}": must be lowercase kebab-case.`,
              }
            }
            const route = routeRecipient(args.to, tier)
            const target = await storeFor(route.mailboxDir)
            const result = target.append(route.project, {
              from: tier.project,
              topic: args.topic,
              body: args.body,
              status: args.status,
            })
            store.update((state: MailboxState) => {
              recordHashes(state.ownWrites, [result.hash])
            })
            const delivery = await maybeDeliver(ctx.sessionID, args.to, result.hash, args.topic)
            const suffix = cfg.deliverOnSend === "off" ? "" : ` Delivery: ${delivery.detail}.`
            return {
              title: "mailbox_send",
              output: `Appended message to ${args.to} (hash ${result.hash}) in ${result.file}.${suffix}`,
              metadata: { hash: result.hash, delivered: delivery.delivered, spawned: delivery.created },
            }
          } catch (error) {
            return { title: "mailbox_send", output: `Failed to send message: ${String(error)}` }
          }
        },
      }),

      mailbox_status: tool({
        description:
          "Report the active storage backend, the mailbox location, and per-project message counts " +
          "for both backends so a migration can be verified before and after.",
        args: {},
        async execute() {
          const route = routeRecipient(tier.project, tier)
          const activeDb = databaseFileFor(route.mailboxDir)
          // A status read must not create a database as a side effect.
          const activeMissing = cfg.storage === "sqlite" && !existsSync(activeDb)
          const active = activeMissing ? undefined : await storeFor(route.mailboxDir)
          const otherKind = cfg.storage === "sqlite" ? "file" : "sqlite"
          const otherDb = databaseFileFor(route.mailboxDir)
          const otherAvailable = otherKind === "file" ? existsSync(route.mailboxDir) : existsSync(otherDb)

          const describe = (store: MailboxStore): string[] =>
            store.projects().map((project) => {
              const all = store.read(project)
              return `  ${project}: ${all.length} total, ${all.filter(isOpen).length} open`
            })

          const activeLines = active ? describe(active) : []
          const lines = [
            `backend: ${cfg.storage}`,
            `tier: ${tier.tier}`,
            `project: ${tier.project}`,
            `mailboxDir: ${route.mailboxDir}`,
            `active (${cfg.storage}):`,
            ...(active
              ? activeLines.length > 0
                ? activeLines
                : ["  (empty)"]
              : [`  (not created yet: ${activeDb})`]),
            `other (${otherKind}):`,
          ]
          if (!otherAvailable) {
            lines.push("  (not created yet)")
          } else {
            const other = await storeForBackend(otherKind, route.mailboxDir)
            const otherLines = describe(other)
            lines.push(...(otherLines.length > 0 ? otherLines : ["  (empty)"]))
          }
          return { title: "mailbox_status", output: lines.join("\n") }
        },
      }),

      mailbox_migrate: tool({
        description:
          "Copy every message between storage backends, idempotently (hash-keyed). `to: \"sqlite\"` " +
          "imports the markdown files; `to: \"file\"` exports the database rows. Safe to re-run. " +
          "It does not change the configured `storage`; set that afterwards.",
        args: {
          to: tool.schema
            .enum(["file", "sqlite"])
            .describe("Target backend to copy the messages into."),
          project: tool.schema
            .string()
            .optional()
            .describe("Limit to one project. Defaults to every project found."),
          dryRun: tool.schema
            .boolean()
            .optional()
            .describe("Report what would change without writing anything."),
        },
        async execute(args) {
          const targetKind = args.to
          const sourceKind = targetKind === "sqlite" ? "file" : "sqlite"
          const dbFile = databaseFileFor(tier.mailboxDir)

          // A dry run must not create the target: a missing database is simply empty.
          if (args.dryRun && sourceKind === "sqlite" && !existsSync(dbFile)) {
            return {
              title: "mailbox_migrate",
              output: `No sqlite database at ${dbFile}; nothing to migrate to file.`,
              metadata: { from: sourceKind, to: targetKind, projects: 0 },
            }
          }
          if (args.dryRun && targetKind === "sqlite" && !existsSync(dbFile)) {
            // Import from markdown can still be planned: target is empty.
          }

          const source = await storeForBackend(sourceKind, tier.mailboxDir, { autoImport: false })
          const targetExists = targetKind === "file" ? existsSync(tier.mailboxDir) : existsSync(dbFile)
          const target =
            targetExists || !args.dryRun
              ? await storeForBackend(targetKind, tier.mailboxDir, { autoImport: false })
              : undefined

          const known = new Set<string>([tier.project, ...source.projects()])
          for (const project of target?.projects() ?? []) known.add(project)
          const projects = args.project ? [args.project] : Array.from(known)

          const reports: string[] = []
          for (const project of projects) {
            if (!isSafeRecipient(project)) {
              reports.push(`${project}: invalid project name, skipped`)
              continue
            }
            const file = mailboxFile(tier.mailboxDir, project)

            if (args.dryRun) {
              const from =
                targetKind === "sqlite"
                  ? existsSync(file)
                    ? parseMailbox(readFileSync(file, "utf8"))
                    : []
                  : source.read(project)
              const into = target?.read(project) ?? []
              reports.push(
                `${project}: would add ${missingMessages(from, into).length}, would ack ${statusUpdates(from, into).length}`,
              )
              continue
            }

            const report =
              targetKind === "sqlite"
                ? importFileIntoStore(project, file, target!)
                : exportStoreIntoFile(project, file, source)
            reports.push(`${project}: added ${report.added}, acked ${report.acked}`)
          }

          return {
            title: "mailbox_migrate",
            output:
              `Migrating ${sourceKind} -> ${targetKind} in ${tier.mailboxDir}\n` +
              reports.join("\n") +
              `\nSet "storage": "${targetKind}" in the plugin options to use it.`,
            metadata: { from: sourceKind, to: targetKind, projects: projects.length },
          }
        },
      }),

      mailbox_ack: tool({
        description:
          "Flip a message's `**Status:**` line to DONE. Identify the message by exactly one of " +
          "`hash` or `header`. Only that line is edited; every other byte is preserved.",
        args: {
          project: tool.schema
            .string()
            .optional()
            .describe("Project/recipient name (lowercase kebab-case). Defaults to the current project."),
          hash: tool.schema.string().optional().describe("Stable message hash to ack."),
          header: tool.schema.string().optional().describe("Message header line to ack (case-insensitive)."),
        },
        async execute(args, ctx) {
          const project = args.project ?? tier.project
          if (!isSafeRecipient(project)) {
            return { title: "mailbox_ack", output: `Invalid project name "${project}": must be lowercase kebab-case.` }
          }
          const route = routeRecipient(project, tier)
          const result = (await storeFor(route.mailboxDir)).ack(route.project, {
            hash: args.hash,
            header: args.header,
          })
          // An ack is progress: it restores the auto-handling budget so a
          // backlog can drain one message per wake instead of stalling at the cap.
          if (result.changed) {
            try {
              restoreBudget(ctx.sessionID)
            } catch {
              // budget state is best-effort; the ack already succeeded
            }
          }
          switch (result.reason) {
            case "not-found":
              return { title: "mailbox_ack", output: `No matching message found in ${project}.` }
            case "already-done":
              return { title: "mailbox_ack", output: `Message already DONE in ${project}.` }
            case "ambiguous":
              return { title: "mailbox_ack", output: `Ambiguous match in ${project}; provide a \`hash\`.` }
            case "missing-args":
              return { title: "mailbox_ack", output: "Provide exactly one of `hash` or `header`." }
            default:
              return {
                title: "mailbox_ack",
                output: `Marked message DONE in ${project}${result.message ? ` (${result.message.header})` : ""}.`,
              }
          }
        },
      }),
    },
  }
}

export {
  normalizeConfig,
  parseMailbox,
  isOpen,
  messageHash,
  normalizeForHash,
  isSafeRecipient,
  resolveInside,
  assertInside,
  mailboxFile,
  PathSafetyError,
  emptyState,
  StateStore,
  buildIdlePrompt,
  buildCapNotice,
  discoverTier,
  routeRecipient,
  createFileStore,
}
export type {
  NormalizedConfig,
  MailboxConfig,
  MailboxMessage,
  SendRequest,
  SendResult,
  ReadResult,
  AckRequest,
  AckResult,
  SessionState,
  MailboxState,
  TierContext,
  MailboxStore,
}

export default {
  id: "opencode-workspace-mailbox",
  server,
}
