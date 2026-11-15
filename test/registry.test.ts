import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerRecipient } from "../src/registry.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-registry-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const TIER_README = `# Workspace Handoffs

Preamble that must never move.

## Files

| File | Owner (reads/writes) | Holds |
|---|---|---|
| \`workspace.md\` | the root session | messages addressed \`to: workspace\` |
| \`tixlock.md\` | the tixlock repo session | messages addressed \`to: tixlock\` |

Add one file per project as projects are created.

## How it works

- At session start: read the handoff file for YOUR project.
`

function writeReadme(text: string): string {
  const file = path.join(dir, "README.md")
  fs.writeFileSync(file, text, "utf8")
  return file
}

describe("registerRecipient", () => {
  it("appends a row to the Files table", () => {
    const file = writeReadme(TIER_README)
    expect(registerRecipient(file, "newrepo")).toBe("registered")

    const after = fs.readFileSync(file, "utf8")
    expect(after).toContain("| `newrepo.md` |")
    // row lands inside the table, after the last existing row
    expect(after.indexOf("`newrepo.md`")).toBeGreaterThan(after.indexOf("`tixlock.md`"))
    expect(after.indexOf("`newrepo.md`")).toBeLessThan(after.indexOf("Add one file per project"))
  })

  it("leaves the file byte-identical when the recipient is already listed", () => {
    const file = writeReadme(TIER_README)
    const before = fs.readFileSync(file, "utf8")
    expect(registerRecipient(file, "tixlock")).toBe("present")
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  it("reports no-readme when the tier has no README", () => {
    const file = path.join(dir, "README.md")
    expect(registerRecipient(file, "newrepo")).toBe("no-readme")
    expect(fs.existsSync(file)).toBe(false)
  })

  it("reports no-table when the README has no Files table", () => {
    const file = writeReadme("# Title\n\nNo table here.\n")
    const before = fs.readFileSync(file, "utf8")
    expect(registerRecipient(file, "newrepo")).toBe("no-table")
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })

  it("preserves CRLF line endings", () => {
    const file = writeReadme(TIER_README.replace(/\n/g, "\r\n"))
    expect(registerRecipient(file, "newrepo")).toBe("registered")
    const after = fs.readFileSync(file, "utf8")
    expect(after).toContain("| `newrepo.md` |")
    expect((after.match(/\n/g) ?? []).length).toBe((after.match(/\r\n/g) ?? []).length)
  })

  it("does not disturb content before or after the table", () => {
    const file = writeReadme(TIER_README)
    registerRecipient(file, "newrepo")
    const after = fs.readFileSync(file, "utf8")

    expect(after.startsWith("# Workspace Handoffs\n\nPreamble that must never move.\n")).toBe(true)
    expect(after).toContain("| `workspace.md` | the root session |")
    expect(after.endsWith("## How it works\n\n- At session start: read the handoff file for YOUR project.\n")).toBe(true)
  })

  it("is idempotent across repeated calls", () => {
    const file = writeReadme(TIER_README)
    expect(registerRecipient(file, "newrepo")).toBe("registered")
    const once = fs.readFileSync(file, "utf8")
    expect(registerRecipient(file, "newrepo")).toBe("present")
    expect(fs.readFileSync(file, "utf8")).toBe(once)
  })

  it("leaves no lock file behind", () => {
    const file = writeReadme(TIER_README)
    registerRecipient(file, "newrepo")
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
})
