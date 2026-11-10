import { describe, expect, it } from "vitest"
import path from "node:path"
import { assertInside, isSafeRecipient, mailboxFile, PathSafetyError, resolveInside } from "../src/paths.js"
import { normalizeConfig } from "../src/config.js"

const base = path.resolve("base-dir")

describe("isSafeRecipient", () => {
  it("accepts lowercase kebab-case", () => {
    expect(isSafeRecipient("foo")).toBe(true)
    expect(isSafeRecipient("foo-bar-2")).toBe(true)
    expect(isSafeRecipient("a1-b2-c3")).toBe(true)
  })

  it("rejects invalid names", () => {
    expect(isSafeRecipient("Foo")).toBe(false)
    expect(isSafeRecipient("foo bar")).toBe(false)
    expect(isSafeRecipient("../x")).toBe(false)
    expect(isSafeRecipient("a/b")).toBe(false)
    expect(isSafeRecipient("a\\b")).toBe(false)
    expect(isSafeRecipient("")).toBe(false)
    expect(isSafeRecipient(123)).toBe(false)
    expect(isSafeRecipient(undefined)).toBe(false)
    expect(isSafeRecipient(null)).toBe(false)
  })
})

describe("resolveInside / assertInside", () => {
  it("resolves a path inside the base", () => {
    expect(resolveInside(base, "sub", "file.md")).toBe(path.resolve(base, "sub", "file.md"))
  })

  it("rejects traversal", () => {
    expect(() => resolveInside(base, "..", "evil.md")).toThrow(PathSafetyError)
    expect(() => resolveInside(base, "..")).toThrow(PathSafetyError)
    expect(() => resolveInside(base, "../evil.md")).toThrow(PathSafetyError)
  })

  it("assertInside rejects escaping candidates", () => {
    expect(() => assertInside(base, "../../x.json", "stateFile")).toThrow(PathSafetyError)
  })
})

describe("mailboxFile", () => {
  it("builds a file path for a valid recipient", () => {
    expect(mailboxFile(base, "foo")).toBe(path.join(base, "foo.md"))
  })

  it("rejects traversal recipients", () => {
    expect(() => mailboxFile(base, "../evil")).toThrow(PathSafetyError)
    expect(() => mailboxFile(base, "a/b")).toThrow(PathSafetyError)
  })
})

describe("normalizeConfig", () => {
  it("applies defaults", () => {
    const cfg = normalizeConfig(undefined, base)
    expect(cfg.project).toBe(path.basename(path.resolve(base)))
    expect(cfg.mailboxDir).toBe(path.join(base, "handoffs"))
    expect(cfg.maxAutoRounds).toBe(2)
    expect(cfg.cooldownMs).toBe(30000)
    expect(cfg.enabled).toBe(true)
    expect(cfg.stateFile).toBe(path.join(base, ".atl", "mailbox-state.json"))
  })

  it("clamps and coerces numeric options, ignoring wrong types", () => {
    const cfg = normalizeConfig({ maxAutoRounds: 99, cooldownMs: -5, enabled: false }, base)
    expect(cfg.maxAutoRounds).toBe(20)
    expect(cfg.cooldownMs).toBe(0)
    expect(cfg.enabled).toBe(false)

    const cfg2 = normalizeConfig({ maxAutoRounds: "3", cooldownMs: "1000", enabled: "yes" } as never, base)
    expect(cfg2.maxAutoRounds).toBe(2)
    expect(cfg2.cooldownMs).toBe(30000)
    expect(cfg2.enabled).toBe(true)
  })

  it("rejects an escaping stateFile", () => {
    expect(() => normalizeConfig({ stateFile: "../../x.json" }, base)).toThrow(PathSafetyError)
  })

  it("rejects an invalid project name", () => {
    expect(() => normalizeConfig({ project: "Bad Name" }, base)).toThrow(/Invalid project name/)
    expect(() => normalizeConfig({ project: "UPPER" }, base)).toThrow(/Invalid project name/)
  })

  it("derives a kebab-case project name from a messy directory name", () => {
    const cfg = normalizeConfig({}, path.join(base, "My.Project"))
    expect(cfg.project).toBe("my-project")
  })
})
