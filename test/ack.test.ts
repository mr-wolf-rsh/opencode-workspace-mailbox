import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ackMessage } from "../src/mailbox.js"
import { parseMailbox } from "../src/parser.js"

let dir: string
let file: string

const before =
  "### 2026-11-09 10:00 — from foo → to bar\r\n" +
  "**Status:** OPEN\r\n" +
  "**Topic:** topic one\r\n" +
  "body one\r\n" +
  "\r\n" +
  "### 2026-11-09 10:01 — from baz → to qux\r\n" +
  "**Status:** OPEN\r\n" +
  "**Topic:** topic two\r\n" +
  "body two\r\n"

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  file = path.join(dir, "test-project.md")
  fs.writeFileSync(file, before, "utf8")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("ackMessage", () => {
  it("flips only the target status line (byte-identical otherwise)", () => {
    const msgs = parseMailbox(before)
    const second = msgs[1]
    const result = ackMessage({ file, hash: second.hash })

    expect(result.changed).toBe(true)
    const after = fs.readFileSync(file, "utf8")
    expect(after.slice(0, second.statusStart)).toBe(before.slice(0, second.statusStart))
    expect(after.slice(second.statusStart + 4)).toBe(before.slice(second.statusStart + 4))

    const afterMsgs = parseMailbox(after)
    expect(afterMsgs[1].status).toBe("DONE")
    expect(afterMsgs[1].topic).toBe("topic two")
    expect(afterMsgs[0].status).toBe("OPEN")
    expect(afterMsgs[0].body).toBe("body one")
  })

  it("acks by header (case-insensitive)", () => {
    const result = ackMessage({ file, header: "2026-11-09 10:01 — FROM baz → TO qux" })
    expect(result.changed).toBe(true)
    const after = parseMailbox(fs.readFileSync(file, "utf8"))
    expect(after[1].status).toBe("DONE")
  })

  it("is a no-op when already DONE", () => {
    ackMessage({ file, hash: parseMailbox(before)[1].hash })
    const again = ackMessage({ file, hash: parseMailbox(before)[1].hash })
    expect(again.changed).toBe(false)
    expect(again.reason).toBe("already-done")
  })

  it("reports ambiguous when a header matches multiple messages", () => {
    const dup =
      "### 2026-11-09 10:00 — from x → to y\n**Status:** OPEN\n**Topic:** a\nbody a\n" +
      "\n" +
      "### 2026-11-09 10:00 — from x → to y\n**Status:** OPEN\n**Topic:** b\nbody b\n"
    fs.writeFileSync(file, dup, "utf8")
    const result = ackMessage({ file, header: "2026-11-09 10:00 — from x → to y" })
    expect(result.changed).toBe(false)
    expect(result.reason).toBe("ambiguous")
  })

  it("reports missing-args when neither or both selectors are given", () => {
    expect(ackMessage({ file }).reason).toBe("missing-args")
    expect(ackMessage({ file, hash: "h", header: "x" }).reason).toBe("missing-args")
  })

  it("reports not-found for an unknown hash", () => {
    const result = ackMessage({ file, hash: "0000000000000000" })
    expect(result.changed).toBe(false)
    expect(result.reason).toBe("not-found")
  })
})
