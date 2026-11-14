import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs"
import path from "node:path"

export type LockOptions = {
  retries?: number
  waitMs?: number
  staleMs?: number
}

function sleepSync(ms: number): void {
  // Works in Node and Bun; no timers, no async.
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

/**
 * Cross-process critical section using an exclusive `<target>.lock` file.
 * A lock older than `staleMs` is considered abandoned (a crashed writer) and
 * is stolen. This is what makes append + read-modify-write safe when two
 * sessions share one markdown mailbox.
 */
export function withFileLock<T>(target: string, fn: () => T, options: LockOptions = {}): T {
  const lockPath = `${target}.lock`
  const retries = options.retries ?? 40
  const waitMs = options.waitMs ?? 25
  const staleMs = options.staleMs ?? 10_000

  mkdirSync(path.dirname(lockPath), { recursive: true })

  let handle: number | undefined
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      handle = openSync(lockPath, "wx")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const stats = statSync(lockPath)
        if (Date.now() - stats.mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue // the lock vanished between open and stat
      }
      if (attempt === retries) throw new Error(`mailbox lock busy: ${lockPath}`)
      sleepSync(waitMs)
    }
  }

  try {
    if (handle !== undefined) {
      try {
        writeSync(handle, String(process.pid))
      } catch {
        // pid hint only
      }
    }
    return fn()
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // already closed
      }
    }
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath)
    } catch {
      // another process stole a stale lock
    }
  }
}
