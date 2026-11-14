import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import path from "node:path"
import { normalizeConfig, type MailboxConfig, type NormalizedConfig } from "./config.js"
import { messageHash, normalizeForHash } from "./hash.js"
import {
  ackMessage,
  readMailbox,
  sendMessage,
  type AckRequest,
  type AckResult,
  type ReadResult,
  type SendRequest,
  type SendResult,
} from "./mailbox.js"
import { assertInside, isSafeRecipient, mailboxFile, PathSafetyError, resolveInside } from "./paths.js"
import { isOpen, parseMailbox, type MailboxMessage } from "./parser.js"
import { buildCapNotice, buildIdlePrompt } from "./prompt.js"
import { emptyState, StateStore, type MailboxState, type SessionState } from "./state.js"

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

    const file = mailboxFile(cfg.mailboxDir, cfg.project)
    const { open } = readMailbox(file)
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
      notify(sessionID, buildCapNotice(cfg.project, fresh.length, cfg.maxAutoRounds))
      return
    }

    if (Date.now() - session.lastPromptAt < cfg.cooldownMs) return

    recordHashes(state.prompted, fresh.map((m) => m.hash))
    session.autoRounds += 1
    session.lastPromptAt = Date.now()
    session.noticeKey = undefined
    state.sessions[sessionID] = session
    store.write(state)
    dispatchPrompt(sessionID, buildIdlePrompt(cfg.project, fresh))
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

  async function poll(): Promise<void> {
    if (!cfg.enabled) return
    const sessionID = wakeTarget()
    if (!sessionID) return
    try {
      await consider(sessionID, "poll")
    } catch (error) {
      console.error(`[opencode-workspace-mailbox] poll error: ${String(error)}`)
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
        data?: Array<{ id?: string; directory?: string; title?: string; time?: { updated?: number } }>
      }).data
      for (const entry of list ?? []) {
        if (!entry?.id || !sameDirectory(entry.directory)) continue
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
  function resolveProjectDir(to: string): string | undefined {
    const mapped = cfg.projectDirs[to]
    if (mapped) return mapped
    const root = path.dirname(path.resolve(cfg.mailboxDir))
    if (to === "workspace") return existsSync(root) ? root : undefined
    const sibling = path.join(root, to)
    return existsSync(sibling) ? sibling : undefined
  }

  async function findSession(directory: string): Promise<string | undefined> {
    try {
      const result = await client.session.list({ query: { directory } })
      const list = (result as {
        data?: Array<{ id?: string; directory?: string; time?: { updated?: number } }>
      }).data ?? []
      const wanted = path.resolve(directory)
      const candidates = list.filter(
        (entry) => entry.id && entry.directory && path.relative(wanted, path.resolve(entry.directory)) === "",
      )
      if (candidates.length === 0) return undefined
      candidates.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      return candidates[0].id
    } catch {
      return undefined
    }
  }

  type SpawnOutcome = { spawned: boolean; detail: string }

  /**
   * Create a session in the recipient's directory. Guards, in order: feature
   * flag, self-send, cascade (a session this plugin spawned never spawns),
   * duplicate message, cooldown, per-turn cap, then directory resolution.
   */
  async function maybeSpawn(sessionID: string, to: string, hash: string): Promise<SpawnOutcome> {
    if (!cfg.spawnOnSend) return { spawned: false, detail: "spawnOnSend is off" }
    if (to === cfg.project) return { spawned: false, detail: "recipient is this project" }

    const state = store.read()
    const currentTitle = sessions.get(sessionID)?.title
    if (currentTitle?.startsWith(SPAWN_TITLE_PREFIX) || state.spawnedSessions.includes(sessionID)) {
      return { spawned: false, detail: "loop guard: this session was spawned" }
    }
    if (state.spawnedHashes.includes(hash)) {
      return { spawned: false, detail: "already spawned for this message" }
    }

    const now = Date.now()
    if (now - (state.lastSpawnAt ?? 0) < cfg.spawnCooldownMs) {
      return { spawned: false, detail: `spawn cooldown (${cfg.spawnCooldownMs} ms)` }
    }
    const session = state.sessions[sessionID] ?? { autoRounds: 0, lastPromptAt: 0 }
    if ((session.spawnsThisTurn ?? 0) >= cfg.maxSpawnsPerTurn) {
      return { spawned: false, detail: `max ${cfg.maxSpawnsPerTurn} spawn(s) per turn reached` }
    }

    const directory = resolveProjectDir(to)
    if (!directory) {
      return { spawned: false, detail: `no directory known for "${to}" (set projectDirs)` }
    }

    const existing = await findSession(directory)
    if (existing) return { spawned: false, detail: `session already exists (${existing})` }

    try {
      const created = await client.session.create({
        query: { directory },
        body: { title: `${SPAWN_TITLE_PREFIX} ${to}` },
      })
      const id = (created as { data?: { id?: string } }).data?.id
      if (!id) return { spawned: false, detail: "session.create returned no id" }

      session.spawnsThisTurn = (session.spawnsThisTurn ?? 0) + 1
      state.sessions[sessionID] = session
      state.lastSpawnAt = now
      recordHashes(state.spawnedSessions, [id])
      recordHashes(state.spawnedHashes, [hash])
      store.write(state)
      track(id, false, `${SPAWN_TITLE_PREFIX} ${to}`)
      return { spawned: true, detail: `spawned session ${id} in ${directory}` }
    } catch (error) {
      return { spawned: false, detail: `session.create failed: ${String(error)}` }
    }
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
          const info = (event.properties as { info?: { id?: string; directory?: string; title?: string } }).info
          if (info?.id && sameDirectory(info.directory)) track(info.id, undefined, info.title)
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
          const project = args.project ?? cfg.project
          if (!isSafeRecipient(project)) {
            return { title: "mailbox_read", output: `Invalid project name "${project}": must be lowercase kebab-case.` }
          }
          const file = mailboxFile(cfg.mailboxDir, project)
          const { exists, open } = readMailbox(file)
          if (!exists || open.length === 0) {
            return { title: "mailbox_read", output: `No OPEN messages for ${project}.`, metadata: { count: 0 } }
          }
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
            const result = sendMessage({
              mailboxDir: cfg.mailboxDir,
              to: args.to,
              from: cfg.project,
              topic: args.topic,
              body: args.body,
              status: args.status,
            })
            store.update((state: MailboxState) => {
              recordHashes(state.ownWrites, [result.hash])
            })
            const spawn = await maybeSpawn(ctx.sessionID, args.to, result.hash)
            const suffix = cfg.spawnOnSend ? ` Spawn: ${spawn.detail}.` : ""
            return {
              title: "mailbox_send",
              output: `Appended message to ${args.to} (hash ${result.hash}) in ${result.file}.${suffix}`,
              metadata: { hash: result.hash, spawned: spawn.spawned },
            }
          } catch (error) {
            return { title: "mailbox_send", output: `Failed to send message: ${String(error)}` }
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
          const project = args.project ?? cfg.project
          if (!isSafeRecipient(project)) {
            return { title: "mailbox_ack", output: `Invalid project name "${project}": must be lowercase kebab-case.` }
          }
          const file = mailboxFile(cfg.mailboxDir, project)
          const result = ackMessage({ file, hash: args.hash, header: args.header })
          // An ack is progress: it restores the auto-handling budget so a
          // backlog can drain one message per wake instead of stalling at the cap.
          if (result.changed) restoreBudget(ctx.sessionID)
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
  sendMessage,
  readMailbox,
  ackMessage,
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
}

export default {
  id: "opencode-workspace-mailbox",
  server,
}
