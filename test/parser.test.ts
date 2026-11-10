import { describe, expect, it } from "vitest"
import { isOpen, parseMailbox } from "../src/parser.js"

describe("parseMailbox", () => {
  it("parses a single message with time, em dash and arrow", () => {
    const text = "### 2026-11-09 10:30 — from foo → to bar\n**Status:** OPEN\n**Topic:** a topic\nbody line\n"
    const msgs = parseMailbox(text)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.header).toBe("2026-11-09 10:30 — from foo → to bar")
    expect(m.from).toBe("foo")
    expect(m.to).toBe("bar")
    expect(m.status).toBe("OPEN")
    expect(m.topic).toBe("a topic")
    expect(m.body).toBe("body line")
    expect(isOpen(m)).toBe(true)
  })

  it("parses a header without time", () => {
    const text = "### 2026-11-09 — from foo → to bar\n**Status:** OPEN\n**Topic:** t\nbody\n"
    const m = parseMailbox(text)[0]
    expect(m.header).toBe("2026-11-09 — from foo → to bar")
    expect(m.from).toBe("foo")
    expect(m.to).toBe("bar")
  })

  it("parses an ASCII -> arrow and hyphen dash", () => {
    const text = "### 2026-11-09 - from foo -> to bar\n**Status:** OPEN\n**Topic:** t\nbody\n"
    const m = parseMailbox(text)[0]
    expect(m.from).toBe("foo")
    expect(m.to).toBe("bar")
  })

  it("parses multiple messages", () => {
    const text = [
      "### 2026-11-09 10:00 — from a → to x",
      "**Status:** OPEN",
      "**Topic:** first",
      "body one",
      "",
      "### 2026-11-09 10:01 — from b → to y",
      "**Status:** DONE",
      "**Topic:** second",
      "body two",
      "",
    ].join("\n")
    const msgs = parseMailbox(text)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].topic).toBe("first")
    expect(msgs[0].status).toBe("OPEN")
    expect(msgs[1].topic).toBe("second")
    expect(msgs[1].status).toBe("DONE")
    expect(msgs[1].body).toBe("body two")
  })

  it("handles CRLF line endings", () => {
    const text = "### 2026-11-09 10:00 — from a → to b\r\n**Status:** OPEN\r\n**Topic:** t\r\nbody\r\n"
    const m = parseMailbox(text)[0]
    expect(m.header).toBe("2026-11-09 10:00 — from a → to b")
    expect(m.status).toBe("OPEN")
    expect(m.topic).toBe("t")
    expect(m.body).toBe("body")
  })

  it("handles missing status and topic", () => {
    const text = "### 2026-11-09 10:00 — from a → to b\njust a body\n"
    const m = parseMailbox(text)[0]
    expect(m.status).toBe("")
    expect(m.statusStart).toBe(-1)
    expect(m.statusEnd).toBe(-1)
    expect(m.topic).toBe("")
    expect(m.body).toBe("just a body")
  })

  it("records exact status token offsets", () => {
    const text = "### 2026-11-09 10:00 — from a → to b\n**Status:** OPEN\n**Topic:** t\nbody\n"
    const m = parseMailbox(text)[0]
    expect(m.statusStart).toBeGreaterThanOrEqual(0)
    expect(text.slice(m.statusStart, m.statusEnd)).toBe("OPEN")
    expect(text.slice(m.statusStart, m.statusLineEnd)).toBe("OPEN")
  })

  it("keeps the status token but exposes the whole annotated status line", () => {
    const text =
      "### 2026-11-10 — from workspace → to b\n**Status:** OPEN (confirm one detail)\n**Topic:** t\nbody\n"
    const m = parseMailbox(text)[0]
    expect(m.status).toBe("OPEN")
    expect(text.slice(m.statusStart, m.statusEnd)).toBe("OPEN")
    expect(text.slice(m.statusStart, m.statusLineEnd)).toBe("OPEN (confirm one detail)")
  })

  it("ignores a `###` line that is not a message header", () => {
    const text = "### just some header\n**Status:** OPEN\n**Topic:** t\nbody\n"
    expect(parseMailbox(text)).toEqual([])
  })

  it("keeps a markdown subheading inside the message body", () => {
    const text =
      "### 2026-11-09 10:00 — from a → to b\n**Status:** OPEN\n**Topic:** t\nintro\n### Notes\nmore\n"
    const messages = parseMailbox(text)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toContain("### Notes")
    expect(messages[0].body).toContain("more")
  })

  it("hash is stable across a status flip", () => {
    const open = "### 2026-11-09 10:00 — from a → to b\n**Status:** OPEN\n**Topic:** t\nbody\n"
    const done = open.replace("**Status:** OPEN", "**Status:** DONE")
    expect(parseMailbox(open)[0].hash).toBe(parseMailbox(done)[0].hash)
  })

  it("hash differs when topic or body change", () => {
    const base = "### 2026-11-09 10:00 — from a → to b\n**Status:** OPEN\n**Topic:** t\nbody\n"
    const m0 = parseMailbox(base)[0]
    expect(parseMailbox(base.replace("**Topic:** t\n", "**Topic:** t2\n"))[0].hash).not.toBe(m0.hash)
    expect(parseMailbox(base.replace("body\n", "body2\n"))[0].hash).not.toBe(m0.hash)
  })

  it("handles a trailing message without a final newline", () => {
    const text = "### 2026-11-09 10:00 — from a → to b\n**Status:** OPEN\n**Topic:** t\nbody without newline"
    const m = parseMailbox(text)[0]
    expect(m.body).toBe("body without newline")
  })
})
