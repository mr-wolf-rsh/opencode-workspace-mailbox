import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { sendMessage } from "../src/mailbox.js"
import { server } from "../src/index.js"

type Hooks = Awaited<ReturnType<typeof server>>

let tmp: string
let mailboxDir: string
let prompts: unknown[]
let hooks: Hooks

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  mailboxDir = path.join(tmp, "handoffs")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("cooldown", () => {
  it("blocks a second prompt within the cooldown window", async () => {
    prompts = []
    const client = {
      session: {
        prompt: async (opts: unknown) => {
          prompts.push(opts)
          return {}
        },
      },
      tui: {
        showToast: async () => true,
      },
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
    hooks = await server(input, { mailboxDir, project: "test-project", cooldownMs: 60000 })

    const sid = "s1"
    sendMessage({ mailboxDir, to: "test-project", from: "other", topic: "a", body: "a" })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompts).toHaveLength(1)

    await hooks["chat.message"]!({ sessionID: sid }, { message: {} as never, parts: [] })

    sendMessage({ mailboxDir, to: "test-project", from: "other", topic: "b", body: "b" })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompts).toHaveLength(1)
  })
})
