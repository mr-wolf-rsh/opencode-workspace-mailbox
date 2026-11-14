import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSqliteStore } from "../src/sqlite-store.js"
import { exportStoreIntoFile, importFileIntoStore } from "../src/migrate.js"
import { parseMailbox, isOpen } from "../src/parser.js"
import type { MailboxStore } from "../src/store.js"

let available = true
try {
  createRequire(import.meta.url)("node:sqlite")
} catch {
  available = false
}

let tmp: string
let handoffs: string
let store: MailboxStore | undefined

const writeMailbox = (project: string, text: string) => {
  fs.mkdirSync(handoffs, { recursive: true })
  fs.writeFileSync(path.join(handoffs, `${project}.md`), text, "utf8")
}

const readMailbox = (project: string) =>
  fs.readFileSync(path.join(handoffs, `${project}.md`), "utf8")

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-migrate-"))
  handoffs = path.join(tmp, "handoffs")
  fs.mkdirSync(handoffs, { recursive: true })
})

afterEach(() => {
  store?.close?.()
  store = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(!available)("migration", () => {
  it("imports a markdown mailbox into sqlite and is idempotent", async () => {
    writeMailbox(
      "alpha",
      "### 2026-11-09 10:00 — from workspace → to alpha\n**Status:** OPEN\n**Topic:** one\nbody\n\n" +
        "### 2026-11-09 11:00 — from workspace → to alpha\n**Status:** DONE\n**Topic:** two\nbody\n",
    )
    store = await createSqliteStore(path.join(handoffs, ".mailbox.db"), { legacyDir: handoffs, autoImport: false })

    const first = importFileIntoStore("alpha", path.join(handoffs, "alpha.md"), store)
    expect(first).toMatchObject({ added: 2, acked: 0 })
    expect(store.read("alpha")).toHaveLength(2)
    expect(store.listOpen("alpha")).toHaveLength(1)

    const second = importFileIntoStore("alpha", path.join(handoffs, "alpha.md"), store)
    expect(second).toMatchObject({ added: 0, acked: 0 })
    expect(store.read("alpha")).toHaveLength(2)
  })

  it("exports sqlite rows into a markdown mailbox and is idempotent", async () => {
    store = await createSqliteStore(path.join(handoffs, ".mailbox.db"), {
      legacyDir: handoffs,
      mirror: false,
    })
    store.append("alpha", { from: "workspace", topic: "one", body: "b1", now: new Date(2026, 10, 9, 10, 0) })
    const second = store.append("alpha", {
      from: "workspace",
      topic: "two",
      body: "b2",
      now: new Date(2026, 10, 9, 11, 0),
    })
    store.ack("alpha", { hash: second.hash })

    const file = path.join(handoffs, "alpha.md")
    const first = exportStoreIntoFile("alpha", file, store)
    expect(first).toMatchObject({ added: 2, acked: 0 })

    const parsed = parseMailbox(readMailbox("alpha"))
    expect(parsed).toHaveLength(2)
    expect(parsed.filter(isOpen)).toHaveLength(1)
    expect(parsed[1].status).toBe("DONE")

    const again = exportStoreIntoFile("alpha", file, store)
    expect(again).toMatchObject({ added: 0, acked: 0 })
    expect(parseMailbox(readMailbox("alpha"))).toHaveLength(2)
  })

  it("reconciles statuses from the file into the database", async () => {
    store = await createSqliteStore(path.join(handoffs, ".mailbox.db"), {
      legacyDir: handoffs,
      mirror: false,
    })
    const sent = store.append("alpha", { from: "w", topic: "t", body: "b" })

    // The file says DONE while the database still says OPEN.
    writeMailbox(
      "alpha",
      `### ${sent.header}\n**Status:** DONE\n**Topic:** t\nb\n`,
    )

    const report = importFileIntoStore("alpha", path.join(handoffs, "alpha.md"), store)
    expect(report.added).toBe(0)
    expect(report.acked).toBe(1)
    expect(store.listOpen("alpha")).toHaveLength(0)
  })

  it("reconciles statuses from the database into the file", async () => {
    writeMailbox("alpha", "### 2026-11-09 10:00 — from w → to alpha\n**Status:** OPEN\n**Topic:** t\nb\n")
    store = await createSqliteStore(path.join(handoffs, ".mailbox.db"), {
      legacyDir: handoffs,
      mirror: false,
    })
    store.ack("alpha", { header: "2026-11-09 10:00 — from w → to alpha" })

    const report = exportStoreIntoFile("alpha", path.join(handoffs, "alpha.md"), store)
    expect(report.acked).toBe(1)
    expect(readMailbox("alpha")).toContain("**Status:** DONE")
  })

  it("keeps duplicate messages duplicated without duplicating them again", async () => {
    const block =
      "### 2026-11-09 10:00 — from w → to alpha\n**Status:** OPEN\n**Topic:** same\nbody\n"
    writeMailbox("alpha", `${block}\n${block}`)
    store = await createSqliteStore(path.join(handoffs, ".mailbox.db"), { legacyDir: handoffs, autoImport: false })

    const file = path.join(handoffs, "alpha.md")
    expect(importFileIntoStore("alpha", file, store).added).toBe(2)
    expect(store.read("alpha")).toHaveLength(2)
    expect(importFileIntoStore("alpha", file, store).added).toBe(0)
  })
})
