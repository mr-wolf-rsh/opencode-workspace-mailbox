import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { withFileLock } from "../src/lock.js"

let tmp: string
let target: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-lock-"))
  target = path.join(tmp, "alpha.md")
  fs.writeFileSync(target, "x", "utf8")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("withFileLock", () => {
  it("runs the critical section and removes the lock", () => {
    const value = withFileLock(target, () => 42)
    expect(value).toBe(42)
    expect(fs.existsSync(`${target}.lock`)).toBe(false)
  })

  it("releases the lock when the body throws", () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(fs.existsSync(`${target}.lock`)).toBe(false)
  })

  it("steals a stale lock left by a crashed writer", () => {
    const lock = `${target}.lock`
    fs.writeFileSync(lock, "999", "utf8")
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)

    expect(withFileLock(target, () => "ok")).toBe("ok")
    expect(fs.existsSync(lock)).toBe(false)
  })

  it("fails instead of waiting forever on a fresh lock", () => {
    fs.writeFileSync(`${target}.lock`, "999", "utf8")
    expect(() => withFileLock(target, () => "never", { retries: 1, waitMs: 1 })).toThrow(/lock busy/)
    fs.unlinkSync(`${target}.lock`)
  })

  it("serializes concurrent writers in one process", () => {
    const order: string[] = []
    const first = withFileLock(target, () => {
      order.push("first")
      return 1
    })
    const second = withFileLock(target, () => {
      order.push("second")
      return 2
    })
    expect([first, second]).toEqual([1, 2])
    expect(order).toEqual(["first", "second"])
  })
})
