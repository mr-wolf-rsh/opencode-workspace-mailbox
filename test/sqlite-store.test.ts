import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { createSqliteStore } from "../src/sqlite-store.js"
import type { MailboxStore } from "../src/store.js"

let available = true
try {
  createRequire(import.meta.url)("node:sqlite")
} catch {
  available = false
}

let tmp: string
let dbFile: string
let store: MailboxStore | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-sqlite-"))
  dbFile = path.join(tmp, "handoffs", ".mailbox.db")
})

afterEach(() => {
  store?.close?.()
  store = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(!available)("sqlite store", () => {
  it("appends and lists OPEN messages per project", async () => {
    store = await createSqliteStore(dbFile)
    expect(store.kind).toBe("sqlite")

    store.append("alpha", { from: "workspace", topic: "one", body: "b1" })
    store.append("alpha", { from: "workspace", topic: "two", body: "b2", status: "DONE" })
    store.append("beta", { from: "workspace", topic: "other", body: "b3" })

    expect(store.listOpen("alpha").map((m) => m.topic)).toEqual(["one"])
    expect(store.read("alpha")).toHaveLength(2)
    expect(store.listOpen("beta")).toHaveLength(1)
    expect(store.listOpen("missing")).toHaveLength(0)
  })

  it("acks by hash and by header, and is idempotent", async () => {
    store = await createSqliteStore(dbFile)
    const first = store.append("alpha", {
      from: "w",
      topic: "one",
      body: "b1",
      now: new Date(2026, 10, 9, 10, 0),
    })
    const second = store.append("alpha", {
      from: "w",
      topic: "two",
      body: "b2",
      now: new Date(2026, 10, 9, 11, 0),
    })

    const byHash = store.ack("alpha", { hash: first.hash })
    expect(byHash.changed).toBe(true)
    expect(byHash.message?.status).toBe("DONE")

    const byHeader = store.ack("alpha", { header: second.header.toUpperCase() })
    expect(byHeader.changed).toBe(true)

    const again = store.ack("alpha", { hash: first.hash })
    expect(again.changed).toBe(false)
    expect(again.reason).toBe("already-done")

    expect(store.listOpen("alpha")).toHaveLength(0)
    expect(store.ack("alpha", { hash: "deadbeefdeadbeef" }).reason).toBe("not-found")
    expect(store.ack("alpha", {}).reason).toBe("missing-args")
  })

  it("reports ambiguous matches by header", async () => {
    store = await createSqliteStore(dbFile)
    const header = "2026-11-09 10:00 — from x → to alpha"
    store.append("alpha", { from: "x", topic: "a", body: "b", now: new Date(2026, 10, 9, 10, 0) })
    store.append("alpha", { from: "x", topic: "c", body: "d", now: new Date(2026, 10, 9, 10, 0) })
    const result = store.ack("alpha", { header })
    expect(result.changed).toBe(false)
    expect(result.reason).toBe("ambiguous")
  })

  it("queries by status, topic, and limit", async () => {
    store = await createSqliteStore(dbFile)
    store.append("alpha", { from: "w", topic: "deploy checklist", body: "1" })
    store.append("alpha", { from: "w", topic: "other thing", body: "2" })
    store.append("alpha", { from: "w", topic: "deploy rollback", body: "3" })

    expect(store.query("alpha", { topicContains: "deploy" })).toHaveLength(2)
    expect(store.query("alpha", { status: "OPEN" })).toHaveLength(3)
    expect(store.query("alpha", { limit: 1 })[0].topic).toBe("deploy rollback")
  })

  it("imports a legacy markdown mailbox exactly once", async () => {
    const legacyDir = path.join(tmp, "handoffs")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, "alpha.md"),
      "### 2026-11-09 10:00 — from workspace → to alpha\n**Status:** OPEN\n**Topic:** legacy open\nbody\n\n" +
        "### 2026-11-09 11:00 — from workspace → to alpha\n**Status:** DONE\n**Topic:** legacy done\nbody\n",
      "utf8",
    )

    store = await createSqliteStore(dbFile, { legacyDir })
    const open = store.listOpen("alpha")
    expect(open).toHaveLength(1)
    expect(open[0].topic).toBe("legacy open")
    expect(store.read("alpha")).toHaveLength(2)

    // A second store over the same database must not import twice.
    const reopened = await createSqliteStore(dbFile, { legacyDir })
    expect(reopened.read("alpha")).toHaveLength(2)
    reopened.close?.()
  })

  it("mirrors appends and acks into the markdown file", async () => {
    store = await createSqliteStore(dbFile, { legacyDir: path.join(tmp, "handoffs") })
    const sent = store.append("alpha", { from: "workspace", topic: "mirrored", body: "body" })

    const mirror = path.join(tmp, "handoffs", "alpha.md")
    expect(fs.existsSync(mirror)).toBe(true)
    expect(fs.readFileSync(mirror, "utf8")).toContain("**Topic:** mirrored")

    store.ack("alpha", { hash: sent.hash })
    expect(fs.readFileSync(mirror, "utf8")).toContain("**Status:** DONE")
    expect(store.listOpen("alpha")).toHaveLength(0)
  })

  it("skips the mirror when asked", async () => {
    store = await createSqliteStore(dbFile, { legacyDir: path.join(tmp, "handoffs"), mirror: false })
    store.append("alpha", { from: "w", topic: "db only", body: "b" })
    expect(fs.existsSync(path.join(tmp, "handoffs", "alpha.md"))).toBe(false)
    expect(store.listOpen("alpha")).toHaveLength(1)
  })

  it("persists messages across store instances", async () => {
    store = await createSqliteStore(dbFile)
    const sent = store.append("alpha", { from: "w", topic: "persisted", body: "b" })
    store.close?.()

    store = await createSqliteStore(dbFile)
    const open = store.listOpen("alpha")
    expect(open).toHaveLength(1)
    expect(open[0].hash).toBe(sent.hash)
  })
})
