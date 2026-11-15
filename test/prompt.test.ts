import { describe, expect, it } from "vitest"
import { buildDeliveryPrompt, buildIdlePrompt } from "../src/prompt.js"
import type { MailboxMessage } from "../src/parser.js"

function message(topic: string): MailboxMessage {
  return {
    header: `2026-11-09 10:30 — from a → to b`,
    from: "a",
    to: "b",
    status: "OPEN",
    topic,
    body: "body",
    start: 0,
    end: 0,
    statusStart: 0,
    statusEnd: 0,
    statusLineEnd: 0,
    hash: topic,
  }
}

describe("buildIdlePrompt", () => {
  it("names the mailbox tools so the agent never hand-edits files", () => {
    const text = buildIdlePrompt("foo", [message("t")])
    expect(text).toContain("mailbox_read")
    expect(text).toContain("mailbox_ack")
  })

  it("carries the append-only rule", () => {
    expect(buildIdlePrompt("foo", [message("t")])).toMatch(/append-only/i)
  })

  it("carries the routing rule", () => {
    expect(buildIdlePrompt("foo", [message("t")])).toMatch(/escalate/i)
  })

  it("forbids writing another project's SESSION.md", () => {
    expect(buildIdlePrompt("foo", [message("t")])).toContain("SESSION.md")
  })

  it("still lists the topics", () => {
    expect(buildIdlePrompt("foo", [message("alpha"), message("beta")])).toContain("- alpha")
  })
})

describe("buildDeliveryPrompt", () => {
  const text = buildDeliveryPrompt("a", "b", "topic here", "read it")

  it("carries the same protocol block", () => {
    expect(text).toContain("mailbox_read")
    expect(text).toMatch(/append-only/i)
    expect(text).toMatch(/escalate/i)
    expect(text).toContain("SESSION.md")
  })

  it("keeps the sender, recipient, topic and read instruction", () => {
    expect(text).toContain("a")
    expect(text).toContain("b")
    expect(text).toContain("topic here")
    expect(text).toContain("read it")
  })
})
