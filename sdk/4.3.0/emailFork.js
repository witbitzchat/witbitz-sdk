// spaces/public/emailFork.js — THE MOVE OF A VERIFIED (EMAIL-GATED) ROOM, one set of rules for the SDK and the app
// (https://witbitz.chat/docs/sdk-people.md#fork). Membership in a verified room is its sealed allow-list, and changing who is in mints a
// NEW room with a fresh key (a removed member still holds the old one). These are the rules both callers apply: the gate,
// the owners/admins rule (the same one the server applies — agent/spaceService.mjs forkGovernanceRefusal), the new room's
// config, which devices receive the new key (the room's guest book, as the email gate verified it), the notice, and what a
// member's device checks before it follows. Moved verbatim out of witbitz-sdk.js (Space#fork, _maybeMoved,
// _newRoomKeepsGov, 2026-10-05); the MINT and the transport stay with the caller (the SDK's client, the app's split-,
// tenant- and enclave-aware path).
import { memberHash } from './rosterHash.js'
import { boxesHash, bareEC, jkey } from './spaceFork.js'
import { sealTo, openBox } from './e2ee.js'
import { roomRegion } from './regions.js' // a room's home region is in its id (docs/multi-region.md)
import { accountEmail } from './accountScope.js'

export const GATE_EMAIL = /^[^\s@]{1,200}@[^\s@]{1,63}\.[a-z]{2,63}$/i
export const GATE_DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/
/** Does a normAdmission() gate admit this address (shown, hidden or by domain)? */
export function admittedBy(gate, email) {
  const e = String(email || '').toLowerCase(), al = (gate && gate.allow) || {}
  return [...(al.emails || []), ...(al.hidden || [])].includes(e) || (al.domains || []).includes(e.slice(e.indexOf('@') + 1))
}
/** OWNERS — the move rule, the same one the server applies (agent/spaceService.mjs forkGovernanceRefusal). → null when a
 *  move to `gov` = { owners, admins } is allowed, else why. An owner may move it any way; anyone else keeps the owners
 *  exactly and keeps every admin an admin (raising members to admin is fine). */
export function govRefusal(owners, admins, gov, byOwner) {
  const l = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : null)
  const nO = l(gov && gov.owners), nA = l(gov && gov.admins)
  if (!nO || !nA) return "a move in a room with owners must declare the new room's owners and admins"
  if (byOwner) return null
  const o = [...new Set(owners)], n = [...new Set(nO)]
  if (o.length !== n.length || !o.every((x) => n.includes(x))) return 'only an owner can change the owners'
  const lost = admins.filter((x) => !nA.includes(x) && !nO.includes(x))
  return lost.length ? `only an owner can lower or remove an admin (${lost.join(', ')})` : null
}

