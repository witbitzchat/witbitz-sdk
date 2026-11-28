// rosterCount.js — how many people an email-gated room admits, counted from its sealed config: the PAGE's copy of the
// server's rule (agent/rosterCount.mjs rosterParticipants), held equal by spaces/test/fundingCounts.test.mjs.
// ⋯ → Fund this room uses it (sync sweep, 2026-10-10): the member count sets the grant's ceiling, and the sheet summed
// every list as is — a person listed both plain and hashed counted twice, a domain
// room given a number nobody can know.
// null = "this room's shape cannot know" (not email-gated, a domain wildcard, nothing enumerable); 0 is an answer.
import { memberHash } from './rosterHash.js'

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim()
const list = (v) => (Array.isArray(v) ? v.map(norm).filter(Boolean) : [])

/** Exactly one admitted identity, and it is the signed-in person; no usernames or domains. */
export async function isSoloVerified(cfg, room, me, { hash = memberHash } = {}) {
  const email = norm(me), allow = cfg?.allow
  if (!email || cfg?.admission !== 'email' || !allow || allow.users?.length || allow.domains?.length || allow.tags?.length) return false
  const shown = Array.isArray(allow.emails) ? allow.emails.map(norm) : []
  const hidden = Array.isArray(allow.mh) ? allow.mh : []
  if (!shown.length && !hidden.length) return false
  if (shown.some(address => address !== email)) return false
  if (!hidden.length) return true
  const expected = await hash(email, room)
  return hidden.every(h => h === expected)
}

export async function rosterParticipants (space, roomSalt, { seen = null } = {}) {
  if (!space || space.admission !== 'email') return null
  const allow = space.allow && typeof space.allow === 'object' ? space.allow : {}
  if (list(allow.domains).length) return null
  const emails = new Set(list(allow.emails))
  const mh = new Set(Array.isArray(allow.mh) ? allow.mh.filter((h) => typeof h === 'string' && h) : [])
  const users = new Set((Array.isArray(allow.users) ? allow.users : []).map((u) => u && typeof u === 'object' ? norm(u.handle) : '').filter(Boolean))
  if (!emails.size && !mh.size && !users.size) return null
  const plainOnly = new Set()
  for (const e of emails) if (!(mh.size && mh.has(await memberHash(e, roomSalt)))) plainOnly.add(e)
  return mh.size + plainOnly.size + users.size - await samePeople(seen, { mh, plainOnly, users })
}
// ONE PERSON, ONE COUNT (the owner, 2026-10-23: added by email AND by @username is "One person"). The list cannot tell —
// an @username's tag is unlinkable to an email by design — but the server can when that person signs in: roster_seen keeps,
// per signed-in member, the list entries their verified email matched (spaceOidc allowEntriesFor). Entries one person
// matched count once. → how many entries to take off.
export async function samePeople(seen, { mh, plainOnly, users }) {
  if (!seen || typeof seen !== 'object') return 0
  const counted = new Set([...[...mh].map((h) => 'mh:' + h), ...[...plainOnly].map((e) => 'e:' + e), ...[...users].map((u) => 'u:' + u)])
  const parent = new Map(), find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k }
  let merged = 0
  for (const p of Object.values(seen)) {
    const ks = (p && Array.isArray(p.entries) ? p.entries : []).filter((k) => counted.has(k))
    for (const k of ks) if (!parent.has(k)) parent.set(k, k)
    for (let i = 1; i < ks.length; i++) { const a = find(ks[0]), b = find(ks[i]); if (a !== b) { parent.set(b, a); merged++ } }
  }
  return merged
}
