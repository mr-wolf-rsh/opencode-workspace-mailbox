import { messageHash } from "./hash.js"

export type MailboxMessage = {
  header: string
  from: string
  to: string
  status: string
  topic: string
  body: string
  start: number
  end: number
  statusStart: number
  statusEnd: number
  /** Char offset of the end of the status line's content (before its line ending); -1 if absent. */
  statusLineEnd: number
  hash: string
}

function parseHeader(headerText: string): { from: string; to: string } {
  const s = headerText.trim()
  const re = /(?:—|–|-)\s*from\s+(.+?)\s*(?:→|->|-->)\s*to\s+(.+)$/
  const m = s.match(re)
  if (!m) return { from: "", to: "" }
  return { from: m[1].trim(), to: m[2].trim() }
}

const HEADER_DATE_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * A `###` line is a message header only when it carries a date or a
 * `from ... to ...` shape. Anything else (`### Notes` inside a body) stays part
 * of the previous message instead of splitting it.
 */
function looksLikeMessageHeader(header: string): boolean {
  const text = header.trim()
  if (HEADER_DATE_RE.test(text)) return true
  const { from, to } = parseHeader(text)
  return from.length > 0 && to.length > 0
}

export function parseMailbox(text: string): MailboxMessage[] {
  const messages: MailboxMessage[] = []
  const starts = Array.from(text.matchAll(/^###[ \t]+/gm))
    .map((match) => match.index)
    .filter((index) => {
      const nl = text.indexOf("\n", index)
      const line = text.slice(index, nl === -1 ? text.length : nl).replace(/\r$/, "")
      return looksLikeMessageHeader(line.replace(/^###[ \t]+/, ""))
    })

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : text.length

    let nl = text.indexOf("\n", start)
    if (nl === -1 || nl >= end) nl = end
    let headerLine = text.slice(start, nl)
    if (headerLine.endsWith("\r")) headerLine = headerLine.slice(0, -1)
    const header = headerLine.replace(/^###[ \t]+/, "")
    const { from, to } = parseHeader(header)

    const regionStart = nl >= text.length ? nl : nl + 1
    const region = text.slice(regionStart, end)

    let status = ""
    let statusStart = -1
    let statusEnd = -1
    let statusLineEnd = -1
    const statusMatch = /\*\*Status:\*\*[ \t]*([^\r\n]*)/.exec(region)
    if (statusMatch) {
      const raw = statusMatch[1]
      const word = raw.match(/\S+/)
      if (word) {
        status = word[0].toUpperCase()
        const prefix = statusMatch[0].length - statusMatch[1].length
        statusStart = regionStart + statusMatch.index + prefix + (word.index ?? 0)
        statusEnd = statusStart + word[0].length
      }
      statusLineEnd = regionStart + statusMatch.index + statusMatch[0].length
    }

    let topic = ""
    let topicLineEnd = -1
    const topicMatch = /\*\*Topic:\*\*[ \t]*([^\r\n]*)/.exec(region)
    if (topicMatch) {
      topic = topicMatch[1].trim()
      topicLineEnd = regionStart + topicMatch.index + topicMatch[0].length
    }

    const bodyStart = Math.max(regionStart, statusLineEnd, topicLineEnd)
    const body = text.slice(bodyStart, end).trim()

    const hash = messageHash({ header, topic, body })

    messages.push({ header, from, to, status, topic, body, start, end, statusStart, statusEnd, statusLineEnd, hash })
  }

  return messages
}

export function isOpen(message: MailboxMessage): boolean {
  return message.status === "OPEN"
}

/**
 * Timestamp from the message header (`YYYY-MM-DD[ HH:MM]`), local time.
 * Undated headers return 0, which callers treat as "old".
 */
export function messageTime(message: MailboxMessage): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(message.header.trim())
  if (!match) return 0
  const [, year, month, day, hour = "0", minute = "0"] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  ).getTime()
}
