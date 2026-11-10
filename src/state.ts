import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export type SessionState = {
  autoRounds: number
  lastPromptAt: number
  lastNoticeAt?: number
  noticeKey?: string
}
export type MailboxState = {
  version: 1
  prompted: string[]
  ownWrites: string[]
  sessions: Record<string, SessionState>
}

const MAX_ENTRIES = 500

export function emptyState(): MailboxState {
  return { version: 1, prompted: [], ownWrites: [], sessions: {} }
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === "string" && !seen.has(entry)) {
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.slice(-MAX_ENTRIES)
}

function coerceSession(value: unknown): SessionState {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const session: SessionState = {
    autoRounds: finiteInt(obj.autoRounds),
    lastPromptAt: finiteInt(obj.lastPromptAt),
  }
  if (typeof obj.lastNoticeAt === "number" && Number.isFinite(obj.lastNoticeAt)) {
    session.lastNoticeAt = obj.lastNoticeAt
  }
  if (typeof obj.noticeKey === "string") {
    session.noticeKey = obj.noticeKey
  }
  return session
}

function coerce(value: unknown): MailboxState {
  if (!value || typeof value !== "object") return emptyState()
  const obj = value as Record<string, unknown>
  const sessions: Record<string, SessionState> = {}
  if (obj.sessions && typeof obj.sessions === "object") {
    for (const [key, entry] of Object.entries(obj.sessions as Record<string, unknown>)) {
      sessions[key] = coerceSession(entry)
    }
  }
  return { version: 1, prompted: asStringArray(obj.prompted), ownWrites: asStringArray(obj.ownWrites), sessions }
}

export class StateStore {
  private file: string
  private now: () => number

  constructor(file: string, now?: () => number) {
    this.file = file
    this.now = now ?? (() => Date.now())
  }

  read(): MailboxState {
    if (!existsSync(this.file)) return emptyState()
    try {
      const raw = readFileSync(this.file, "utf8")
      return coerce(JSON.parse(raw))
    } catch {
      return emptyState()
    }
  }

  write(state: MailboxState): void {
    const clean = coerce(state)
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(clean, null, 2), "utf8")
    renameSync(tmp, this.file)
  }

  update(mutator: (state: MailboxState) => void): MailboxState {
    const state = this.read()
    mutator(state)
    this.write(state)
    return state
  }
}
