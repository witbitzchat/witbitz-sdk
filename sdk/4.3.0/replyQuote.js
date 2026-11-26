// THE REPLY QUOTE — one rule for the app's reply strip (space.js onReply) and the SDK's `replyTo` (witbitz-sdk.js send).
// Two copies of it drifted apart once (sync sweep 10-12): what a quote is keyed by, who it names, and its line.
//   key      the quoted entry's key (ledgerView.entryKeyOf — how reactions and replies find it)
//   name     its sender, "Assistant" for the agent's own, else "someone" (each side says which name field it reads)
//   excerpt  the words, whitespace-collapsed, up to 120 characters; else what it carried ("📷 photo", "📎 file"); else ''
// The excerpt travels with the reply, so the quote still reads after the original scrolls out of the loaded window.
import { entryKeyOf } from './ledgerView.js'

// THE NAME A QUOTE SHOWS (the owner, 2026-10-22: a quote said "alice@example.com" under a header that says
// "@alice"). The name line puts a verified member's @username in place of their email (messageRender.js); a quote is
// the same person, so it does too — for a new reply (the entry carries `user`) and for one already sent (the email→username
// pairs learned from the messages drawn on this device).
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const usernames = new Map() // email → username, server-attested (messageRender learns them)
export function learnUsername (email, user) { if (EMAIL.test(String(email || '').trim()) && user) usernames.set(String(email).trim().toLowerCase(), String(user)) }
/** The name to show for `name` (an email turns into the @username its owner is verified as, when known). */
export function quoteName (name, user) {
  const n = String(name || '').trim()
  if (!EMAIL.test(n)) return name
  const u = user || usernames.get(n.toLowerCase())
  return u ? '@' + u : name
}
export const replyExcerpt = (m) => {
  const t = m && typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  return t || (m && Array.isArray(m.images) && m.images.length ? '📷 photo' : (m && Array.isArray(m.files) && m.files.length ? '📎 file' : ''))
}

/** → { key, name, excerpt } | null (no entry). `name` overrides which field names the sender. */
export function replyQuote (m, { name } = {}) {
  if (!m || typeof m !== 'object') return null
  let who = name !== undefined ? name : (m.from || m.name)
  if (m.verified === true && typeof m.user === 'string' && m.user) who = quoteName(who, m.user) // as the name line shows them
  return { key: entryKeyOf(m), name: String(who || (m.self ? 'Assistant' : 'someone')).slice(0, 80), excerpt: replyExcerpt(m) }
}
