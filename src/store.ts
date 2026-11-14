import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ackMessage, readMailbox, sendMessage, type AckResult, type SendResult } from "./mailbox.js"
import { mailboxFile } from "./paths.js"
import type { MailboxMessage } from "./parser.js"

export type MailboxFilter = {
  status?: string
  topicContains?: string
  limit?: number
}

export type AppendInput = {
  from: string
  topic: string
  body: string
  status?: "OPEN" | "DONE"
  now?: Date
}

/**
 * Storage contract. The file backend is the MVP; a SQLite backend only has to
 * implement these five operations to replace it without touching the tools,
 * the wake path, or spawn-on-send.
 */
export interface MailboxStore {
  readonly kind: string
  readonly dir: string
  /** Create the project's inbox if it is missing; returns its location. */
  ensure(project: string): string
  listOpen(project: string): MailboxMessage[]
  read(project: string): MailboxMessage[]
  append(project: string, input: AppendInput): SendResult
  ack(project: string, target: { hash?: string; header?: string }): AckResult
  query(project: string, filter?: MailboxFilter): MailboxMessage[]
  /** Insert messages verbatim (migration). Returns how many were added. */
  importMessages(project: string, messages: MailboxMessage[]): number
  /** Every project that has messages in this backend. */
  projects(): string[]
  /** Release resources (database handles). Optional for file-backed stores. */
  close?(): void
}

export function createFileStore(dir: string): MailboxStore {
  const root = path.resolve(dir)
  const fileFor = (project: string): string => mailboxFile(root, project)

  return {
    kind: "file",
    dir: root,
    ensure(project: string): string {
      const target = fileFor(project)
      if (!existsSync(target)) {
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(
          target,
          `# ${project} mailbox\n\nMessages addressed to \`${project}\`. Append-only.\n`,
          "utf8",
        )
      }
      return target
    },
    listOpen(project: string): MailboxMessage[] {
      return readMailbox(fileFor(project)).open
    },
    read(project: string): MailboxMessage[] {
      return readMailbox(fileFor(project)).messages
    },
    append(project: string, input: AppendInput): SendResult {
      return sendMessage({
        mailboxDir: root,
        to: project,
        from: input.from,
        topic: input.topic,
        body: input.body,
        status: input.status,
        now: input.now,
      })
    },
    ack(project: string, target: { hash?: string; header?: string }): AckResult {
      return ackMessage({ file: fileFor(project), hash: target.hash, header: target.header })
    },
    query(project: string, filter: MailboxFilter = {}): MailboxMessage[] {
      let list = readMailbox(fileFor(project)).messages
      if (filter.status) {
        const wanted = filter.status.toUpperCase()
        list = list.filter((message) => message.status === wanted)
      }
      if (filter.topicContains) {
        const needle = filter.topicContains.toLowerCase()
        list = list.filter((message) => message.topic.toLowerCase().includes(needle))
      }
      if (filter.limit && filter.limit > 0) list = list.slice(-filter.limit)
      return list
    },
    importMessages(project: string, messages: MailboxMessage[]): number {
      if (messages.length === 0) return 0
      const target = fileFor(project)
      mkdirSync(path.dirname(target), { recursive: true })
      if (!existsSync(target)) {
        writeFileSync(
          target,
          `# ${project} mailbox\n\nMessages addressed to \`${project}\`. Append-only.\n`,
          "utf8",
        )
      }
      let endsWithNewline = readFileSync(target, "utf8").endsWith("\n")
      for (const message of messages) {
        const block = `### ${message.header}\n**Status:** ${message.status || "OPEN"}\n**Topic:** ${message.topic}\n${message.body}\n`
        appendFileSync(target, `${endsWithNewline ? "\n" : "\n\n"}${block}`, "utf8")
        endsWithNewline = block.endsWith("\n")
      }
      return messages.length
    },
    projects(): string[] {
      if (!existsSync(root)) return []
      return readdirSync(root)
        .filter((name) => name.endsWith(".md") && name !== "README.md")
        .map((name) => name.slice(0, -3))
    },
  }
}
