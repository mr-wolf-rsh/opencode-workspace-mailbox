import path from "node:path"
import { assertInside, isSafeRecipient } from "./paths.js"

export type MailboxConfig = {
  mailboxDir?: string
  project?: string | null
  maxAutoRounds?: number
  cooldownMs?: number
  enabled?: boolean
  stateFile?: string | null
}

export type NormalizedConfig = {
  mailboxDir: string
  project: string
  maxAutoRounds: number
  cooldownMs: number
  enabled: boolean
  stateFile: string
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

export function normalizeConfig(
  options: Record<string, unknown> | undefined,
  directory: string,
): NormalizedConfig {
  const opts = options ?? {}

  const rawProject = opts.project
  const configuredProject = typeof rawProject === "string" && rawProject.length > 0 ? rawProject : null
  const project = configuredProject ?? toKebab(path.basename(path.resolve(directory)))
  if (!isSafeRecipient(project)) {
    throw new Error(
      configuredProject !== null
        ? `Invalid project name "${configuredProject}": must be lowercase kebab-case`
        : `Cannot derive a valid project name from "${directory}": set the "project" plugin option`,
    )
  }

  const mailboxDir = path.resolve(
    typeof opts.mailboxDir === "string" && opts.mailboxDir.length > 0
      ? opts.mailboxDir
      : path.join(directory, "handoffs"),
  )

  const maxAutoRounds = clampInt(opts.maxAutoRounds, 2, 0, 20)
  const cooldownMs = nonNegativeInt(opts.cooldownMs, 30000)
  const enabled = typeof opts.enabled === "boolean" ? opts.enabled : true

  const rawStateFile =
    typeof opts.stateFile === "string" && opts.stateFile.length > 0
      ? opts.stateFile
      : path.join(directory, ".atl", "mailbox-state.json")
  const stateFile = assertInside(directory, rawStateFile, "stateFile")

  return { mailboxDir, project, maxAutoRounds, cooldownMs, enabled, stateFile }
}
