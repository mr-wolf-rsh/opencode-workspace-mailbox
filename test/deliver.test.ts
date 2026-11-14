import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { server } from "../src/index.js"

type Hooks = Awaited<ReturnType<typeof server>>

let tmp: string
let mailboxDir: string
let created: Array<Record<string, unknown>>
let prompts: Array<Record<string, unknown>>
let existing: Array<{ id: string; directory: string; time: { updated: number } }>
let hooks: Hooks | undefined

async function setup(options: Record<string, unknown> = {}) {
  created = []
  prompts = []
  existing = []
  const client = {
    session: {
      prompt: async (params: Record<string, unknown>) => {
        prompts.push(params)
        return {}
      },
      list: async () => ({ data: existing }),
      create: async (opts: Record<string, unknown>) => {
        created.push(opts)
        return { data: { id: "ses_new", directory: (opts.query as { directory?: string })?.directory } }
      },
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
    deliverOnSend: "auto",
    spawnCooldownMs: 0,
    ...options,
  })
}

const send = (to: string, topic = "t") =>
  hooks!.tool.mailbox_send.execute({ to, topic, body: "body" }, { sessionID: "s1" } as never)

const register = async (id: string, title?: string) => {
  await hooks!.event!({
    event: { type: "session.created", properties: { info: { id, directory: tmp, title } } } as never,
  })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"))
  mailboxDir = path.join(tmp, "handoffs")
  fs.mkdirSync(path.join(tmp, "alpha"), { recursive: true })
  fs.mkdirSync(path.join(tmp, "beta"), { recursive: true })
  hooks = undefined
})

afterEach(async () => {
  await hooks?.dispose?.()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("deliver on send", () => {
  it("does nothing when deliverOnSend is off", async () => {
    await setup({ deliverOnSend: "off" })
    const result = await send("alpha")
    expect(created).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(result.output).not.toContain("Delivery:")
  })

  it("auto: creates a session when none exists, then prompts it", async () => {
    await setup()
    const result = await send("alpha", "wire the importer")

    expect(created).toHaveLength(1)
    expect(created[0].query).toEqual({ directory: path.join(tmp, "alpha") })
    expect(prompts).toHaveLength(1)
    expect((prompts[0].path as { id: string }).id).toBe("ses_new")
    expect(prompts[0].query).toEqual({ directory: path.join(tmp, "alpha") })
    expect(String((prompts[0].body as { parts: Array<{ text: string }> }).parts[0].text)).toContain("wire the importer")
    expect(result.output).toContain("spawned session ses_new")
  })

  it("auto: reuses an existing session instead of creating one", async () => {
    await setup()
    existing = [{ id: "ses_existing", directory: path.join(tmp, "alpha"), time: { updated: 1 } }]

    const result = await send("alpha")
    expect(created).toHaveLength(0)
    expect(prompts).toHaveLength(1)
    expect((prompts[0].path as { id: string }).id).toBe("ses_existing")
    expect(result.output).toContain("reused session ses_existing")
    expect(result.metadata).toMatchObject({ delivered: true, spawned: false })
  })

  it("reuse: never creates a session", async () => {
    await setup({ deliverOnSend: "reuse" })
    const result = await send("alpha")

    expect(created).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(result.output).toContain("no session to reuse")
  })

  it("spawn: always creates a fresh session even when one exists", async () => {
    await setup({ deliverOnSend: "spawn" })
    existing = [{ id: "ses_existing", directory: path.join(tmp, "alpha"), time: { updated: 1 } }]

    const result = await send("alpha")
    expect(created).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect((prompts[0].path as { id: string }).id).toBe("ses_new")
    expect(result.metadata).toMatchObject({ delivered: true, spawned: true })
  })

  it("enforces the delivery cooldown", async () => {
    await setup({ spawnCooldownMs: 60000 })
    await send("alpha")
    const second = await send("beta")

    expect(prompts).toHaveLength(1)
    expect(second.output).toContain("spawn cooldown")
  })

  it("enforces the per-turn delivery cap", async () => {
    await setup({ maxSpawnsPerTurn: 1 })
    await send("alpha")
    const second = await send("beta")

    expect(prompts).toHaveLength(1)
    expect(second.output).toContain("max 1 spawn(s) per turn")
  })

  it("never delivers from a session the plugin created (loop guard)", async () => {
    await setup()
    await register("s1", "mailbox: workspace")

    const result = await send("alpha")
    expect(created).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(result.output).toContain("loop guard")
  })

  it("reports when the recipient directory cannot be resolved", async () => {
    await setup()
    const result = await send("nowhere")

    expect(created).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(result.output).toContain('no directory known for "nowhere"')
  })

  it("uses an explicit projectDirs mapping over the sibling heuristic", async () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-dir-"))
    try {
      await setup({ projectDirs: { alpha: custom } })
      await send("alpha")
      expect(created).toHaveLength(1)
      expect(created[0].query).toEqual({ directory: path.resolve(custom) })
    } finally {
      fs.rmSync(custom, { recursive: true, force: true })
    }
  })

  it("finds a repo nested in a bucket directory", async () => {
    fs.rmSync(path.join(tmp, "alpha"), { recursive: true, force: true })
    fs.mkdirSync(path.join(tmp, "tools", "alpha", "packages"), { recursive: true })

    await setup()
    const result = await send("alpha")
    expect(created).toHaveLength(1)
    expect(created[0].query).toEqual({ directory: path.join(tmp, "tools", "alpha") })
    expect(result.output).toContain("spawned session")
  })
})
