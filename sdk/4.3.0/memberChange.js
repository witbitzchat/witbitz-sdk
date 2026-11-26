// memberChange.js — THE PURE HALF OF A MEMBER CHANGE IN PLACE (docs/key-rotation-design.md § (b)), one rule for the Spaces app
// (rekeyMembers.js, through its key worker) and the SDK (sdkRekey.js, which holds the key itself): who the room ends with, in
// the config's own shape, and each remaining member's grant address and invite key. Nothing here holds a key.
import { memberHash } from './rosterHash.js'
import { govOf } from './emailFork.js'
import { resolveHandle } from './inviteEnroll.js'
import { findInvitee } from './inviteSend.js'

export const lc = (e) => String(e || '').trim().toLowerCase()
export const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,63}\.[a-z]{2,63}$/i

/** Each email's grant address in this room (memberHash) and its account invite key (the directory). Someone with no invite key
 *  is named, and their grant address holds 'pending' (their device asks for a fresh link). `app`: another slot of the account
 *  (an attested room's box for its kind); `scope`: the directory namespace (the SDK: its app's own, 'app:<origin>').
 *  → { recipients:[{ email, mh, boxPub }], unreachable:[email], pending:[mh] } */
export async function recipientsFor (room, emails, client, { app = '', scope, allow, people = [] } = {}) {
  const recipients = [], unreachable = [], pending = []
  // A roster email is not an email admission. Resolve a public username only after its CURRENT room tag matches
  // the retained allow-list. Never seal a grant to a roster-supplied key, or redirect one to a renamed/reclaimed username.
  const tagOnly = new Set(), allowed = new Set(allow && allow.mh || [])
  for (const p of people) {
    if (!p || p.left || !p.user || !Array.isArray(p.entries) || typeof client.userTag !== 'function') continue
    const candidates = p.entries.filter((x) => typeof x === 'string' && x.startsWith('mh:') && allowed.has(x.slice(3))).map((x) => x.slice(3))
    if (!candidates.length) continue
    const email = lc(p.email), emailHash = email ? await memberHash(email, room) : ''
    const t = await client.userTag(p.user, room).catch(() => null)
    if (!t || t.status !== 200 || !candidates.includes(t.tag)) continue
    if (!(allow.emails || []).map(lc).includes(email) && !allowed.has(emailHash) && !(allow.domains || []).some((d) => email.endsWith('@' + lc(d)))) tagOnly.add(email)
    let f = await findInvitee({ username: p.user, app, scope }, client).catch(() => null)
    // Builders may have an email slot without a username slot. Only an existing, discoverable slot counts:
    // keep the verified room tag, never manufacture an email pending grant when this door is closed.
    if ((!f || !f.ok) && email) f = await findInvitee({ email, app, scope }, client).catch(() => null)
    if (f && f.ok && !recipients.some((r) => r.mh === t.tag)) recipients.push({ email, mh: t.tag, boxPub: f.entry.boxPub })
    else if (!f || !f.ok) unreachable.push(email || '@' + p.user)
  }
  await Promise.all([...new Set(emails.map(lc).filter((e) => EMAIL.test(e)))].map(async (email) => {
    if (tagOnly.has(email)) return
    try {
      const mh = await memberHash(email, room)
      const handle = await (scope === undefined ? resolveHandle(email, client) : resolveHandle(email, client, scope))
      const g = handle ? await client.dirGet(handle, app ? { app } : {}) : null
      if (g && g.status === 200 && g.entry && g.entry.boxPub) recipients.push({ email, mh, boxPub: g.entry.boxPub })
      else { unreachable.push(email); pending.push(mh) }
    } catch { unreachable.push(email) }
  }))
  return { recipients, unreachable, pending }
}

/** A REMOVED PERSON'S @USERNAME ENTRIES (sync sweep 2026-10-22): the list may hold them by @username too — a tag for this room
 *  (new rooms), the hash of their handle or an advertised { handle, username } (older rooms). `tagOf(u)` → tag, `handleOf(u)` →
 *  handle; a lookup that fails drops what it can. → { mh, users } for membersAfter's `want.drop`. */
export async function dropsForUsers (room, users, { tagOf, handleOf } = {}) {
  const names = [...new Set((users || []).map((u) => lc(u).replace(/^@/, '')).filter(Boolean))]
  const mh = []
  await Promise.all(names.map(async (u) => {
    try { const t = tagOf ? await tagOf(u) : ''; if (typeof t === 'string' && t) mh.push(t) } catch { /* no tag known */ }
    try { const h = handleOf ? await handleOf(u) : ''; if (typeof h === 'string' && h) mh.push(await memberHash(h, room)) } catch { /* no handle */ }
  }))
  return { mh: [...new Set(mh)], users: names }
}

/** The members a change ends with, in the config's OWN shape: advertised addresses stay in `emails`, hidden ones stay as
 *  their hashes (`mh`) unless the change removes them, domains as they are. */
