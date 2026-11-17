import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { server } from "../src/index.js"
import { createSqliteStore } from "../src/sqlite-store.js"
import { createFileStore } from "../src/store.js"
import { sendMessage } from "../src/mailbox.js"
import { parseMailbox } from "../src/parser.js"

type Hooks = Awaited<ReturnType<typeof server>>

let available = true
try {
  createRequire(import.meta.url)("node:sqlite")
} catch {
  available = false
}

let tmp: string
let mailboxDir: string
let prompts: string[]
let hooks: Hooks | undefined

async function setup(options: Record<string, unknown> = {}) {
  prompts = []
  const client = {
    session: {
      prompt: async (params: Record<string, unknown>) => {
        const parts = (params.body as { parts?: Array<{ text?: string }> })?.parts ?? []
        prompts.push(parts.map((part) => part.text ?? "").join("\n"))
        return {}
      },
      list: async () => ({ data: [] }),
    },
    tui: { showToast: async () => true },
  }
  const input = {
    client,
    project: { id: "p", worktree: tmp, time: { created: 0 } },
    directory: tmp,
    worktree: tmp,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  } as unknown as Parameters<typeof server>[0]
  hooks = await server(input, {
    mailboxDir,
    project: "test-project",
    cooldownMs: 0,
    ...options,
  })
}

/** Like setup(), but without an explicit mailboxDir so tier discovery runs. */
async function setupAt(directory: string, options: Record<string, unknown> = {}) {
  prompts = []
  const client = {
    session: {
      prompt: async (params: Record<string, unknown>) => {
        const parts = (params.body as { parts?: Array<{ text?: string }> })?.parts ?? []
        prompts.push(parts.map((part) => part.text ?? "").join("\n"))
        return {}
      },
      list: async () => ({ data: [] }),
    },
    tui: { showToast: async () => true },
  }
  const input = {
    client,
    project: { id: "p", worktree: directory, time: { created: 0 } },
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  } as unknown as Parameters<typeof server>[0]
  hooks = await server(input, { cooldownMs: 0, ...options })
}

const idle = async (sid = "s1") => {
  await hooks!.event!({
    event: { type: "session.idle", properties: { sessionID: sid } } as never,
  })
}

const send = (to: string, topic = "t", extra: Record<string, unknown> = {}) =>
  hooks!.tool.mailbox_send.execute({ to, topic, body: "body", ...extra }, { sessionID: "s1" } as never)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-feat-"))
  mailboxDir = path.join(tmp, "handoffs")
  fs.mkdirSync(mailboxDir, { recursive: true })
  hooks = undefined
})

