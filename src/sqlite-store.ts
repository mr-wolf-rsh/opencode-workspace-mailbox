import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { messageHash } from "./hash.js"
import { ackMessage, buildHeader } from "./mailbox.js"
import { messageTime, parseMailbox, type MailboxMessage } from "./parser.js"
import type { AckResult } from "./mailbox.js"
import type { AppendInput, MailboxFilter, MailboxStore } from "./store.js"

export type SqliteRow = {
  id: number
  project: string
  header: string
  sender: string
  recipient: string
  status: string
  topic: string
  body: string
  hash: string
  created_at: number
}

type Statement = {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

type Database = {
  exec(sql: string): void
  prepare(sql: string): Statement
  close?(): void
}

/** Bun first (OpenCode's plugin runtime), Node's built-in as fallback. */
function openDatabase(file: string): Database {
  mkdirSync(path.dirname(file), { recursive: true })
  const load = createRequire(import.meta.url)
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

  if (isBun) {
    try {
      const mod = load("bun:sqlite") as { Database: new (f: string) => Database }
      return new mod.Database(file)
    } catch {
      // fall through to Node's driver
    }
  }

  try {
    const mod = load("node:sqlite") as { DatabaseSync: new (f: string) => Database }
    return new mod.DatabaseSync(file)
  } catch {
    throw new Error(
      "sqlite backend unavailable: requires bun:sqlite (OpenCode) or node:sqlite (Node >= 22.5)",
    )
  }
}

function rowToMessage(row: SqliteRow): MailboxMessage {
  return {
    header: row.header,
    from: row.sender,
    to: row.recipient,
    status: row.status,
    topic: row.topic,
    body: row.body,
    start: -1,
    end: -1,
    statusStart: -1,
    statusEnd: -1,
    statusLineEnd: -1,
    hash: row.hash,
  }
}

/**
 * SQLite backend: one database per mailbox directory, one row per message.
 * Existing `<project>.md` files are imported exactly once per project, so
 * switching backends keeps the history that started in files.
 */
export async function createSqliteStore(
  databaseFile: string,
  options: { legacyDir?: string; now?: () => number; mirror?: boolean; autoImport?: boolean } = {},
): Promise<MailboxStore> {
  const file = path.resolve(databaseFile)
  const legacyDir = options.legacyDir ?? path.dirname(file)
  const now = options.now ?? (() => Date.now())
  // The markdown file stays the human/agent-readable contract: every append and
  // ack is mirrored into it. The database is what the hot path reads.
  const mirror = options.mirror ?? true
  const autoImport = options.autoImport ?? true
  const db = openDatabase(file)

  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      header TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_project_status ON messages(project, status);
    CREATE INDEX IF NOT EXISTS idx_messages_project_hash ON messages(project, hash);
    CREATE TABLE IF NOT EXISTS imported (project TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      header TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  const selectAll = db.prepare(
    "SELECT * FROM messages WHERE project = ? ORDER BY id ASC",
  )
  const selectOpen = db.prepare(
    "SELECT * FROM messages WHERE project = ? AND status = 'OPEN' ORDER BY id ASC",
  )
  const selectByHash = db.prepare("SELECT * FROM messages WHERE project = ? AND hash = ?")
  const selectByHeader = db.prepare(
    "SELECT * FROM messages WHERE project = ? AND lower(header) = lower(?)",
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (project, header, sender, recipient, status, topic, body, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const updateStatus = db.prepare("UPDATE messages SET status = ? WHERE id = ?")
  const selectImport = db.prepare("SELECT at FROM imported WHERE project = ?")
  const markImported = db.prepare("INSERT OR REPLACE INTO imported (project, at) VALUES (?, ?)")
  const selectDone = db.prepare("SELECT * FROM messages WHERE project = ? AND status = 'DONE'")
  const insertArchive = db.prepare(
    `INSERT INTO messages_archive (project, header, sender, recipient, status, topic, body, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const deleteRow = db.prepare("DELETE FROM messages WHERE id = ?")

  function mirrorFile(project: string): string {
    return path.join(legacyDir, `${project}.md`)
  }

  function ensureFile(project: string): void {
    const target = mirrorFile(project)
    if (existsSync(target)) return
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
      target,
      `# ${project} mailbox\n\nMessages addressed to \`${project}\`. Append-only.\n`,
      "utf8",
    )
  }

  function mirrorAppend(project: string, block: string): void {
    if (!mirror) return
    ensureFile(project)
    const target = mirrorFile(project)
    const existing = readFileSync(target, "utf8")
    const separator = existing.endsWith("\n") ? "\n" : "\n\n"
    appendFileSync(target, `${separator}${block}`, "utf8")
  }

  function mirrorAck(project: string, hash: string): void {
    if (!mirror) return
    const target = mirrorFile(project)
    if (!existsSync(target)) return
    try {
      ackMessage({ file: target, hash })
    } catch {
      // the database is authoritative; a broken mirror must not fail the ack
    }
  }

  function importLegacy(project: string): void {
    if (!autoImport) return
    if (selectImport.get(project)) return
    const legacy = path.join(legacyDir, `${project}.md`)
    if (existsSync(legacy)) {
      try {
        for (const message of parseMailbox(readFileSync(legacy, "utf8"))) {
          insertMessage.run(
            project,
            message.header,
            message.from,
            message.to,
            message.status || "OPEN",
            message.topic,
            message.body,
            message.hash,
            now(),
          )
        }
      } catch {
        // a broken legacy file must not block the backend
      }
    }
    markImported.run(project, now())
  }

  function rows(statement: Statement, project: string, ...rest: unknown[]): SqliteRow[] {
    return statement.all(project, ...rest) as SqliteRow[]
  }

  return {
    kind: "sqlite",
    dir: file,
    ensure(project: string): string {
      importLegacy(project)
      if (mirror) ensureFile(project)
      return file
    },
    listOpen(project: string): MailboxMessage[] {
      importLegacy(project)
      return rows(selectOpen, project).map(rowToMessage)
    },
    read(project: string): MailboxMessage[] {
      importLegacy(project)
      return rows(selectAll, project).map(rowToMessage)
    },
    append(project: string, input: AppendInput): {
      file: string
      header: string
      hash: string
      text: string
    } {
      importLegacy(project)
      const at = input.now ?? new Date()
      const header = buildHeader(project, input.from, at)
      const topic = (input.topic ?? "").replace(/\r?\n/g, " ").trim()
      if (!topic) throw new Error("topic is required")
      const body = (input.body ?? "").trim()
      const status = input.status ?? "OPEN"
      const hash = messageHash({ header, topic, body })
      insertMessage.run(project, header, input.from, project, status, topic, body, hash, now())
      const text = `### ${header}\n**Status:** ${status}\n**Topic:** ${topic}\n${body}\n`
      mirrorAppend(project, text)
      return { file, header, hash, text }
    },
    ack(project: string, target: { hash?: string; header?: string }): AckResult {
      importLegacy(project)
      const hasHash = typeof target.hash === "string" && target.hash.length > 0
      const hasHeader = typeof target.header === "string" && target.header.length > 0
      if ((hasHash ? 1 : 0) + (hasHeader ? 1 : 0) !== 1) {
        return { changed: false, reason: "missing-args" }
      }

      const matches = hasHash
        ? rows(selectByHash, project, target.hash)
        : rows(selectByHeader, project, target.header!.trim())

      if (matches.length === 0) return { changed: false, reason: "not-found" }
      if (matches.length > 1) return { changed: false, reason: "ambiguous" }

      const row = matches[0]
      const message = rowToMessage(row)
      if (row.status === "DONE") return { changed: false, message, reason: "already-done" }

      updateStatus.run("DONE", row.id)
      mirrorAck(project, row.hash)
      return { changed: true, message: { ...message, status: "DONE" } }
    },
    query(project: string, filter: MailboxFilter = {}): MailboxMessage[] {
      importLegacy(project)
      let list = rows(selectAll, project).map(rowToMessage)
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
      let added = 0
      for (const message of messages) {
        insertMessage.run(
          project,
          message.header,
          message.from,
          message.to,
          message.status || "OPEN",
          message.topic,
          message.body,
          message.hash,
          now(),
        )
        added += 1
      }
      // Bookkeeping so the lazy file import cannot run again for this project
      // and duplicate what an explicit migration just added.
      markImported.run(project, now())
      return added
    },
    archive(project: string, cutoffMs: number): number {
      const candidates = selectDone.all(project) as SqliteRow[]
      const move = candidates.filter((row) => {
        const at = messageTime(rowToMessage(row))
        return at > 0 && at < cutoffMs
      })
      for (const row of move) {
        insertArchive.run(
          row.project,
          row.header,
          row.sender,
          row.recipient,
          row.status,
          row.topic,
          row.body,
          row.hash,
          row.created_at,
        )
        deleteRow.run(row.id)
      }
      return move.length
    },
    projects(): string[] {
      const rows = db.prepare("SELECT DISTINCT project FROM messages ORDER BY project").all() as {
        project: string
      }[]
      return rows.map((row) => row.project)
    },
    close(): void {
      db.close?.()
      // Bun on Windows keeps the file handle until GC, even after close(), which
      // makes the database file undeletable for the rest of the process.
      const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun
      bun?.gc?.(true)
    },
  }
}
