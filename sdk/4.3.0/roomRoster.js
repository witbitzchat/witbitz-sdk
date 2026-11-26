import { memberHash } from './rosterHash.js'

/** Resolve a verified post against the server's signing-key directory. A chosen name alone proves no address. */
export function verifiedPosters(entries, seen) {
  const posters = []
  for (const e of entries || []) {
    const point = e?.spk || e?.vspk
    if (e?.verified !== true || e.self || e.kind === 'agent' || !point?.x || !point?.y) continue
    const id = point.x + '.' + point.y
    const person = Object.prototype.hasOwnProperty.call(seen, id) ? seen[id] : null
    if (person?.left) continue
    const owner = person?.swapped ? null : person
    const email = owner?.email || (e.emailNameVerified === true ? String(e.name || '').trim().toLowerCase() : '')
    const user = owner?.user || e.user || ''
    if (email || user) posters.push({ email, user })
  }
  return posters
}
// roomRoster.js — the room's guest book: everyone who ANNOUNCED themselves, in join order.
//
// A public room's only credential is the link, so reading it is an unauthenticated poll (`spaceService.mjs` op
// 'poll' — no gate) and nothing can make a visitor announce. ★ THIS LIST THEREFORE MEANS "PEOPLE WHO ANNOUNCED
// THEMSELVES", NEVER "EVERYONE WHO OPENED THIS ROOM", and the UI must say so. A lurker with the link is invisible by
// construction, not by oversight; a design that implied otherwise would be handing someone a number that looks like
// attendance and is really politeness. If you need the stronger claim, that is an email/invite-gated room, where
// every READ carries an identity before the server serves a byte — not this.
//
// Two rules do the real work here, and neither may bend:
//   1. A GUEST IS NEVER SHOWN A NAME THEY CHOSE. Anyone with the link can type "Alon". Guests get an ordinal, and
//      only an entry the SERVER attested (grant-bound `from`, see spaceService.mjs) may carry a name.
//   2. A LABEL MEANS THE SAME THING TO EVERY VIEWER. Labels are DERIVED from join order, never stored, so two
//      devices reading the same doc agree without coordinating and without asking the server.
//
// Storage is one mk-sealed `state` doc (l1.state(room, ROSTER_DOC)) — the transport liveLocation already uses: a
// turn-less write that never wakes the agent, and opaque to the server. ⚑ `state` is last-writer-wins on the WHOLE
// doc, so two people joining at once can clobber each other. There is no lock; instead every client re-asserts
// itself on every open and `mergeRoster` restores what was lost — see the self-healing tests.
// ⚑ And never put any of this in the op's `by` field: that one is cleartext to the server.

export const ROSTER_DOC = 'roster'
export const MAX_ENTRIES = 200 // every byte is written by someone holding the link; bound the griefer, keep the early

// An id is either a GUEST's local marker (`meId()` — 'm-' + 8 chars) or a MEMBER's signing key as `jkey(spk)`,
// which is `${jwk.x}.${jwk.y}` — 43 + 1 + 43 = 87 characters for P-256. ★ This cap was 64, so every signed-in member
// failed `isId`, `ensureSelf` returned `changed: false`, and NO WRITE WAS EVER ATTEMPTED — a silent no-op that reads
// exactly like "nobody has announced yet". It excluded precisely the people the guest book exists to attest: the
// `verified` row, with a real name instead of an ordinal, is reachable ONLY with a jkey id. Found 2026-09-21 on a
// live room whose doc was still v0 while guests demonstrably wrote fine. The id must stay the jkey verbatim —
// openWho matches it against `deriveRoster(entries).map(jkey)` — so the CAP is what was wrong, not the id. Still
// bounded (this is a griefer bound, and MAX_ENTRIES × 128 B is a small doc). spaces/test/roomRoster.test.mjs.
const MAX_ID = 128
const isId = (v) => typeof v === 'string' && !!v && v.length <= MAX_ID
// A name from the doc is UNTRUSTED INPUT — written by anyone holding the link. Bounded and trimmed here; rendered
// with textContent, never as markup; and it gains no standing from being stored.
const cleanName = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 40) : undefined)
/** One stored row, sanitized. A name is kept whether or not it was attested — `verified` is what separates them. */
function clean (e) {
  if (!e || typeof e !== 'object') return null
  if (!isId(e.id) || !Number.isFinite(e.at)) return null
  const out = { id: e.id, at: e.at }
  const nm = cleanName(e.name)
  if (nm) out.name = nm
  if (e.verified === true) out.verified = true
  return out
}

