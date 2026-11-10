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
let toasts: unknown[]
let hooks: Hooks

function buildClient() {
  return {
    session: {
      prompt: async (opts: unknown) => {
        prompts.push(opts)
        return {}
      },
    },
    tui: {
      showToast: async (opts: unknown) => {
        toasts.push(opts)
        return true
      },
    },
  }
}

async function setup(options: Record<string, unknown> = {}) {
  prompts = []
  toasts = []
  const client = buildClient()
  const input = {
    client,
    project: { id: "p", worktree: tmp, time: { created: 0 } },
    directory: tmp,
    worktree: tmp,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  } as unknown as Parameters<typeof server>[0]
  hooks = await server(input, { mailboxDir, project: "test-project", cooldownMs: 0, ...options })
}

const fireIdle = async (sid: string) => {
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: sid } } as never })
}

const fireEcho = async (sid: string) => {
  await hooks["chat.message"]!({ sessionID: sid }, { message: {} as never, parts: [] })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const append = (topic: string, body: string) =>
  sendMessage({ mailboxDir, to: "test-project", from: "other", topic, body })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  mailboxDir = path.join(tmp, "handoffs")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("dedupe", () => {
  it("prompts once per hash, and again for a new hash", async () => {
    await setup()
    const sid = "s1"

    append("t1", "b1")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(1)

    await fireEcho(sid)

    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(1)

    append("t2", "b2")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(2)
  })
})