// A gate that cannot be used: one code for all, so fork() and plan() can say why (sync sweep, 2026-10-12).
const badAdmission = (m) => Object.assign(new Error(m), { code: 'invalid_admission' })
export function normAdmission(a) {
  if (a === undefined || a === null) return null
  if (typeof a !== 'object' || Array.isArray(a)) throw badAdmission('witbitz: admission takes { emails?, domains? }')
  const clean = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
  const emails = clean(a.emails), domains = clean(a.domains)
  for (const e of emails) if (!GATE_EMAIL.test(e)) throw badAdmission(`witbitz: "${e}" is not an email address`)
  for (const d of domains) if (!GATE_DOMAIN.test(d)) throw badAdmission(`witbitz: "${d}" is not a domain name, like keepwarden.com`)
  if (!emails.length && !domains.length) throw badAdmission('witbitz: admission needs at least one address or domain — a gate that admits nobody locks you out of your own room, and a room cannot be converted afterwards')
  // ADVERTISE (2026-10-02): addresses are stored HASHED by default, so a member can check one (space.admits) but not
  // read the list. `advertise: true` stores every address readable to members; an array advertises just those.
  const adv = a.advertise === true ? emails : (Array.isArray(a.advertise) ? clean(a.advertise) : [])
  for (const x of adv) if (!emails.includes(x)) throw badAdmission(`witbitz: advertise names "${x}", which is not in emails`)
  if (a.advertise !== undefined && a.advertise !== true && a.advertise !== false && !Array.isArray(a.advertise)) throw badAdmission('witbitz: admission.advertise is true, false, or an array of addresses from emails')
  // ADMINS (2026-10-02): enforced by the room, not the app — see Space#isAdmin. Each must be admitted by this gate.
  // Stored as plain addresses inside the sealed config, so members can see who the admins are; the platform cannot.
  const admins = clean(a.admins)
  for (const x of admins) {
    if (!GATE_EMAIL.test(x)) throw badAdmission(`witbitz: admin "${x}" is not an email address`)
    if (!emails.includes(x) && !domains.includes(x.slice(x.indexOf('@') + 1))) throw badAdmission(`witbitz: admin "${x}" is not admitted by this room — add it to emails (or its domain to domains)`)
  }
  // OWNERS (2026-10-03): a level above admins, enforced by the room — an owner is an admin, and only an owner changes the
  // owners or lowers / removes an admin (Space#fork). Each must be admitted by this gate, like an admin.
  const owners = clean(a.owners)
  for (const x of owners) {
    if (!GATE_EMAIL.test(x)) throw badAdmission(`witbitz: owner "${x}" is not an email address`)
    if (!emails.includes(x) && !domains.includes(x.slice(x.indexOf('@') + 1))) throw badAdmission(`witbitz: owner "${x}" is not admitted by this room — add it to emails (or its domain to domains)`)
  }
  // `approve: 'admins'` (every card admin-only) is REMOVED (the owner, 2026-10-11: "Too complicated") — refused, never
  // dropped in silence: a builder who asked for it must learn the room will not enforce it.
  if (a.removeUsers !== undefined) throw Object.assign(new Error("witbitz: admission.removeUsers was removed — an @username is not stored in a room (only a hash of the account's email), so nobody is moved or removed by it"), { code: 'removed' })
  if (a.approve === 'admins') throw Object.assign(new Error("witbitz: admission.approve 'admins' was removed — admins still decide the cards that change admin-only collections or call a connection"), { code: 'removed' })
  if (a.approve !== undefined && a.approve !== 'members') throw badAdmission("witbitz: admission.approve is no longer an option")
  const adm = { ...(admins.length ? { admins: { emails: admins } } : {}), ...(owners.length ? { owners: { emails: owners } } : {}) }
  if (!adv.length) return { admission: 'email', allow: { ...(emails.length ? { emails } : {}), ...(domains.length ? { domains } : {}) }, ...adm } // all hashed (spaceClient), byte-identical to before when no admins
  const shown = emails.filter((x) => adv.includes(x)), hidden = emails.filter((x) => !adv.includes(x))
  return { admission: 'email', allow: { emails: shown, hidden, ...(domains.length ? { domains } : {}) }, ...adm } // spaceClient: `emails` stay readable, `hidden` are hashed
}

const lower = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [])
/** The owners and admins of a room's sealed config, lower-cased. */
export const govOf = (cfg) => ({ owners: lower(cfg && cfg.owners && cfg.owners.emails), admins: lower(cfg && cfg.admins && cfg.admins.emails) })

/** May `email` move this room at all? In a room with admins or owners only they may; otherwise any verified member
 *  (the server's rule — spaceService refuses a fork notice from a non-admin where there are admins). */
export function mayMove(cfg, email) {
  const { owners, admins } = govOf(cfg), me = String(email || '').toLowerCase()
  return !(admins.length || owners.length) || admins.includes(me) || owners.includes(me)
}

/** The OWNERS step of a move, before anything is minted: fills the new gate's owners (and, unless stated, the admins it
 *  still admits) from the old room, and refuses a move the server would refuse. → { gate, gov } (gov null in a room
 *  without owners). `statedAdmins` = whether the caller stated the new admins itself. */
export function planGovernance(old, gate, email, statedAdmins) {
  const { owners: oldOwners, admins: oldAdmins } = govOf(old)
  const me = String(email || '').toLowerCase()
  if (!oldOwners.length) return { gate, gov: null }
  gate.owners = gate.owners || { emails: oldOwners }
  if (!statedAdmins && oldAdmins.length) gate.admins = { emails: oldAdmins.filter((e) => admittedBy(gate, e)) }
  const gov = { owners: (gate.owners && gate.owners.emails) || [], admins: (gate.admins && gate.admins.emails) || [] }
  const why = govRefusal(oldOwners, oldAdmins, gov, oldOwners.includes(me))
  if (why) throw Object.assign(new Error('witbitz: ' + why), { code: 'not_owner' })
  const out = [...gov.owners, ...gov.admins].find((x) => !admittedBy(gate, x))
  if (out) throw new Error(`witbitz: "${out}" is an owner or admin of the new room but its gate does not admit them — add them to emails`)
  return { gate, gov }
}

