import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { sendMessage } from "../src/mailbox.js"
import { PathSafetyError } from "../src/paths.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const fixedNow = new Date(2026, 10, 9, 10, 30)

describe("sendMessage", () => {
  it("creates a new file with the preamble and appended block", () => {
    const result = sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "hello", body: "world", now: fixedNow })
    expect(result.header).toBe("2026-11-09 10:30 — from me → to foo")
    const content = fs.readFileSync(result.file, "utf8")
    expect(content.startsWith("# foo mailbox\n\nMessages addressed to `foo`. Append-only.\n")).toBe(true)
    expect(content).toContain(
      "### 2026-11-09 10:30 — from me → to foo\n**Status:** OPEN\n**Topic:** hello\nworld\n",
    )
  })

  it("appends at EOF, prior bytes unchanged", () => {
    const file = path.join(dir, "foo.md")
    const preamble = "# foo mailbox\n\nMessages addressed to `foo`. Append-only.\n"
    fs.writeFileSync(file, preamble, "utf8")
    const prior = fs.readFileSync(file, "utf8")
    sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "t", body: "b", now: fixedNow })
    const after = fs.readFileSync(file, "utf8")
    expect(after.startsWith(prior)).toBe(true)
  })

  it("rejects traversal and invalid recipients", () => {
    for (const bad of ["../evil", "a/b", "a\\b", "..", "", "Bad Name", "a.b"]) {
      expect(() => sendMessage({ mailboxDir: dir, to: bad, from: "me", topic: "t", body: "b" })).toThrow(PathSafetyError)
    }
  })

  it("rejects an empty topic", () => {
    expect(() => sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "", body: "b" })).toThrow("topic is required")
    expect(() => sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "   ", body: "b" })).toThrow("topic is required")
  })

  it("defaults status to OPEN and honors explicit DONE", () => {
    const open = sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "t", body: "b", now: fixedNow })
    expect(open.text).toContain("**Status:** OPEN")

    const done = sendMessage({ mailboxDir: dir, to: "foo", from: "me", topic: "t2", body: "b2", status: "DONE", now: fixedNow })
    expect(done.text).toContain("**Status:** DONE")
  })

  it("injectable now produces the expected header line", () => {
    const result = sendMessage({
      mailboxDir: dir,
      to: "bar",
      from: "src",
      topic: "t",
      body: "b",
      now: new Date(2025, 0, 5, 9, 7),
    })
    expect(result.header).toBe("2025-01-05 09:07 — from src → to bar")
  })
})