export async function membersAfter (cfg, want, room) {
  const al = (cfg && cfg.allow) || {}
  const keepAll = new Set((want.emails || []).map(lc))
  const before = [...new Set([...(Array.isArray(al.emails) ? al.emails : []), ...(want.known || [])].map(lc))]
  const removed = before.filter((e) => EMAIL.test(e) && !keepAll.has(e))
  const removedMh = new Set(await Promise.all(removed.map((e) => memberHash(e, room))))
  const shown = [...new Set((want.shown || []).map(lc).filter((e) => keepAll.has(e)))]
  const allow = { ...al, emails: shown }
  // the same people's @username entries (dropsForUsers): a tag or a handle's hash in `mh`, an older room's advertised `users`
  const drop = want.drop || {}
  for (const h of (Array.isArray(drop.mh) ? drop.mh : [])) removedMh.add(h)
  const dropUsers = new Set((Array.isArray(drop.users) ? drop.users : []).map((u) => lc(u).replace(/^@/, '')))
  if (Array.isArray(al.mh)) allow.mh = al.mh.filter((h) => !removedMh.has(h))
  if (Array.isArray(al.users) && dropUsers.size) allow.users = al.users.filter((u) => !(u && typeof u === 'object' && dropUsers.has(lc(u.username))))
  if (Array.isArray(want.domains)) allow.domains = want.domains.map(lc)
  for (const k of Object.keys(allow)) if (allow[k] === undefined || (Array.isArray(allow[k]) && !allow[k].length && k !== 'emails')) delete allow[k]
  const set = (xs) => ({ emails: [...new Set((xs || []).map(lc))] })
  return { allow, owners: set(want.owners), admins: set((want.admins || []).filter((e) => !(want.owners || []).map(lc).includes(lc(e)))), removed }
}

// HIDDEN MEMBERS NOBODY HAS SEEN: an address the list keeps only as its hash (allow.mh — a private invite not opened yet) has no
// email to look up an invite key by, so no grant can be sealed to it. Each gets the `pending` marker at its own hash: their
// device, with the link it was sent, is told to ask for a fresh one — never that the room went on without them.
export const unseenHidden = (allow, recipients, pending) => {
  const covered = new Set([...recipients.map((x) => x.mh), ...pending])
  return (Array.isArray(allow && allow.mh) ? allow.mh : []).filter((h) => typeof h === 'string' && h && !covered.has(h))
}

/** STILL ON THE LIST? A room re-keyed in place (option (b): its config carries `keyChain`) keeps its guest book — so the
 *  devices of someone REMOVED are still in it, and their posts are still in the history. Before, a member change made a
 *  new room with a fresh guest book; now the book must be checked against the list (the owner, 2026-10-22: "After removing
 *  from the group I see alice as a member"). → a predicate (email, user) → bool, or null when the room was never
 *  re-keyed (the guest book is the list, as before). On the list: an advertised email, an owner or admin, a domain, a
 *  hidden entry (memberHash). Someone known only by @username where the list has @username entries cannot be decided
 *  here and is kept. */
export async function stillOnList (cfg, room, people = []) {
  if (!cfg || !Array.isArray(cfg.keyChain) || !cfg.keyChain.length) return null
  const al = cfg.allow || {}, g = govOf(cfg)
  const ok = new Set([...(Array.isArray(al.emails) ? al.emails : []), ...g.owners, ...g.admins].map(lc))
  const domains = (Array.isArray(al.domains) ? al.domains : []).map(lc)
  const mh = new Set(Array.isArray(al.mh) ? al.mh : [])
  const byUser = (Array.isArray(al.users) && al.users.length) || (Array.isArray(al.tagUsers) && al.tagUsers.length)
  // `people`: addresses, or the guest book's records ({ email, entries }). A person added by @USERNAME is on the list by an `mh:` entry
  // that is NOT the hash of their email (a tag or a handle's hash — memberTag.mjs): the guest book recorded which entry let them in,
  // and that entry still on the list keeps them (sync sweep 2026-11-23 #2 — they vanished from Members after any re-key)
  const byEntry = new Map()
  for (const p of people || []) {
    if (!p || typeof p !== 'object') continue
    const e = lc(p.email), ents = Array.isArray(p.entries) ? p.entries : []
    if (e && EMAIL.test(e) && ents.some((x) => typeof x === 'string' && ((x.startsWith('mh:') && mh.has(x.slice(3))) || (x.startsWith('u:') && (Array.isArray(al.users) ? al.users : []).some((u) => u && lc(u.handle) === lc(x.slice(2))))))) byEntry.set(e, true)
  }
  const emailsOf = (people || []).map((p) => (p && typeof p === 'object' ? p.email : p))
  const hashed = new Map()
  if (mh.size) for (const e of new Set(emailsOf.map(lc).filter((x) => EMAIL.test(x) && !ok.has(x) && !byEntry.has(x)))) { try { hashed.set(e, mh.has(await memberHash(e, room))) } catch { hashed.set(e, false) } }
  return (email, user) => {
    const e = lc(email)
    if (e && EMAIL.test(e)) return ok.has(e) || domains.some((d) => e.endsWith('@' + d)) || hashed.get(e) === true || byEntry.get(e) === true
    return !!(user && byUser) // no email to decide by: kept only where the list names people by @username
  }
}
