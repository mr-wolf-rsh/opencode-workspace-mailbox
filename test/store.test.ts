import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createFileStore } from "../src/store.js"

let tmp: string
let store: ReturnType<typeof createFileStore>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-store-"))
  store = createFileStore(path.join(tmp, "handoffs"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("file store", () => {
  it("creates the inbox on ensure and is idempotent", () => {
    const file = store.ensure("alpha")
    expect(fs.existsSync(file)).toBe(true)
    const before = fs.readFileSync(file, "utf8")
    store.ensure("alpha")
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  it("appends and lists OPEN messages", () => {
    store.append("alpha", { from: "workspace", topic: "one", body: "b1" })
    store.append("alpha", { from: "workspace", topic: "two", body: "b2", status: "DONE" })

    const open = store.listOpen("alpha")
    expect(open).toHaveLength(1)
    expect(open[0].topic).toBe("one")
    expect(store.read("alpha")).toHaveLength(2)
  })

  it("acks by hash and leaves other bytes untouched", () => {
    const sent = store.append("alpha", { from: "workspace", topic: "one", body: "b1" })
    const file = store.ensure("alpha")
    const before = fs.readFileSync(file, "utf8")

    const result = store.ack("alpha", { hash: sent.hash })
    expect(result.changed).toBe(true)
    expect(store.listOpen("alpha")).toHaveLength(0)

    const after = fs.readFileSync(file, "utf8")
    expect(after.length).toBe(before.length)
    expect(after.replace("**Status:** DONE", "**Status:** OPEN")).toBe(before)
  })

  it("queries by status, topic substring, and limit", () => {
    store.append("alpha", { from: "w", topic: "deploy checklist", body: "1" })
    store.append("alpha", { from: "w", topic: "other thing", body: "2" })
    store.append("alpha", { from: "w", topic: "deploy rollback", body: "3" })

    expect(store.query("alpha", { status: "OPEN" })).toHaveLength(3)
    expect(store.query("alpha", { topicContains: "deploy" })).toHaveLength(2)
    expect(store.query("alpha", { limit: 1 })).toHaveLength(1)
    expect(store.query("alpha", { limit: 1 })[0].topic).toBe("deploy rollback")
  })

  it("rejects traversal recipients at the store boundary", () => {
    expect(() => store.listOpen("../evil")).toThrow()
    expect(() => store.append("../evil", { from: "x", topic: "t", body: "b" })).toThrow()
  })
})