/** The NEW room's config: the same assistant, store and settings under the new gate. Governance from the old gate does
 *  not carry (allow, admins, owners, approve, revoked, the key roster), and a connection carries only when the account
 *  that granted it is still admitted. `forkedFrom` records where it came from, inside the sealed config. */
/** A LEGACY room's advertised @username entries (`allow.users: [{ handle, username }]`, written before 2026-10-11) as the
 *  handles to carry into the room it moves to — where they are stored HASHED like any hidden entry (spaceClient
 *  `handles`). The username label does not carry: an @username is only a redirect, resolved once at invite (the owner,
 *  2026-10-11). One rule for the app's Change members and the SDK's fork. */
export function carriedHandles(old) {
  return [...new Set((old && old.allow && Array.isArray(old.allow.users) ? old.allow.users : [])
    .filter((u) => u && typeof u === 'object' && typeof u.handle === 'string' && u.handle).map((u) => u.handle))]
}

/** Throws `admins_required` for a collection declared `write: 'admins'` in a room with no admins or owners: the server
 *  enforces it only where there are some, so every member would write it (sync sweep, 2026-10-10). `cfg` carries
 *  `admins` / `owners` as the sealed config does — a create's gate, a fork's new config. */
export function checkAdminCollections(data, cfg) {
  const adminOnly = data && typeof data === 'object' ? Object.entries(data).find(([, v]) => v && typeof v === 'object' && v.write === 'admins') : null
  const g = cfg || {}
  if (adminOnly && !(g.admins && Array.isArray(g.admins.emails) && g.admins.emails.length) && !(g.owners && Array.isArray(g.owners.emails) && g.owners.emails.length)) {
    throw Object.assign(new Error(`witbitz: collection "${adminOnly[0]}" is write: 'admins', but the room has no admins or owners — give admission.admins (or owners), or drop write: 'admins'`), { code: 'admins_required' })
  }
}

export function forkConfig(old, gate, fromRoom) {
  // `funding` stays behind: a grant is bound to ITS room (roomFunding: other_room), so the new room would say it is funded and pay nothing (sync sweep, 2026-10-10)
  const { admission: _a, allow: _al, admins: _ad, owners: _ow, approve: _ap, revoked: _r, roster: _ro, parent: _p, forkAuthority: _f, enclave: _e, funding: _fu, ...keep } = old || {}
  if (Array.isArray(keep.connections)) {
    const kept = keep.connections.filter((c) => c && admittedBy(gate, accountEmail(c.account))) // the person, not the app's account (accountScope.js)
    if (kept.length) keep.connections = kept; else delete keep.connections
  }
  return { ...keep, ...gate, forkedFrom: fromRoom, region: roomRegion(fromRoom) } // the new room stays in the old one's region
}

/** The devices that receive the new key: every device that announced itself in the room's guest book AND that the gate
 *  verified under an address the new gate admits — plus this one (`selfPub`). → Map(jkey → EC public JWK). */
export function forkTargets({ book, gate, selfPub }) {
  const admits = (email) => {
    const e = String(email || '').toLowerCase(), a = gate.allow || {}
    return [...(a.emails || []), ...(a.hidden || [])].includes(e) || (a.domains || []).includes(e.slice(e.indexOf('@') + 1))
  }
  const targets = new Map([[jkey(selfPub), bareEC(selfPub)]])
  const seen = (book && book.seen) || {}
  // The guest book's rows: the SDK writes them as the doc itself (an array); the app as { people: [...] } (space.js
  // announceSelf). Both name a member's row by its signing key (x.y) and the server's `seen` vouches for it the same way.
  const st = book && book.state
  const rows = Array.isArray(st) ? st : (st && Array.isArray(st.people) ? st.people : [])
  for (const row of rows) {
    const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec((row && row.id) || '')
    if (m && seen[row.id] && admits(seen[row.id].email)) targets.set(row.id, { kty: 'EC', crv: 'P-256', x: m[1], y: m[2] })
  }
  return targets
}

