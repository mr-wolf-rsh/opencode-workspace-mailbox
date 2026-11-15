import type { MailboxMessage } from "./parser.js"

/**
 * The rules a session needs to act correctly on a mailbox message.
 *
 * These live in the prompt on purpose: the `workspace-mailbox` skill is the
 * long-form reference, but delivery must stay correct when the skill is absent
 * or out of date. Keep this short — it rides on every idle and delivery prompt.
 */
export const MAILBOX_PROTOCOL = [
  "Protocol:",
  "- Use `mailbox_read`, `mailbox_ack`, and `mailbox_send`; do not hand-edit mailbox files.",
  "- Append-only: never rewrite history; the only permitted edit is a `**Status:**` line.",
  "- Route by recipient: `workspace` is this tier's own inbox, an account name escalates up or goes lateral, anything else delegates down.",
  "- Never write another project's `SESSION.md`; answer through the mailbox instead.",
].join("\n")

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

export function buildIdlePrompt(
  project: string,
  messages: MailboxMessage[],
  readInstruction?: string,
): string {
  const n = messages.length
  const topics = messages.map((m) => `- ${truncate(m.topic || "(no topic)", 120)}`).join("\n")
  return (
    `You have ${n} OPEN mailbox message(s) for this project.\n\n` +
    `Load the \`workspace-mailbox\` skill, ${readInstruction ?? `read \`handoffs/${project}.md\``}, handle every OPEN message,\n` +
    `flip each one to DONE (use \`mailbox_ack\`), and reply only if a decision is needed.\n\n` +
    `${MAILBOX_PROTOCOL}\n\n` +
    `Topics:\n${topics}`
  )
}

export function buildCapNotice(project: string, count: number, maxAutoRounds = 2): string {
  return `Mailbox: ${count} OPEN message(s) in ${project} — auto-handling stopped after ${maxAutoRounds} round(s); ask me to handle them.`
}

/** Instruction used when a sender delivers a message into another session. */
export function buildDeliveryPrompt(
  from: string,
  to: string,
  topic: string,
  readInstruction: string,
): string {
  return (
    `A new mailbox message from ${from} was just delivered to ${to}.\n\n` +
    `Topic: ${topic}\n\n` +
    `Load the \`workspace-mailbox\` skill, ${readInstruction}, handle this message, ` +
    `flip it to DONE with \`mailbox_ack\`, and reply with \`mailbox_send\` only if a decision is needed.\n\n` +
    MAILBOX_PROTOCOL
  )
}
