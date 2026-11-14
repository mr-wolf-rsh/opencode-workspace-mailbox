import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { discoverTier, routeRecipient } from "../src/discovery.js"

let tmp: string

const touch = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "x", "utf8")
}

const workspace = (dir: string) => touch(path.join(dir, "handoffs", "workspace.md"))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-tier-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("discoverTier", () => {
  it("classifies the workspace root as the meta tier", () => {
    workspace(tmp)
    const ctx = discoverTier(tmp)
    expect(ctx.tier).toBe("meta")
    expect(ctx.project).toBe("workspace")
    expect(ctx.mailboxDir).toBe(path.join(tmp, "handoffs"))
    expect(ctx.rootMailboxDir).toBe(path.join(tmp, "handoffs"))
  })

  it("classifies a directory under the root as the account tier", () => {
    workspace(tmp)
    const account = path.join(tmp, "mr-wolf-rsh")
    workspace(account)

    const ctx = discoverTier(account)
    expect(ctx.tier).toBe("account")
    expect(ctx.project).toBe("workspace")
    expect(ctx.accountName).toBe("mr-wolf-rsh")
    expect(ctx.mailboxDir).toBe(path.join(account, "handoffs"))
    expect(ctx.rootMailboxDir).toBe(path.join(tmp, "handoffs"))
  })

  it("classifies a nested bucket repo against the account mailbox", () => {
    workspace(tmp)
    const account = path.join(tmp, "mr-wolf-rsh")
    workspace(account)
    const repo = path.join(account, "tools", "opencode-workspace-mailbox")
    fs.mkdirSync(repo, { recursive: true })

    const ctx = discoverTier(repo)
    expect(ctx.tier).toBe("repo")
    expect(ctx.project).toBe("opencode-workspace-mailbox")
    expect(ctx.mailboxDir).toBe(path.join(account, "handoffs"))
    expect(ctx.accountRoot).toBe(account)
    expect(ctx.rootDir).toBe(tmp)
  })

  it("handles a direct child repo", () => {
    workspace(tmp)
    const account = path.join(tmp, "absolute-labs-studio")
    workspace(account)
    const repo = path.join(account, "absolute-scrapers")
    fs.mkdirSync(repo, { recursive: true })

    const ctx = discoverTier(repo)
    expect(ctx.tier).toBe("repo")
    expect(ctx.project).toBe("absolute-scrapers")
    expect(ctx.mailboxDir).toBe(path.join(account, "handoffs"))
  })

  it("falls back to a local handoffs dir with no ancestor", () => {
    const lonely = path.join(tmp, "solo")
    fs.mkdirSync(lonely, { recursive: true })
    const ctx = discoverTier(lonely)
    expect(ctx.tier).toBe("repo")
    expect(ctx.project).toBe("solo")
    expect(ctx.mailboxDir).toBe(path.join(lonely, "handoffs"))
  })

  it("lets an explicit mailboxDir override discovery", () => {
    workspace(tmp)
    const custom = path.join(tmp, "elsewhere")
    const ctx = discoverTier(tmp, { mailboxDir: custom, project: "pinned" })
    expect(ctx.tier).toBe("custom")
    expect(ctx.project).toBe("pinned")
    expect(ctx.mailboxDir).toBe(path.resolve(custom))
  })

  it("kebab-cases the derived project name", () => {
    workspace(tmp)
    const account = path.join(tmp, "acc")
    workspace(account)
    const repo = path.join(account, "My.Project")
    fs.mkdirSync(repo, { recursive: true })
    expect(discoverTier(repo).project).toBe("my-project")
  })
})

describe("routeRecipient", () => {
  it("routes workspace to the tier's own inbox", () => {
    workspace(tmp)
    const ctx = discoverTier(tmp)
    expect(routeRecipient("workspace", ctx)).toEqual({
      mailboxDir: path.join(tmp, "handoffs"),
      project: "workspace",
    })
  })

  it("routes a sibling or child to the same tier", () => {
    workspace(tmp)
    const account = path.join(tmp, "mr-wolf-rsh")
    workspace(account)
    const ctx = discoverTier(account)
    expect(routeRecipient("some-project", ctx)).toEqual({
      mailboxDir: path.join(account, "handoffs"),
      project: "some-project",
    })
  })

  it("escalates a repo message to its account file in the root tier", () => {
    workspace(tmp)
    const account = path.join(tmp, "mr-wolf-rsh")
    workspace(account)
    const repo = path.join(account, "tools", "opencode-workspace-mailbox")
    fs.mkdirSync(repo, { recursive: true })

    const ctx = discoverTier(repo)
    expect(routeRecipient("mr-wolf-rsh", ctx)).toEqual({
      mailboxDir: path.join(tmp, "handoffs"),
      project: "mr-wolf-rsh",
    })
  })

  it("routes a repo's `workspace` to the account inbox, never its own file", () => {
    workspace(tmp)
    const account = path.join(tmp, "mr-wolf-rsh")
    workspace(account)
    const repo = path.join(account, "tools", "opencode-workspace-mailbox")
    fs.mkdirSync(repo, { recursive: true })

    const ctx = discoverTier(repo)
    expect(routeRecipient("workspace", ctx)).toEqual({
      mailboxDir: path.join(account, "handoffs"),
      project: "workspace",
    })
  })

  it("routes account-to-account messages through the root tier", () => {
    workspace(tmp)
    const mine = path.join(tmp, "mr-wolf-rsh")
    workspace(mine)
    workspace(path.join(tmp, "absolute-labs-studio"))

    const ctx = discoverTier(mine)
    expect(routeRecipient("absolute-labs-studio", ctx)).toEqual({
      mailboxDir: path.join(tmp, "handoffs"),
      project: "absolute-labs-studio",
    })
  })

  it("keeps an account-name send local when already at the root", () => {
    workspace(tmp)
    const ctx = discoverTier(tmp)
    expect(routeRecipient("mr-wolf-rsh", ctx)).toEqual({
      mailboxDir: path.join(tmp, "handoffs"),
      project: "mr-wolf-rsh",
    })
  })
})