/** The fork NOTICE posted into the old room: the new room's pointer sealed to each target device, the boxes bound by
 *  their hash in the signed text, and the declared governance. */
export async function forkNotice({ from, room, mk, link, targets, gov = null, ts = Date.now() }) {
  const pointer = JSON.stringify({ v: 1, kind: 'space-fork', from, room, mk, link })
  const boxes = await Promise.all([...targets.values()].map((j) => sealTo(pointer, j)))
  return { kind: 'fork', id: 'fork:' + ts, ts, name: 'fork', from: 'fork', text: 'fork:' + (await boxesHash(boxes)), boxes, ...(gov ? { gov } : {}) }
}

// THE CREATOR'S SIGNATURE (a room with no owners/admins). The server's stamp names the key the email gate verified — the
// device's EMAIL signing key — while the room's `forkAuthority` is the creator key minted at creation, a different key. So
// in such a room the creator's device also signs the notice with the creator key (`sig`, a field the server keeps) and
// members verify it against `forkAuthority`. Bound to the room and the notice text (which binds the boxes).
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIG_ALG = { name: 'ECDSA', hash: 'SHA-256' }
const moveMessage = (room, text) => new TextEncoder().encode('witbitz-email-move|' + room + '|' + text)
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const ecJwk = (j, priv) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y, ...(priv ? { d: j.d } : {}) })
/** The creator signs a notice (a room with no owners/admins). → the notice with `sig`. */
export async function signMove(notice, room, creatorPriv) {
  const k = await crypto.subtle.importKey('jwk', ecJwk(creatorPriv, true), ECDSA, false, ['sign'])
  return { ...notice, sig: b64u(new Uint8Array(await crypto.subtle.sign(SIG_ALG, k, moveMessage(room, notice.text)))) }
}
/** Was this notice signed by `pub` for this room? Anything malformed is a no. */
export async function moveSignedBy(e, room, pub) {
  try {
    if (!e || typeof e.sig !== 'string' || !pub || !pub.x) return false
    const k = await crypto.subtle.importKey('jwk', ecJwk(pub, false), ECDSA, false, ['verify'])
    return await crypto.subtle.verify(SIG_ALG, k, unb64u(e.sig), moveMessage(room, String(e.text || '')))
  } catch { return false }
}

/** A member's device decides about a fork notice in an email room. `cfg` = the room's sealed config as this device reads
 *  it, `signPriv` = this device's signing key, `forkAuthority` = the room's creator key when it has no owners/admins (the
 *  app's rule: there, only a notice the creator key SIGNED is followed — signMove; the SDK passes none). → { follow: pointer } | { refuse: reason } | null
 *  (not for this device / not a valid notice — ignore it). The caller still checks the NEW room (newRoomKeepsGov). */
export async function judgeMove(e, { cfg, signPriv, room, forkAuthority = null }) {
  if (!signPriv) return null
  const auth = await moveAuthority(e, { cfg, room, forkAuthority })
  if (auth !== 'ok') return auth === 'refuse' ? { refuse: 'the move does not keep this room\'s owners and admins' } : null
  const { owners } = govOf(cfg)
  for (const b of e.boxes) {
    let o = null
    try { const pt = await openBox(b, bareEC(signPriv)); o = pt ? JSON.parse(pt) : null } catch { o = null }
    if (o && o.kind === 'space-fork' && o.from === room && o.room && o.mk && typeof o.link === 'string') return { follow: o, needsGovCheck: owners.length > 0 }
  }
  return null
}

/** IS THIS A REAL MOVE OF THIS ROOM — whoever it is addressed to? The checks judgeMove makes before opening a box: the
 *  server's stamp, an admin's notice where the room has owners/admins (else the creator's signature), the owners kept,
 *  the boxes bound by the text. → 'ok' | 'refuse' | null. A device the notice does NOT address (a member removed by it)
 *  uses it to know the room is over (space.js noteMovedRoom). */
