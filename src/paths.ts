import path from "node:path"

export const RECIPIENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathSafetyError"
  }
}

export function isSafeRecipient(name: unknown): name is string {
  return typeof name === "string" && RECIPIENT_RE.test(name)
}

export function resolveInside(baseDir: string, ...segments: string[]): string {
  const target = path.resolve(baseDir, ...segments)
  const rel = path.relative(baseDir, target)
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new PathSafetyError(`Path escapes base directory: ${target}`)
  }
  return target
}

export function mailboxFile(mailboxDir: string, recipient: string): string {
  if (!isSafeRecipient(recipient)) {
    throw new PathSafetyError(`Invalid recipient "${recipient}"`)
  }
  return resolveInside(mailboxDir, recipient + ".md")
}

export function assertInside(baseDir: string, candidate: string, label: string): string {
  try {
    return resolveInside(baseDir, candidate)
  } catch {
    throw new PathSafetyError(`${label} must resolve inside the project directory: ${candidate}`)
  }
}
