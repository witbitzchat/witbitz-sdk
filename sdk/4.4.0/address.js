// address.js — the ADDRESS grammar a person can be reached by (docs/spaces-usernames.md §5): an email, or a public
// "@username". Pure; the browser twin of the server's agent/usernames.mjs grammar (kept identical by
// agent/usernamesParity.test.mjs — a name the picker accepts must be one the registry accepts, and vice versa).
//
// NO DOTS in a username: the allow-list already uses "@acme.com" to mean A DOMAIN, so with dots out "@x.y" is always a
// domain and "@x" is always a person, in every field, with no heuristic between them.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_]{2,29}$/
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const RESERVED = new Set([
  'admin', 'administrator', 'witbitz', 'witbitzchat', 'support', 'help', 'root', 'system', 'sys', 'assistant', 'agent',
  'agents', 'bot', 'bots', 'official', 'staff', 'team', 'security', 'abuse', 'postmaster', 'noreply', 'null', 'undefined',
  'anonymous', 'guest', 'everyone', 'all', 'here', 'me', 'you', 'space', 'spaces', 'room', 'rooms',
])

/** NFKC → trim → lowercase, and ONE leading "@" stripped. */
export function normUsername(s) {
  const n = String(s == null ? '' : s).normalize('NFKC').trim().toLowerCase()
  return n.startsWith('@') ? n.slice(1) : n
}
/** The canonical username, or null. */
export function validUsername(s) {
  if (typeof s !== 'string') return null
  const n = normUsername(s)
  if (!USERNAME_RE.test(n) || RESERVED.has(n)) return null
  return n
}
/** What was typed: `{ kind:'email', email }` (lowercased), `{ kind:'username', username }` (canonical, typed WITH a
 *  leading @), or null. A bare word is neither; "@x.y" is a domain, not a person, and is refused here. */
export function parseAddress(s) {
  const t = String(s == null ? '' : s).trim()
  if (!t) return null
  if (t.startsWith('@')) { const u = validUsername(t); return u ? { kind: 'username', username: u } : null }
  const e = t.toLowerCase()
  return EMAIL_RE.test(e) ? { kind: 'email', email: e } : null
}
/** The one canonical string an address is keyed by everywhere (contacts, the picker's selection, the reach cache):
 *  the lowercased email, or "@" + the canonical username. null for anything else. */
export function addressKey(s) {
  const a = parseAddress(s)
  return a ? (a.kind === 'email' ? a.email : '@' + a.username) : null
}
export const isUsernameKey = (k) => typeof k === 'string' && k.startsWith('@')
