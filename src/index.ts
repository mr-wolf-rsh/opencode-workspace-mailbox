import { tool, type Plugin } from "@opencode-ai/plugin"
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
 * opencode-mailbox plugin entry — makes a session aware of its per-project
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
      console.error(`[opencode-mailbox] prompt dispatch failed: ${String(error)}`)
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

  function resolveSessionID(event: { type: string; properties?: { sessionID?: string; status?: { type?: string } } }): string | undefined {
    if (event.type === "session.idle") return event.properties?.sessionID
    if (event.type === "session.status" && event.properties?.status?.type === "idle") {
      return event.properties.sessionID
    }
    return undefined
  }

  return {
    event: async ({ event }) => {
      if (!cfg.enabled) return
      const sessionID = resolveSessionID(event as { type: string; properties?: { sessionID?: string; status?: { type?: string } } })
      if (!sessionID) return
      if (pendingCount(sessionID) > 0) return

      try {
        const file = mailboxFile(cfg.mailboxDir, cfg.project)
        const { open } = readMailbox(file)
        const state = store.read()
        const session = state.sessions[sessionID] ?? { autoRounds: 0, lastPromptAt: 0 }
        const fresh = open.filter(
          (m) => !state.prompted.includes(m.hash) && !state.ownWrites.includes(m.hash),
        )
        if (fresh.length === 0) return

        if (session.autoRounds >= cfg.maxAutoRounds) {
          // One notice per distinct pending set: repeated idles must not turn
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
      } catch (error) {
        console.error(`[opencode-mailbox] event handler error: ${String(error)}`)
      }
    },

    "chat.message": async ({ sessionID }) => {
      try {
        const count = pendingCount(sessionID)
        if (count > 0) {
          pendingPluginPrompts.set(sessionID, { count: count - 1, at: Date.now() })
          return
        }
        const state = store.read()
        state.sessions[sessionID] = { autoRounds: 0, lastPromptAt: 0 }
        store.write(state)
      } catch (error) {
        console.error(`[opencode-mailbox] chat.message handler error: ${String(error)}`)
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
        async execute(args) {
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
            return {
              title: "mailbox_send",
              output: `Appended message to ${args.to} (hash ${result.hash}) in ${result.file}.`,
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
        async execute(args) {
          const project = args.project ?? cfg.project
          if (!isSafeRecipient(project)) {
            return { title: "mailbox_ack", output: `Invalid project name "${project}": must be lowercase kebab-case.` }
          }
          const file = mailboxFile(cfg.mailboxDir, project)
          const result = ackMessage({ file, hash: args.hash, header: args.header })
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
  id: "opencode-mailbox",
  server,
}
