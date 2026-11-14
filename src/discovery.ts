import { existsSync } from "node:fs"
import path from "node:path"

export type Tier = "meta" | "account" | "repo" | "custom"

export type TierContext = {
  tier: Tier
  /** Mailbox identity inside its own tier: "workspace" for a tier root, else the directory name. */
  project: string
  /** Directory holding this tier's files: `<tierRoot>/handoffs`. */
  mailboxDir: string
  /** Session directory the context was derived from. */
  directory: string
  /** The account directory (account or repo tier). */
  accountRoot?: string
  accountName?: string
  /** The workspace root directory (meta tier, or the ancestor above an account). */
  rootDir?: string
  /** The root tier's handoffs directory, when one exists above this tier. */
  rootMailboxDir?: string
}

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function hasHandoffs(dir: string): boolean {
  return existsSync(path.join(dir, "handoffs", "workspace.md")) || existsSync(path.join(dir, "handoffs"))
}

/**
 * Derive the tier from the folder tree:
 *
 *   - a directory with its own `handoffs/` is a tier root: meta when nothing
 *     above it has one, account when the parent does;
 *   - anything else belongs to the nearest ancestor that has one (repo tier),
 *     whatever the bucket depth (`<account>/tools/<repo>` still resolves);
 *   - an explicit `mailboxDir` in config overrides discovery entirely.
 */
export function discoverTier(
  directory: string,
  explicit?: { mailboxDir?: string; project?: string },
): TierContext {
  const dir = path.resolve(directory)

  if (explicit?.mailboxDir) {
    const mailboxDir = path.resolve(explicit.mailboxDir)
    const inside = isStrictlyInside(dir, mailboxDir)
    return {
      tier: "custom",
      project: explicit.project ?? (inside ? "workspace" : kebab(path.basename(dir))),
      mailboxDir,
      directory: dir,
      rootDir: inside ? path.dirname(mailboxDir) : undefined,
      rootMailboxDir: inside ? mailboxDir : undefined,
    }
  }

  if (hasHandoffs(dir)) {
    const parent = path.dirname(dir)
    const above = parent !== dir && hasHandoffs(parent)
    return {
      tier: above ? "account" : "meta",
      project: "workspace",
      mailboxDir: path.join(dir, "handoffs"),
      directory: dir,
      accountRoot: above ? dir : undefined,
      accountName: above ? kebab(path.basename(dir)) : undefined,
      rootDir: above ? parent : dir,
      rootMailboxDir: path.join(above ? parent : dir, "handoffs"),
    }
  }

  let cursor = dir
  for (;;) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    if (hasHandoffs(parent)) {
      const grand = path.dirname(parent)
      return {
        tier: "repo",
        project: kebab(path.basename(dir)),
        mailboxDir: path.join(parent, "handoffs"),
        directory: dir,
        accountRoot: parent,
        accountName: kebab(path.basename(parent)),
        rootDir: grand,
        rootMailboxDir: hasHandoffs(grand) ? path.join(grand, "handoffs") : undefined,
      }
    }
    cursor = parent
  }

  return {
    tier: "repo",
    project: kebab(path.basename(dir)),
    mailboxDir: path.join(dir, "handoffs"),
    directory: dir,
  }
}

export type Route = { mailboxDir: string; project: string }

/**
 * Where a message addressed to `to` belongs.
 *   - `workspace`      -> this tier's own inbox (the tier root's `workspace.md`)
 *   - an account name  -> the root tier's `<account>.md` (escalate up / lateral between accounts)
 *   - anything else    -> a sibling/child file in this tier (lateral / delegate down)
 */
export function routeRecipient(to: string, ctx: TierContext): Route {
  if (to === "workspace") return { mailboxDir: ctx.mailboxDir, project: "workspace" }
  if (to === ctx.project) return { mailboxDir: ctx.mailboxDir, project: ctx.project }

  if (ctx.tier !== "meta" && ctx.rootMailboxDir) {
    const ownAccount = ctx.accountName !== undefined && to === ctx.accountName
    const siblingAccount =
      existsSync(path.join(ctx.rootMailboxDir, `${to}.md`)) ||
      (ctx.rootDir !== undefined && hasHandoffs(path.join(ctx.rootDir, to)))
    if (ownAccount || siblingAccount) {
      return { mailboxDir: ctx.rootMailboxDir, project: to }
    }
  }

  return { mailboxDir: ctx.mailboxDir, project: to }
}

function isStrictlyInside(base: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(candidate))
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)
}