const rows = (roster) => (Array.isArray(roster) ? roster : Array.isArray(roster?.people) ? roster.people : []).map(clean).filter(Boolean)
// Join order, with the id as a tiebreak: two devices can stamp the same millisecond, and without this two viewers
// could number them oppositely — which would quietly break the one promise a label makes.
const byJoin = (a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Add this device to the roster if it is not already there. Idempotent ON PURPOSE: re-opening a room must not
 * rewrite the doc, because every write is a chance to clobber someone who joined at the same moment.
 * @returns {{roster: object[], changed: boolean}} — write only when `changed`.
 */
/** The key of a JWK, the way spaceFork.jkey names it — the id an attested row is matched to the ledger by. */
export const keyOf = (jwk) => (jwk && jwk.x && jwk.y) ? `${jwk.x}.${jwk.y}` : ''

/** WHAT A DEVICE ANNOUNCES ITSELF AS. Under a signing key the READER can attest against the ledger (a server-verified
 *  entry signed by that key), or as a bare device id shown as an ordinal. Two keys count, in this order:
 *    grantSpk — the invite-grant identity (an invited member)
 *    signPub  — the EMAIL-gate signing key (identity.js recallSign): what a member of a verified room actually posts
 *               with. ★ This one was missing (2026-09-26, "so why is Tomer unverified?"): announceSelf read only the
 *               grant, so in an email-gated room every member announced a bare id no ledger key could ever match, and
 *               the sheet called them "unverified" however much they had posted.
 *  The `verified` on the row is a CLAIM the reader re-checks (listRoster's `attested`); the name is what the person
 *  goes by here. */
//  ★ In a VERIFIED room the sign-in key wins (2026-10-04, sp-294n…): the server records each gate sign-in under the key
//  the request was SIGNED with (spaceService `roster_seen`, keyed by req.spk = signPub), so a creator or invited device
//  that announced under its grant key wrote a row the server's record never matched.
export function selfRow ({ grantSpk = null, signPub = null, deviceId = '', name = '', gated = false } = {}) {
  const key = gated ? (keyOf(signPub) || keyOf(grantSpk)) : (keyOf(grantSpk) || keyOf(signPub))
  return key ? { id: key, name: name || '', verified: true } : { id: deviceId, name: name || '' }
}

/** THE MEMBERS VIEW OF A VERIFIED ROOM (owner, 2026-09-26: "for verified rooms it should be Members, and in there it can
 *  show the status"). A room with an email gate has a LIST of who may post (advertised emails / @usernames in the clear,
 *  hidden ones as room-salted hashes, whole domains), and the server vouches for whoever passed the gate (`seen`). So the
 *  sheet is not "who's been here" but "who is a member, and where each of them stands":
 *    signed in       — the gate verified them here (seen), or a server-badged ledger entry carries their key (named)
 *    not yet opened  — on the list, no sighting yet
 *    allowed         — a whole domain
 *    unverified      — a typed name the server never vouched for (a guest row in a gated room)
 *  Hidden entries cannot be named, only counted. `rows` = listRoster(...) output; `seenIdentity(id)` → "@user" | email | "". */
// `onList(email, user)` (verifiedMove.stillOnList): a room re-keyed in place keeps its guest book and its history, so a REMOVED
// member still has rows and posts — they are not members. Absent (a room never re-keyed): every sighting is a member, as before.
export function membersView ({ allow = {}, rows = [], seenIdentity = () => '', seenPerson = null, posters = [], myEmail = '', mineId = '', myName = '', hiddenUnseen = null, seenHandles = new Set(), onList = null } = {}) {
  const norm = (s) => String(s || '').trim().toLowerCase()
  const me = norm(myEmail)
  // ONE ROW PER PERSON (2026-10-04, sp-294n…: four "@alice" rows for one person on four keys, and both listed emails
  // "not yet opened" — the owner's own and an account with five verified posts). A row is a signing KEY, and every
  // device, app and reinstall makes its own; the person is the verified EMAIL the server recorded beside the key.
  // `seenPerson(id)` → { email, user } (the older `seenIdentity(id)` → "@user" | email still works, with less to match).
  const personOf = (id) => {
    if (seenPerson) { const p = seenPerson(id); return p && (p.email || p.user) ? { email: norm(p.email), user: String(p.user || '').replace(/^@/, '') } : null }
    const s = String(seenIdentity(id) || ''); if (!s) return null
    return s.startsWith('@') ? { email: '', user: s.slice(1) } : { email: norm(s), user: '' }
  }
  const people = new Map() // key → { email, user, label, me, id }
  const add = (key, p) => {
    const had = people.get(key)
    if (had) { had.email ||= p.email; had.user ||= p.user; had.me ||= p.me; return }
    people.set(key, { ...p })
  }
  for (const r of rows) {
    const p = personOf(r.id)
    const isMe = r.id === mineId || (!!me && !!p && p.email === me)
    // A verified room lists MEMBERS: a row nobody vouched for (a typed name — a reader with the link, or a device that
    // announced before it had its key) is not a member and is not shown. The owner read "Tomer · unverified" beside a
    // list that admits Tomer as "Tomer is not verified"; the row said only that the device had not re-announced yet.
    if (!isMe && !p && !r.named) continue
    if (!isMe && onList && !onList(p ? p.email : '', p ? p.user : '')) continue // removed since (a re-keyed room's guest book)
    const email = (p && p.email) || (isMe ? me : '')
    const user = (p && p.user) || ''
    add(email || (user ? '@' + norm(user) : 'id:' + r.id), { email, user, me: isMe, id: r.id, label: r.label })
  }
  // A verified post is the strongest sighting there is: its author opened the room, announced or not.
  for (const a of Array.isArray(posters) ? posters : []) {
    const email = norm(a && a.email), user = String((a && a.user) || '').replace(/^@/, '')
    if (!email && !user) continue
    if (onList && !(me && email === me) && !onList(email, user)) continue // a removed member's old posts do not make them a member
    const key = email || '@' + norm(user)
    const byUser = !email && [...people.values()].find((x) => user && norm(x.user) === norm(user))
    if (byUser) continue
    add(key, { email, user, me: !!me && email === me, label: '' })
  }
  // You are a member the moment you are reading as your verified self, whether or not this device has announced.
  if (me && ![...people.values()].some((x) => x.me)) { if (people.has(me)) people.get(me).me = true; else add(me, { email: me, user: '', me: true, label: '' }) }
  const items = []
  const covered = new Set()
  const ordered = [...people.values()].sort((x, y) => (y.me ? 1 : 0) - (x.me ? 1 : 0))
  for (const x of ordered) {
    if (x.email) covered.add(x.email)
    if (x.user) covered.add(norm('@' + x.user))
    const label = x.user ? '@' + x.user : (x.email || (x.me ? (myName || x.label) : x.label))
    const address = x.email || (x.user ? '@' + x.user : '')
    items.push({ label, tag: x.me ? 'you' : 'signed in', ...(x.id ? { id: x.id } : {}), ...(address ? { address } : {}), ...(x.user ? { user: x.user } : {}) })
  }
  const emails = Array.isArray(allow.emails) ? allow.emails.filter(Boolean) : []
  // an older room's @username entry: { handle, username } — the username it had THEN. A signed-in member whose handle it is
  // (seenHandles: the caller resolved the signed-in usernames) is that member under their new name, not a second person.
  const users = Array.isArray(allow.users) ? allow.users.filter((u) => !(u && typeof u === 'object' && u.handle && seenHandles.has(String(u.handle)))).map((u) => (u && typeof u === 'object' ? u.username : u)).filter(Boolean) : []
  for (const e of emails) if (!covered.has(norm(e))) items.push({ label: e, tag: 'not yet opened', address: e })
  for (const u of users) if (!covered.has(norm('@' + u))) items.push({ label: '@' + u, tag: 'not yet opened', address: '@' + u, user: u })
  const domains = Array.isArray(allow.domains) ? allow.domains.filter(Boolean) : []
  for (const d of domains) items.push({ label: 'anyone at @' + d, tag: 'allowed' })
  // Hidden (hashed) entries: the caller matches them against the people the room verified (rosterHash.memberHash of
  // each seen email) and passes how many are still UNSEEN — those are invites nobody has opened, not "more people".
  // Without that count, every hidden entry is reported, which double-counts a member who is already listed above.
  const hiddenAll = Array.isArray(allow.mh) ? allow.mh.length : 0
  const hidden = Number.isInteger(hiddenUnseen) ? Math.max(0, Math.min(hiddenUnseen, hiddenAll)) : hiddenAll
  const note = 'Everyone this room lets post. Signed in: verified on their own device. Not yet opened: invited, but hasn’t opened the room yet.'
    + (hidden ? ` ${hidden} private ${hidden === 1 ? 'invite hasn’t' : 'invites haven’t'} been opened yet.` : '')
  return { title: 'Members', note, items, hidden }
}

/** A verified room's guest book does not yet SHOW this row as signed in (`seen`, the server's record of who the email gate
 *  verified): announce again even with nothing changed — a lost write (two members announcing at once) would otherwise leave the
 *  member nameless for ever, and a member change in place cannot reach a hidden member it cannot name. */
export const unseenIn = (seen, id) => !!id && !(seen && typeof seen === 'object' && seen[id] && seen[id].email)
/** Seen, but before the record kept WHICH list entries this person is (2026-10-23, rosterCount samePeople): announced ONCE more
 *  per room and key on this page (never retried — a server that does not keep them yet answers the same) so one person on the list by email and by
 *  @username counts once. */
const _entriesAsked = new Set()
export const entriesMissing = (seen, id, room = '') => {
  if (!id || unseenIn(seen, id) || Array.isArray(seen[id].entries)) return false
  const k = room + '\n' + id; if (_entriesAsked.has(k)) return false // once per room and key on this page
  _entriesAsked.add(k); return true
}
/** This page announced `id` in `room` (for any reason): the server had its chance to record the entries — no extra announce. */
export const announcedIn = (room, id) => { if (id) _entriesAsked.add(room + '\n' + id) }

export function ensureSelf (roster, self, now = Date.now(), { retire = '' } = {}) {
  let list = rows(roster)
  // A device that now announces under a KEY retires the bare-id row it wrote before it had one (same device, same
  // person) — otherwise the sheet shows the person twice, once attested and once "unverified".
  // `retire` may be a list: in a verified room the device also retires the row it wrote under its grant key (selfRow).
  const gone = [].concat(retire || []).filter((x) => x && self && self.id !== x && list.some((e) => e.id === x))
  if (gone.length) { list = list.filter((e) => !gone.includes(e.id)); return { ...ensureSelf(list, self, now), changed: true } }
  if (!self || !isId(self.id)) return { roster: list, changed: false }
  const had = list.find((e) => e.id === self.id)
  if (had) {
    // Already listed. Only a CHANGED name is worth a write — every write is a chance to clobber a concurrent joiner.
    const nm = cleanName(self.name)
    if (nm === had.name) return { roster: list, changed: false }
    return { roster: list.map((e) => (e.id === self.id ? clean({ ...e, name: nm }) : e)).sort(byJoin), changed: true } // the ORIGINAL join time is kept
  }
  const mine = clean({ id: self.id, at: Number.isFinite(now) ? now : Date.now(), name: self.name, verified: self.verified })
  const next = [...list, mine].sort(byJoin)
  // Cap by dropping the LATEST, never the earliest: a flood must not push the room's actual people out of their own
  // list. (It can still stop new joins being recorded — that is the honest failure, and it is visible.)
  return { roster: next.slice(0, MAX_ENTRIES), changed: true }
}

/** Union two copies of the doc. Commutative and idempotent, earliest join wins, attestation is sticky. */
export function mergeRoster (a, b) {
  const by = new Map()
  for (const e of [...rows(a), ...rows(b)]) {
    const prev = by.get(e.id)
    if (!prev) { by.set(e.id, e); continue }
    const at = Math.min(prev.at, e.at) // a rejoin never jumps the queue
    const vr = prev.verified === true ? prev : (e.verified === true ? e : null)
    const nm = vr ? vr.name : (prev.name || e.name) // an ATTESTED name wins over a claimed one
    by.set(e.id, { id: e.id, at, ...(nm ? { name: nm } : {}), ...(vr ? { verified: true } : {}) })
  }
  return [...by.values()].sort(byJoin).slice(0, MAX_ENTRIES)
}

/**
 * The list to render: join order, labelled. Guests are numbered among GUESTS, so a named member joining does not
 * shift everyone's ordinal.
 * @param {(entry) => boolean} [opts.attested] — re-check an entry's claim to be verified. The doc is written by
 *   whoever holds the link, so `verified` in the stored bytes is a CLAIM; the caller passes what it can actually
 *   attest (e.g. an spk seen on a server-stamped ledger entry). Default: trust the row, for tests and for callers
 *   that have already sanitized it.
 */
export function listRoster (roster, { attested = null } = {}) {
  const list = rows(roster).sort(byJoin)
  const ok = list.map((e) => e.verified === true && (attested ? !!attested(e) : true))
  // How many rows carry each name, attested or claimed. A name held by exactly one row can stand alone; a name two
  // rows claim is disambiguated, so copying someone's name can never merge two people into one row. That is the one
  // thing this list does that the chat cannot: it counts PEOPLE, not strings.
  const held = new Map()
  for (const e of list) if (e.name) held.set(e.name, (held.get(e.name) || 0) + 1)
  // An ordinal is only spent where one is SHOWN — an attested member with a name consumes none, so the guests are
  // user1, user2… in join order however many named members share the room.
  const standalone = list.map((e, i) => !!e.name && (ok[i] || (held.get(e.name) || 0) === 1))
  let n = 0
  return list.map((e, i) => {
    const verified = ok[i]
    const ordinal = standalone[i] ? '' : 'user' + (++n)
    return {
      id: e.id,
      at: e.at,
      verified,
      named: verified && !!e.name, // a name someone ATTESTED — the only kind that may be shown plain
      claimed: !verified && !!e.name, // a name its owner typed — shown, and the UI must mark it
      label: standalone[i] ? e.name : (e.name ? `${e.name} (${ordinal})` : ordinal),
    }
  })
}

export async function privateInvitationMatches(cfg, room, seen, { resolveUsers, userTag, within = promise => promise }) {
  // hidden (hashed) list entries: subtract the ones a verified person matches, so a member is not counted twice
  let hiddenUnseen = null
  // THE HANDLES OF THE SIGNED-IN @USERNAMES (sync sweep 10-12): an older room lists an @username by its stable handle and
  // the name it had THEN; a member who renamed is signed in under the new name — matched by handle, the old name is not
  // listed again as "not yet opened". Resolved once, for this and for the hidden entries below.
  const seenHandles = new Set()
  const seenUsers = [...new Set(Object.values(seen).map((p) => p && p.user).filter(Boolean))]
  const legacyUsers = Array.isArray(cfg.allow && cfg.allow.users) ? cfg.allow.users.filter((u) => u && typeof u === 'object' && u.handle) : []
  let resolvedSeen = null
  const resolveSeen = async () => { if (resolvedSeen) return resolvedSeen; try { resolvedSeen = ((await within(resolveUsers(seenUsers))) || { resolved: [] }).resolved || [] } catch { resolvedSeen = [] } return resolvedSeen }
  if (seenUsers.length && legacyUsers.length) for (const r of await resolveSeen()) if (r && r.handle) seenHandles.add(String(r.handle))
  try {
    const mh = Array.isArray(cfg.allow && cfg.allow.mh) ? cfg.allow.mh : []
    if (mh.length) { const got = new Set(); for (const p of Object.values(seen)) { if (p && p.email) { const h = await memberHash(p.email, room); if (h) got.add(h) } }
      // THE ENTRIES THE GATE RECORDED AT EACH SIGN-IN (roster_seen `entries`, server-written — what member removal reads,
      // sdkRekey listAfter): an older room hashed an @username from its HANDLE, which resolve no longer hands out for a member
      // whose email door is closed (f8eb472a) — matched by what admitted them instead (sync sweep 11-08 #37)
      for (const p of Object.values(seen)) for (const k of (p && Array.isArray(p.entries) ? p.entries : [])) if (typeof k === 'string' && k.startsWith('mh:')) got.add(k.slice(3))
      // A hidden @username entry is hashed from its HANDLE (createBtn pushes r.handle), so a seen member is matched by
      // their username's handle too — or a member invited by @username who opened the room still counted as an
      // unopened private invite (sync sweep, 2026-10-10).
      if (seenUsers.length) { try { for (const r of await resolveSeen()) { if (r.handle) { const h = await memberHash(r.handle, room); if (h) got.add(h) } const t = await within(userTag(r.username, room)).catch(() => null); if (t && t.status === 200 && t.tag) got.add(t.tag) } } catch { /* unresolved → counted as before — §12: a TAG (new rooms) or the handle's hash (older) */ } } hiddenUnseen = mh.filter((h) => !got.has(h)).length }
  } catch { /* unknown → the view reports every hidden entry */ }
  return { hiddenUnseen, seenHandles }
}
