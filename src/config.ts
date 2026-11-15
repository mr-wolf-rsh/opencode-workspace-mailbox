import path from "node:path"
import { assertInside, isSafeRecipient } from "./paths.js"

export type DeliverMode = "off" | "reuse" | "spawn" | "auto"

export type StorageBackend = "file" | "sqlite"

export type MailboxConfig = {
  mailboxDir?: string
  project?: string | null
  storage?: StorageBackend
  sqlitePath?: string | null
  /** Mirror database writes back into the markdown file (default true). */
  sqliteMirror?: boolean
  maxAutoRounds?: number
  cooldownMs?: number
  enabled?: boolean
  stateFile?: string | null
  wake?: boolean
  pollMs?: number
  deliverOnSend?: DeliverMode
  /** @deprecated alias for deliverOnSend: "spawn" */
  spawnOnSend?: boolean
  spawnCooldownMs?: number
  maxSpawnsPerTurn?: number
  projectDirs?: Record<string, string>
  /** Ignore messages older than this ISO date (first-contact watermark). */
  since?: string | null
  /** Move DONE messages older than this many days to the archive. 0 = never. */
  retentionDays?: number
  /** Archive destination for the file backend. Default: <mailboxDir>/_archive */
  retentionArchiveDir?: string | null
  /**
   * Append a row for a new recipient to the tier README's `## Files` table on
   * first send. Off by default: the tier README is hand-authored documentation.
   */
  registerRecipients?: boolean
}

export type NormalizedConfig = {
  mailboxDir: string
  project: string
  /** True when mailboxDir came from options (disables folder-tree discovery). */
  explicitMailboxDir: boolean
  storage: StorageBackend
  /** Database file when storage is "sqlite"; null means `<mailboxDir>/.mailbox.db`. */
  sqlitePath: string | null
  sqliteMirror: boolean
  maxAutoRounds: number
  cooldownMs: number
  enabled: boolean
  stateFile: string
  wake: boolean
  pollMs: number
  deliverOnSend: DeliverMode
  spawnCooldownMs: number
  maxSpawnsPerTurn: number
  projectDirs: Record<string, string>
  since: string | null
  retentionDays: number
  retentionArchiveDir: string | null
  registerRecipients: boolean
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function nonNegativeInt(value: unknown, def: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def
  return Math.max(0, Math.floor(value))
}

/** Turn an arbitrary directory name into a lowercase kebab-case recipient id. */
function toKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function isStrictlyInside(base: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(candidate))
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)
}

export function normalizeConfig(
  options: Record<string, unknown> | undefined,
  directory: string,
): NormalizedConfig {
  const opts = options ?? {}

  const configuredMailboxDir =
    typeof opts.mailboxDir === "string" && opts.mailboxDir.length > 0 ? opts.mailboxDir : null
  const mailboxDir = path.resolve(configuredMailboxDir ?? path.join(directory, "handoffs"))
  const storage: StorageBackend = opts.storage === "sqlite" ? "sqlite" : "file"
  const sqlitePath =
    typeof opts.sqlitePath === "string" && opts.sqlitePath.length > 0
      ? path.resolve(opts.sqlitePath)
      : null
  const sqliteMirror = typeof opts.sqliteMirror === "boolean" ? opts.sqliteMirror : true

  const rawProject = opts.project
  const configuredProject = typeof rawProject === "string" && rawProject.length > 0 ? rawProject : null
  // Identity is resolved per session, not per config:
  //   explicit `project` wins; otherwise a session whose directory *contains*
  //   the shared mailbox directory is the workspace parent, and every other
  //   session uses its own directory name. The containment rule only applies to
  //   an explicitly configured mailboxDir, so the per-project default
  //   (`<directory>/handoffs`) never turns every project into the parent.
  const project =
    configuredProject ??
    (configuredMailboxDir !== null && isStrictlyInside(directory, mailboxDir)
      ? "workspace"
      : toKebab(path.basename(path.resolve(directory))))
  if (!isSafeRecipient(project)) {
    throw new Error(
      configuredProject !== null
        ? `Invalid project name "${configuredProject}": must be lowercase kebab-case`
        : `Cannot derive a valid project name from "${directory}": set the "project" plugin option`,
    )
  }

  const maxAutoRounds = clampInt(opts.maxAutoRounds, 2, 0, 20)
  const cooldownMs = nonNegativeInt(opts.cooldownMs, 30000)
  const enabled = typeof opts.enabled === "boolean" ? opts.enabled : true
  const wake = typeof opts.wake === "boolean" ? opts.wake : false
  const pollMs = clampInt(opts.pollMs, 10000, 100, 600000)
  const since =
    typeof opts.since === "string" && !Number.isNaN(Date.parse(opts.since))
      ? new Date(opts.since).toISOString()
      : null
  const retentionDays = clampInt(opts.retentionDays, 0, 0, 3650)
  const retentionArchiveDir =
    typeof opts.retentionArchiveDir === "string" && opts.retentionArchiveDir.length > 0
      ? path.resolve(opts.retentionArchiveDir)
      : null
  const registerRecipients = opts.registerRecipients === true
  const deliverOnSend: DeliverMode =
    opts.deliverOnSend === "reuse" ||
    opts.deliverOnSend === "spawn" ||
    opts.deliverOnSend === "auto" ||
    opts.deliverOnSend === "off"
      ? opts.deliverOnSend
      : opts.spawnOnSend === true
        ? "spawn"
        : "off"
  const spawnCooldownMs = nonNegativeInt(opts.spawnCooldownMs, 60000)
  const maxSpawnsPerTurn = clampInt(opts.maxSpawnsPerTurn, 1, 0, 10)
  const projectDirs: Record<string, string> = {}
  if (opts.projectDirs && typeof opts.projectDirs === "object" && !Array.isArray(opts.projectDirs)) {
    for (const [key, value] of Object.entries(opts.projectDirs as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0 && isSafeRecipient(key)) {
        projectDirs[key] = path.resolve(value)
      }
    }
  }

  const rawStateFile =
    typeof opts.stateFile === "string" && opts.stateFile.length > 0
      ? opts.stateFile
      : path.join(directory, ".atl", "mailbox-state.json")
  const stateFile = assertInside(directory, rawStateFile, "stateFile")

  return {
    mailboxDir,
    project,
    explicitMailboxDir: configuredMailboxDir !== null,
    storage,
    sqlitePath,
    sqliteMirror,
    maxAutoRounds,
    cooldownMs,
    enabled,
    stateFile,
    wake,
    pollMs,
    deliverOnSend,
    spawnCooldownMs,
    maxSpawnsPerTurn,
    projectDirs,
    since,
    retentionDays,
    retentionArchiveDir,
    registerRecipients,
  }
}
