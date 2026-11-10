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
let hooks: Hooks | undefined

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

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
  hooks = await server(input, {
    mailboxDir,
    project: "test-project",
    wake: true,
    pollMs: 100,
    cooldownMs: 0,
    ...options,
  })
}

const register = async (sid: string) => {
  await hooks!.event!({
    event: { type: "session.created", properties: { info: { id: sid, directory: tmp } } } as never,
  })
}

const status = async (sid: string, type: "idle" | "busy") => {
  await hooks!.event!({
    event: { type: "session.status", properties: { sessionID: sid, status: { type } } } as never,
  })
}

const append = (topic: string) =>
  sendMessage({ mailboxDir, to: "test-project", from: "other", topic, body: topic })

/** Simulate the runtime delivering the plugin's own prompt as chat.message. */
const echo = (sid: string) =>
  hooks!["chat.message"]!({ sessionID: sid }, { message: {} as never, parts: [] })

const ackTool = (hash: string, sessionID: string) =>
  hooks!.tool.mailbox_ack.execute({ hash }, { sessionID } as never)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  mailboxDir = path.join(tmp, "handoffs")
  hooks = undefined
})

afterEach(async () => {
  await hooks?.dispose?.()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("wake path", () => {
  it("wakes an idle session on a new message without any idle transition", async () => {
    await setup()
    await register("s1")

    append("t1")
    await flush(300)

    expect(prompts).toHaveLength(1)

    // Once the prompt is echoed, dedupe (not the pending flag) must keep the
    // same message from being delivered twice by a later tick.
    await echo("s1")
    await flush(300)
    expect(prompts).toHaveLength(1)
  })

  it("does not interrupt a busy session", async () => {
    await setup()
    await register("s1")
    await status("s1", "busy")

    append("t1")
    await flush(300)
    expect(prompts).toHaveLength(0)

    await status("s1", "idle")
    await flush(300)
    expect(prompts).toHaveLength(1)
  })

  it("stops polling after dispose", async () => {
    await setup()
    await register("s1")
    await hooks!.dispose!()

    append("t1")
    await flush(300)
    expect(prompts).toHaveLength(0)
  })

  it("does not wake when the wake option is off", async () => {
    await setup({ wake: false })
    await register("s1")

    append("t1")
    await flush(300)
    expect(prompts).toHaveLength(0)
  })

  it("restores the round budget when a message is acked", async () => {
    await setup({ maxAutoRounds: 1 })
    await register("s1")

    append("t1")
    await flush(300)
    expect(prompts).toHaveLength(1)
    await echo("s1")

    // The cap is now reached: a second message must not be delivered.
    append("t2")
    await flush(300)
    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)

    const hash = /Hash: (\w+)/.exec(
      (await hooks!.tool.mailbox_read.execute({ project: "test-project" }, {} as never)).output,
    )![1]
    await ackTool(hash, "s1")

    await flush(300)
    expect(prompts).toHaveLength(2)
  })
})