afterEach(async () => {
  await hooks?.dispose?.()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("broadcast (to: all)", () => {
  it("copies the message into every project mailbox", async () => {
    await setup({ deliverOnSend: "off" })
    sendMessage({ mailboxDir, to: "alpha", from: "w", topic: "existing", body: "b" })
    sendMessage({ mailboxDir, to: "beta", from: "w", topic: "existing", body: "b" })

    const result = await send("all", "convention change")
    expect(result.metadata).toMatchObject({ broadcast: 3 }) // alpha, beta, test-project

    for (const project of ["alpha", "beta", "test-project"]) {
      const text = fs.readFileSync(path.join(mailboxDir, `${project}.md`), "utf8")
      expect(text).toContain("**Topic:** convention change")
      const parsed = parseMailbox(text)
      expect(parsed[parsed.length - 1].to).toBe("all")
    }
  })

  it("does not re-prompt the sender for its own broadcast", async () => {
    await setup({ deliverOnSend: "off" })
    await send("all", "broadcast topic")
    await idle()
    expect(prompts).toHaveLength(0)
  })
})

describe("since watermark", () => {
  it("ignores messages older than the watermark", async () => {
    sendMessage({
      mailboxDir,
      to: "test-project",
      from: "w",
      topic: "old message",
      body: "b",
      now: new Date(2020, 0, 1, 10, 0),
    })
    sendMessage({
      mailboxDir,
      to: "test-project",
      from: "w",
      topic: "new message",
      body: "b",
      now: new Date(2026, 10, 9, 10, 0),
    })
    await setup({ since: "2026-01-01T00:00:00Z" })

    await idle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("new message")
    expect(prompts[0]).not.toContain("old message")
  })
})

describe("retention", () => {
  const seed = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "alpha.md"),
      "### 2020-01-01 10:00 — from w → to alpha\n**Status:** DONE\n**Topic:** ancient done\nb\n\n" +
        "### 2020-01-02 10:00 — from w → to alpha\n**Status:** OPEN\n**Topic:** ancient open\nb\n\n" +
        "### 2026-11-01 10:00 — from w → to alpha\n**Status:** DONE\n**Topic:** recent done\nb\n",
      "utf8",
    )
  }

  it("file backend moves only old DONE messages", async () => {
    seed(mailboxDir)
    const store = createFileStore(mailboxDir)
    const moved = store.archive("alpha", new Date(2024, 0, 1).getTime())
    expect(moved).toBe(1)

    const remaining = store.read("alpha").map((m) => m.topic)
    expect(remaining).toEqual(["ancient open", "recent done"])
    const archived = parseMailbox(
      fs.readFileSync(path.join(mailboxDir, "_archive", "alpha.md"), "utf8"),
    )
    expect(archived).toHaveLength(1)
    expect(archived[0].topic).toBe("ancient done")
  })

  it.skipIf(!available)("sqlite backend moves only old DONE rows", async () => {
    const store = await createSqliteStore(path.join(mailboxDir, ".mailbox.db"), {
      legacyDir: mailboxDir,
      mirror: false,
    })
    store.append("alpha", { from: "w", topic: "ancient done", body: "b", now: new Date(2020, 0, 1), status: "DONE" })
    store.append("alpha", { from: "w", topic: "ancient open", body: "b", now: new Date(2020, 0, 2) })
    store.append("alpha", { from: "w", topic: "recent done", body: "b", now: new Date(2026, 10, 1), status: "DONE" })

    const moved = store.archive("alpha", new Date(2024, 0, 1).getTime())
    expect(moved).toBe(1)
    expect(store.read("alpha").map((m) => m.topic)).toEqual(["ancient open", "recent done"])
    store.close?.()
  })

  it("is exercised by the prune tool with a dry run", async () => {
    seed(mailboxDir)
    await setup({ retentionDays: 365 })
    const preview = await hooks!.tool.mailbox_prune.execute({ dryRun: true }, {} as never)
    expect(preview.output).toContain("would archive 1")
    const applied = await hooks!.tool.mailbox_prune.execute({}, {} as never)
    expect(applied.output).toContain("archived 1")
  })
})

describe.skipIf(!available)("cross-tier sqlite import (issue #1)", () => {
  const oneOpen = (project: string, topic: string) =>
    `### 2026-11-09 10:00 — from workspace → to ${project}\n**Status:** OPEN\n**Topic:** ${topic}\nbody\n`

  async function seedTwoAccounts(container: string) {
    fs.writeFileSync(
      path.join(container, "handoffs", "workspace.md"),
      "# workspace mailbox\n\nMessages addressed to `workspace`. Append-only.\n",
      "utf8",
    )
    const accounts = [
      { name: "acme", project: "alpha", topic: "alpha-topic" },
      { name: "globex", project: "beta", topic: "beta-topic" },
    ]
    for (const account of accounts) {
      const handoffs = path.join(container, account.name, "handoffs")
      fs.mkdirSync(handoffs, { recursive: true })
      fs.writeFileSync(path.join(handoffs, `${account.project}.md`), oneOpen(account.project, account.topic), "utf8")
    }
    return accounts
  }

  it("warns about unimported sibling inboxes, then imports them into their own databases", async () => {
    const container = tmp
    const accounts = await seedTwoAccounts(container)
    await setupAt(container, { storage: "sqlite" })

    const before = await hooks!.tool.mailbox_status.execute({} as never, {} as never)
    expect(before.output).toContain("acme")
    expect(before.output).toContain("1 unread")
    expect(before.output).toContain("not imported")

    const first = await hooks!.tool.mailbox_migrate.execute({ to: "sqlite" } as never, {} as never)
    expect(first.output).toContain("acme")
    expect(first.output).toContain("globex")

    for (const account of accounts) {
      const dir = path.join(container, account.name, "handoffs")
      const store = await createSqliteStore(path.join(dir, ".mailbox.db"), { legacyDir: dir, autoImport: false })
      expect(store.listOpen(account.project)).toHaveLength(1)
      store.close?.()
    }

    // Idempotent: a second run adds nothing.
    await hooks!.tool.mailbox_migrate.execute({ to: "sqlite" } as never, {} as never)
    const again = await createSqliteStore(path.join(container, "acme", "handoffs", ".mailbox.db"), {
      legacyDir: path.join(container, "acme", "handoffs"),
      autoImport: false,
    })
    expect(again.read("alpha")).toHaveLength(1)
    again.close?.()

    // Once imported, the warning disappears.
    const after = await hooks!.tool.mailbox_status.execute({} as never, {} as never)
    expect(after.output).not.toContain("not imported")
  })
})
