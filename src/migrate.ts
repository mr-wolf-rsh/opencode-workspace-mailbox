import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ackMessage } from "./mailbox.js"
import { parseMailbox, type MailboxMessage } from "./parser.js"
import type { MailboxStore } from "./store.js"

export type SyncReport = { project: string; added: number; acked: number }

/** Count occurrences of each hash, so duplicate messages stay duplicated. */
function countByHash(messages: MailboxMessage[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) counts.set(message.hash, (counts.get(message.hash) ?? 0) + 1)
  return counts
}

/**
 * Messages present in `source` more times than in `target`, counting duplicates.
 * Re-running a migration therefore adds nothing the second time.
 */
export function missingMessages(source: MailboxMessage[], target: MailboxMessage[]): MailboxMessage[] {
  const targetCounts = countByHash(target)
  const seen = new Map<string, number>()
  const missing: MailboxMessage[] = []
  for (const message of source) {
    const occurrence = (seen.get(message.hash) ?? 0) + 1
    seen.set(message.hash, occurrence)
    if (occurrence > (targetCounts.get(message.hash) ?? 0)) missing.push(message)
  }
  return missing
}

/** Messages the source says are DONE but the target still shows as not-DONE. */
export function statusUpdates(source: MailboxMessage[], target: MailboxMessage[]): MailboxMessage[] {
  const targetStatus = new Map(target.map((message) => [message.hash, message.status]))
  return source.filter(
    (message) => message.status === "DONE" && targetStatus.get(message.hash) !== "DONE",
  )
}

function filePreamble(project: string): string {
  return `# ${project} mailbox\n\nMessages addressed to \`${project}\`. Append-only.\n`
}

/** Copy a markdown mailbox into any store (file -> sqlite, or file -> file). */
export function importFileIntoStore(project: string, file: string, store: MailboxStore): SyncReport {
  if (!existsSync(file)) return { project, added: 0, acked: 0 }
  const source = parseMailbox(readFileSync(file, "utf8"))
  if (source.length === 0) return { project, added: 0, acked: 0 }

  const target = store.read(project)
  const missing = missingMessages(source, target)
  const added = store.importMessages(project, missing)

  // Rows that were just inserted already carry their status; only messages that
  // already existed can still need a status reconciliation.
  const addedHashes = new Set(missing.map((message) => message.hash))
  let acked = 0
  for (const message of statusUpdates(source, target)) {
    if (addedHashes.has(message.hash)) continue
    if (store.ack(project, { hash: message.hash }).changed) acked += 1
  }
  return { project, added, acked }
}

/** Copy a store's messages into a markdown mailbox (sqlite -> file, or file -> file). */
export function exportStoreIntoFile(project: string, file: string, store: MailboxStore): SyncReport {
  const source = store.read(project)
  if (source.length === 0) return { project, added: 0, acked: 0 }

  const existing = existsSync(file) ? parseMailbox(readFileSync(file, "utf8")) : []
  const missing = missingMessages(source, existing)

  if (missing.length > 0) {
    mkdirSync(path.dirname(file), { recursive: true })
    let text = existsSync(file) ? readFileSync(file, "utf8") : filePreamble(project)
    if (!existsSync(file)) writeFileSync(file, text, "utf8")
    for (const message of missing) {
      const block = `### ${message.header}\n**Status:** ${message.status || "OPEN"}\n**Topic:** ${message.topic}\n${message.body}\n`
      const separator = text.endsWith("\n") ? "\n" : "\n\n"
      text += `${separator}${block}`
    }
    writeFileSync(file, text, "utf8")
  }

  let acked = 0
  const addedHashes = new Set(missing.map((message) => message.hash))
  for (const message of statusUpdates(source, existing)) {
    if (addedHashes.has(message.hash)) continue
    if (ackMessage({ file, hash: message.hash }).changed) acked += 1
  }
  return { project, added: missing.length, acked }
}
