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

async function setup(options: Record<string, unknown> = {}) {
  prompts = []
  toasts = []
  const client = {
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

const fireHuman = async (sid: string) => {
  await hooks["chat.message"]!({ sessionID: sid }, { message: {} as never, parts: [] })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const append = (topic: string) =>
  sendMessage({ mailboxDir, to: "test-project", from: "other", topic, body: topic })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  mailboxDir = path.join(tmp, "handoffs")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("round cap", () => {
  it("stops prompting after maxAutoRounds and surfaces a notice", async () => {
    await setup({ maxAutoRounds: 2 })
    const sid = "s1"

    append("t1")
    await fireIdle(sid)
    await flush()
    await fireEcho(sid)
    expect(prompts).toHaveLength(1)

    append("t2")
    await fireIdle(sid)
    await flush()
    await fireEcho(sid)
    expect(prompts).toHaveLength(2)

    append("t3")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(2)
    expect(toasts).toHaveLength(1)
  })

  it("does not repeat the cap notice on repeated idles", async () => {
    await setup({ maxAutoRounds: 1 })
    const sid = "s1"

    append("t1")
    await fireIdle(sid)
    await flush()
    await fireEcho(sid)

    append("t2")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)

    await fireIdle(sid)
    await flush()
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)
  })

  it("a human message resets the round budget", async () => {
    await setup({ maxAutoRounds: 2 })
    const sid = "s1"

    append("t1")
    await fireIdle(sid)
    await flush()
    await fireEcho(sid)

    append("t2")
    await fireIdle(sid)
    await flush()
    await fireEcho(sid)

    append("t3")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(2)

    await fireHuman(sid)

    append("t4")
    await fireIdle(sid)
    await flush()
    expect(prompts).toHaveLength(3)
  })
})
