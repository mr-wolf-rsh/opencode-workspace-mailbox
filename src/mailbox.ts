import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { messageHash } from "./hash.js"
import { isOpen, parseMailbox, type MailboxMessage } from "./parser.js"
import { isSafeRecipient, mailboxFile, PathSafetyError } from "./paths.js"

export type SendRequest = {
  mailboxDir: string
  to: string
  from: string
  topic: string
  body: string
  status?: "OPEN" | "DONE"
  now?: Date
}

export type SendResult = { file: string; header: string; hash: string; text: string }

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

export function buildHeader(to: string, from: string, now: Date): string {
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  return `${date} ${time} — from ${from} → to ${to}`
}

export function sendMessage(req: SendRequest): SendResult {
  if (!isSafeRecipient(req.to)) {
    throw new PathSafetyError(`Invalid recipient "${req.to}"`)
  }
  const topic = (req.topic ?? "").replace(/\r?\n/g, " ").trim()
  if (!topic) throw new Error("topic is required")
  const body = (req.body ?? "").trim()
  const file = mailboxFile(req.mailboxDir, req.to)
  mkdirSync(path.dirname(file), { recursive: true })

  const status = req.status ?? "OPEN"
  const header = buildHeader(req.to, req.from, req.now ?? new Date())
  const block = `### ${header}\n**Status:** ${status}\n**Topic:** ${topic}\n${body}\n`
  const preamble = `# ${req.to} mailbox\n\nMessages addressed to \`${req.to}\`. Append-only.\n`

  if (!existsSync(file)) {
    writeFileSync(file, preamble, "utf8")
    appendFileSync(file, `\n${block}`, "utf8")
  } else {
    const existing = readFileSync(file, "utf8")
    const sep = existing.endsWith("\n") ? "\n" : "\n\n"
    appendFileSync(file, `${sep}${block}`, "utf8")
  }

  const hash = messageHash({ header, topic, body })
  return { file, header, hash, text: block }
}

export type ReadResult = { file: string; exists: boolean; messages: MailboxMessage[]; open: MailboxMessage[] }

export function readMailbox(file: string): ReadResult {
  if (!existsSync(file)) return { file, exists: false, messages: [], open: [] }
  const text = readFileSync(file, "utf8")
  const messages = parseMailbox(text)
  return { file, exists: true, messages, open: messages.filter(isOpen) }
}

export type AckRequest = { file: string; hash?: string; header?: string }
export type AckResult = {
  changed: boolean
  message?: MailboxMessage
  reason?: "not-found" | "already-done" | "ambiguous" | "missing-args"
}

export function ackMessage(req: AckRequest): AckResult {
  const hasHash = typeof req.hash === "string" && req.hash.length > 0
  const hasHeader = typeof req.header === "string" && req.header.length > 0
  if ((hasHash ? 1 : 0) + (hasHeader ? 1 : 0) !== 1) {
    return { changed: false, reason: "missing-args" }
  }
  if (!existsSync(req.file)) return { changed: false, reason: "not-found" }

  const text = readFileSync(req.file, "utf8")
  const messages = parseMailbox(text)

  const matches = messages.filter((m) => {
    if (hasHash) return m.hash === req.hash
    return m.header.trim().toLowerCase() === req.header!.trim().toLowerCase()
  })

  if (matches.length === 0) return { changed: false, reason: "not-found" }
  if (matches.length > 1) return { changed: false, reason: "ambiguous" }

  const message = matches[0]
  if (message.status === "DONE") return { changed: false, message, reason: "already-done" }
  if (message.statusStart < 0 || message.statusEnd < 0) return { changed: false, reason: "not-found" }

  // Replace the whole status-line content, not just the first word: real
  // messages carry annotations like `OPEN (confirm one detail)` and flipping the
  // token alone would leave a nonsensical `DONE (confirm one detail)`.
  const lineEnd = message.statusLineEnd >= message.statusEnd ? message.statusLineEnd : message.statusEnd
  const next = text.slice(0, message.statusStart) + "DONE" + text.slice(lineEnd)
  writeFileSync(req.file, next, "utf8")

  const updated = parseMailbox(next).find((m) => m.hash === message.hash) ?? message
  return { changed: true, message: updated }
}
