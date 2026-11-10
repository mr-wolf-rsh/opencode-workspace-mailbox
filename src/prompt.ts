import type { MailboxMessage } from "./parser.js"

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

export function buildIdlePrompt(project: string, messages: MailboxMessage[]): string {
  const n = messages.length
  const topics = messages.map((m) => `- ${truncate(m.topic || "(no topic)", 120)}`).join("\n")
  return (
    `You have ${n} OPEN mailbox message(s) for this project.\n\n` +
    `Load the \`workspace-mailbox\` skill, read \`handoffs/${project}.md\`, handle every OPEN message,\n` +
    `flip each one to DONE (use \`mailbox_ack\`), and reply only if a decision is needed.\n\n` +
    `Topics:\n${topics}`
  )
}

export function buildCapNotice(project: string, count: number, maxAutoRounds = 2): string {
  return `Mailbox: ${count} OPEN message(s) in ${project} — auto-handling stopped after ${maxAutoRounds} round(s); ask me to handle them.`
}
