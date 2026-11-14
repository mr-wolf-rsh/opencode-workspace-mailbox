import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ackMessage, readMailbox, sendMessage, type AckResult, type SendResult } from "./mailbox.js"
import { mailboxFile } from "./paths.js"
import { isOpen, messageTime, parseMailbox, type MailboxMessage } from "./parser.js"
import { withFileLock } from "./lock.js"

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
 * Storage contract. Both shipped backends implement it; a new backend only has
 * to implement these operations for the tools, wake path and delivery to work.
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
  /** Move DONE messages older than the cutoff into the archive. Returns moved count. */
  archive(project: string, cutoffMs: number): number
  /** Every project that has messages in this backend. */
  projects(): string[]
  /** Release resources (database handles). Optional for file-backed stores. */
  close?(): void
}

export type FileStoreOptions = { archiveDir?: string }

function blockOf(message: MailboxMessage): string {
  return `### ${message.header}\n**Status:** ${message.status || "OPEN"}\n**Topic:** ${message.topic}\n${message.body}\n`
}

export function createFileStore(dir: string, options: FileStoreOptions = {}): MailboxStore {
  const root = path.resolve(dir)
  const archiveDir = options.archiveDir ? path.resolve(options.archiveDir) : path.join(root, "_archive")
  const fileFor = (project: string): string => mailboxFile(root, project)

  // mtime+size short-circuit: an unchanged file is never re-parsed.
  const cache = new Map<string, { key: string; messages: MailboxMessage[] }>()

  function load(project: string): MailboxMessage[] {
    const file = fileFor(project)
    if (!existsSync(file)) {
      cache.delete(file)
      return []
    }
    const stats = statSync(file)
    const key = `${stats.mtimeMs}:${stats.size}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return hit.messages
    const messages = parseMailbox(readFileSync(file, "utf8"))
    cache.set(file, { key, messages })
    return messages
  }

  function invalidate(project: string): void {
    cache.delete(fileFor(project))
  }

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
        invalidate(project)
      }
      return target
    },
    listOpen(project: string): MailboxMessage[] {
      return load(project).filter(isOpen)
    },
    read(project: string): MailboxMessage[] {
      return load(project)
    },
    append(project: string, input: AppendInput): SendResult {
      const result = withFileLock(fileFor(project), () =>
        sendMessage({
        mailboxDir: root,
        to: project,
        from: input.from,
        topic: input.topic,
        body: input.body,
        status: input.status,
          now: input.now,
        }),
      )
      invalidate(project)
      return result
    },
    ack(project: string, target: { hash?: string; header?: string }): AckResult {
      const result = withFileLock(fileFor(project), () =>
        ackMessage({ file: fileFor(project), hash: target.hash, header: target.header }),
      )
      if (result.changed) invalidate(project)
      return result
    },
    query(project: string, filter: MailboxFilter = {}): MailboxMessage[] {
      let list = load(project)
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
      return withFileLock(fileFor(project), () => {
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
          const block = blockOf(message)
          appendFileSync(target, `${endsWithNewline ? "\n" : "\n\n"}${block}`, "utf8")
          endsWithNewline = true
        }
        invalidate(project)
        return messages.length
      })
    },
    archive(project: string, cutoffMs: number): number {
      return withFileLock(fileFor(project), () => {
        const messages = load(project)
        const keep: MailboxMessage[] = []
        const move: MailboxMessage[] = []
        for (const message of messages) {
          if (
            message.status === "DONE" &&
            messageTime(message) > 0 &&
            messageTime(message) < cutoffMs
          ) {
            move.push(message)
          } else {
            keep.push(message)
          }
        }
        if (move.length === 0) return 0

        const target = fileFor(project)
        const header = `# ${project} mailbox\n\nMessages addressed to \`${project}\`. Append-only.\n`
        const kept = keep.map(blockOf).join("\n")
        writeFileSync(target, keep.length > 0 ? `${header}\n${kept}` : header, "utf8")

        mkdirSync(archiveDir, { recursive: true })
        const archiveFile = path.join(archiveDir, `${project}.md`)
        const preamble = existsSync(archiveFile)
          ? ""
          : `# ${project} archive\n\nMessages moved out of the active mailbox by retention.\n\n`
        appendFileSync(archiveFile, preamble + move.map(blockOf).join("\n"), "utf8")

        invalidate(project)
        return move.length
      })
    },
    projects(): string[] {
      if (!existsSync(root)) return []
      return readdirSync(root)
        .filter((name) => name.endsWith(".md") && name !== "README.md")
        .map((name) => name.slice(0, -3))
    },
  }
}