export async function moveAuthority(e, { cfg, room, forkAuthority = null }) {
  if (!e || e.kind !== 'fork' || e.verified !== true || !Array.isArray(e.boxes)) return null
  const { owners, admins } = govOf(cfg)
  if ((admins.length || owners.length) && e.admin !== true) return null
  if (!admins.length && !owners.length && forkAuthority && !(await moveSignedBy(e, room, forkAuthority))) return null
  if (owners.length && (!e.gov || govRefusal(owners, admins, e.gov, e.owner === true))) return 'refuse'
  if (String(e.text || '') !== 'fork:' + (await boxesHash(e.boxes))) return null
  return 'ok'
}

/** OWNERS: does the NEW room's sealed config (read with the new room's key) name exactly the owners and admins the move
 *  declared, and admit each of them? Anything unreadable is a no. */
export async function newRoomKeepsGov(cfg, gov, room) {
  try {
    if (!cfg || cfg.admission !== 'email') return false
    const set = (o) => [...new Set((o && Array.isArray(o.emails) ? o.emails : []).map((x) => String(x).trim().toLowerCase()))].sort().join('\n')
    const want = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase()))].sort().join('\n')
    if (set(cfg.owners) !== want(gov.owners) || set(cfg.admins) !== want(gov.admins)) return false
    const a = cfg.allow || {}
    for (const e of [...gov.owners, ...gov.admins]) {
      const x = String(e).toLowerCase()
      const ok = (Array.isArray(a.emails) && a.emails.map((y) => String(y).toLowerCase()).includes(x)) ||
        (Array.isArray(a.mh) && a.mh.includes(await memberHash(x, room))) ||
        (Array.isArray(a.domains) && a.domains.map((d) => String(d).toLowerCase().replace(/^@/, '')).includes(x.slice(x.indexOf('@') + 1)))
      if (!ok) return false
    }
    return true
  } catch { return false }
}

/** THE NEW ROOM'S OWNERS, READ AS A DEVICE CAN (the owner, 2026-10-21: a remaining member's Android refused a move as "owners
 *  or admins don't match" and stayed behind with the removed member; reopening followed at once). `read()` → the new room's
 *  sealed config; right after a move it can fail or come back empty (a confidential, verified room is still waking or
 *  signing this device in). Tried a few times over ~40 s. → 'keeps' | 'differs' (it read, and names other owners/admins —
 *  final) | 'unreadable' (never read — not a verdict on the move). `pause(ms)` is for tests. */
export const NEW_ROOM_READ_WAITS = [2000, 4000, 8000, 12000, 15000]
export async function checkNewRoomGov(read, gov, room, { pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    let cfg = null
    try { cfg = await read() } catch { cfg = null }
    if (cfg && typeof cfg === 'object') return (await newRoomKeepsGov(cfg, gov, room)) ? 'keeps' : 'differs'
    if (i >= NEW_ROOM_READ_WAITS.length) return 'unreadable'
    await pause(NEW_ROOM_READ_WAITS[i])
  }
}

/** CARRY THE HISTORY (2026-10-07). The SERVER copies it (op 'carry'): it reads the old room under its key and keeps each
 *  entry's verified mark as `carried` — which a device carrying the entries itself could never vouch for. `page(cursor)`
 *  → the op's answer for one page; the loop follows `next`. A server without the op (a confidential room until its
 *  enclave learns it) or a path that cannot send the old key answers 400 on the first page — and a room worker of an older
 *  build (the hosted app's vault) THROWS there, not knowing the op — and `viaDevice()` carries the history the old way (the
 *  marks are then not kept). → { carried, server } or { refused: <the answer> }. */
export async function carryHistory(page, viaDevice) {
  if (typeof page !== 'function') return { carried: await viaDevice(), server: false }
  let cursor = 0, carried = 0
  for (let n = 0; n < 10000; n++) {
    let r
    try { r = await page(cursor) } catch (e) { if (n === 0) return { carried: await viaDevice(), server: false }; throw e }
    if (n === 0 && r && r.status === 400) return { carried: await viaDevice(), server: false }
    if (!r || r.status !== 200) return { refused: r || { status: 0 } }
    carried += Number(r.carried) || 0
    if (!Number.isInteger(r.next) || r.next <= cursor) return { carried, server: true }
    cursor = r.next
  }
  return { refused: { status: 0, error: 'carry_runaway' } }
}
