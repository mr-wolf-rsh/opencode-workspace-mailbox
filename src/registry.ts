import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { withFileLock } from "./lock.js"

export type RegistrationOutcome = "registered" | "present" | "no-readme" | "no-table"

const FILES_HEADING = /^#{1,6}\s+files\s*$/i
const ANY_HEADING = /^#{1,6}\s+/

/**
 * Append a row for `project` to the tier README's `## Files` table.
 *
 * The tier README is hand-authored documentation and the protocol treats it as
 * the authoritative file list, so this stays deliberately conservative: it only
 * inserts one row at the end of the existing table, never rewrites a row, never
 * creates a missing README, and reports why it did nothing instead of guessing.
 *
 * Registration is a read-modify-write on a file every session may touch, so it
 * runs under the same cross-process lock as the mailbox appends.
 */
export function registerRecipient(readmePath: string, project: string): RegistrationOutcome {
  if (!existsSync(readmePath)) return "no-readme"
  return withFileLock(readmePath, () => registerLocked(readmePath, project))
}

function registerLocked(readmePath: string, project: string): RegistrationOutcome {
  // Re-check under the lock: another session may have created or removed it.
  if (!existsSync(readmePath)) return "no-readme"

  const text = readFileSync(readmePath, "utf8")
  if (text.includes(`\`${project}.md\``)) return "present"

  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const lines = text.split(/\r?\n/)

  const headingAt = lines.findIndex((line) => FILES_HEADING.test(line.trim()))
  if (headingAt < 0) return "no-table"

  let tableEnd = -1
  for (let i = headingAt + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (ANY_HEADING.test(line)) break
    if (line.startsWith("|")) tableEnd = i
  }
  if (tableEnd < 0) return "no-table"

  const row = `| \`${project}.md\` | the \`${project}\` session | messages addressed \`to: ${project}\` |`
  lines.splice(tableEnd + 1, 0, row)
  writeFileSync(readmePath, lines.join(eol), "utf8")
  return "registered"
}
