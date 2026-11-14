import path from "node:path"
import { assertInside, isSafeRecipient } from "./paths.js"

export type DeliverMode = "off" | "reuse" | "spawn" | "auto"

export type MailboxConfig = {
  mailboxDir?: string
  project?: string | null
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
}

export type NormalizedConfig = {
  mailboxDir: string
  project: string
  /** True when mailboxDir came from options (disables folder-tree discovery). */
  explicitMailboxDir: boolean
  storage: "file"
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
  // Only the file backend is implemented today; the field exists so a SQLite
  // backend can be selected later without a config-format change.
  const storage: "file" = "file"

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
  }
}
