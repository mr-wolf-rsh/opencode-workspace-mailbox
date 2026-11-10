import { createHash } from "node:crypto"

export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
}

export function messageHash(parts: { header: string; topic: string; body: string }): string {
  const header = normalizeForHash(parts.header)
  const topic = normalizeForHash(parts.topic)
  const body = normalizeForHash(parts.body)
  return createHash("sha256").update(`${header}\n${topic}\n${body}`).digest("hex").slice(0, 16)
}
