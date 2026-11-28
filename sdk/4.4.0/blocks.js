// blocks.js — BLOCK A PERSON (App Store rule 1.2; docs/report-and-block.md §4; the owner, 2026-11-07: blocked messages are
// collapsed with "Show", never gone). Everything happens on your own devices: their messages collapse here, nothing changes for
// anyone else in the room (an admin can still remove them — Change members).
//
// WHO can be blocked is decided by what proves who wrote a message, never by the typed name — every proof the device has, kept
// together, a message matching ANY of them (the owner, 2026-11-08: "Yes" to keying Block on the verified identity):
//   { email }       the verified email the room recorded for the key that signed it (roster_seen, senderNames.attestedIdentity) —
//                   the same person on every device, in every Space, whatever they rename themselves to
//   { user }        the @username the SERVER stamped on a verified room's message — every room, until they rename
//   { room, sid }   the key that signed it, in that room only (a person with no verified identity; any signed message)
// A message with none offers no Block. One entry per person: keyed on the email, else the username, else the key. Kept in localStorage `space:blocks` (durable; in the hosted app it goes to the vault
// like every key) and synced to your other devices as the account document `blocks` (roomSync.js syncBlocks). An unblock is
// kept as a tombstone (`gone`) so a device that still lists the person does not bring them back: the newer `at` wins.
export const BLOCKS_KEY = 'space:blocks'
export const BLOCKS_DOC = 'blocks'
const MAX = 500

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{1,60}$/
const keyOf = (b) => (b.email ? 'e:' + String(b.email).toLowerCase() : b.user ? 'u:' + String(b.user).toLowerCase() : b.room && b.sid ? 's:' + b.room + '|' + b.sid : '')
/** Does this list entry name the writer `who` ({ email?, user?, room?, sid? })? Any proof the two share. */
const names = (b, who) => !!who && ((b.email && who.email && b.email === String(who.email).toLowerCase()) ||
  (b.user && who.user && b.user === String(who.user).toLowerCase()) ||
  (b.room && b.sid && who.room === b.room && who.sid === b.sid))

/** A clean list: known fields only, one entry per person (the newest), at most MAX. */
export function cleanBlocks(list) {
  const by = new Map()
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof b !== 'object') continue
    const e = {
      ...(typeof b.email === 'string' && EMAIL.test(b.email) ? { email: b.email.toLowerCase() } : {}),
      ...(typeof b.user === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(b.user) ? { user: b.user.toLowerCase() } : {}),
      ...(typeof b.room === 'string' && b.room.length <= 80 && typeof b.sid === 'string' && b.sid.length <= 200 ? { room: b.room, sid: b.sid } : {}),
      name: typeof b.name === 'string' ? b.name.slice(0, 80) : '',
      at: Number.isFinite(+b.at) ? +b.at : 0,
      ...(b.gone === true ? { gone: true } : {}),
    }
    const k = keyOf(e); if (!k) continue
    const was = by.get(k); if (!was || e.at >= was.at) by.set(k, e)
  }
  // ⛔ AN UNBLOCK NAMES THE PERSON, NOT ONE KEY (2026-11-09, docs/state-machines.md C#18): a tombstone keyed on the email left an
  //   older live entry of the same person kept under another proof (a key-only block from another device) — it still named them,
  //   and the merge blocked them again everywhere. A newer unblock retires every older block it shares a proof with.
  const gone = [...by.values()].filter((g) => g.gone)
  for (const [k, b] of by) if (!b.gone) { const g = gone.find((t) => t.at >= b.at && names(t, b)); if (g) by.set(k, { ...b, name: '', at: g.at, gone: true }) }
  return [...by.values()].sort((a, b) => b.at - a.at).slice(0, MAX)
}

/** Two devices' lists → one: per person the newer entry (a block or an unblock) wins. */
export const mergeBlocks = (a, b) => cleanBlocks([...(a || []), ...(b || [])])

let syncHook = null
export function setBlocksSync(fn) { syncHook = typeof fn === 'function' ? fn : null }
export function readBlocks() { try { return cleanBlocks(JSON.parse(localStorage.getItem(BLOCKS_KEY) || '[]')) } catch { return [] } }
function writeBlocks(list, { sync = true } = {}) {
  const clean = cleanBlocks(list)
  try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(clean)) } catch { /* storage full: the list holds for this session */ }
  try { window.dispatchEvent(new CustomEvent('wb-blocks')) } catch { /* not in a page */ }
  if (sync && syncHook) { try { syncHook() } catch { /* */ } }
  return clean
}
/** Another device's list arrived: merged in, no echo back. */
export function adoptBlocks(list) { return writeBlocks(mergeBlocks(readBlocks(), list), { sync: false }) }

/** Who wrote this entry, as Block knows a person → { email?, user?, room?, sid? } | null. `id`: what the room verified about
 *  its writer (senderNames.attestedIdentity → { email, user }), read by the caller. */
export function blockIdentity(room, e, { attested = false, sid = '', id = null } = {}) {
  if (!e) return null
  const out = {}
  if (attested && e.verified === true) {
    const email = id && typeof id.email === 'string' && EMAIL.test(id.email) ? id.email.toLowerCase() : ''
    const user = (id && id.user) || (typeof e.user === 'string' ? e.user : '')
    if (email) out.email = email
    if (user && /^[a-z0-9_.-]{1,40}$/i.test(String(user).replace(/^@/, ''))) out.user = String(user).replace(/^@/, '').toLowerCase()
  }
  if (room && sid) { out.room = room; out.sid = sid }
  return Object.keys(out).length ? out : null
}

export function isBlocked(who, list = readBlocks()) {
  if (!who || !keyOf(who)) return false
  // the newest word per person wins (cleanBlocks); a person is blocked when a live entry names them by any proof
  return list.some((b) => !b.gone && names(b, who))
}

/** §4 "their invites are dropped" (sync sweep 2026-11-13 P5): an invite box is an anonymous drop, so only a DIRECT CHAT's invite
 *  says who sent it (`direct`: the sender's address, space.js). True when that address is blocked; a typed `from` is never matched.
 *  A forged address only drops the forger's own invite; a blocked person's messages collapse inside any room they reach anyway. */
export function blockedInvite(inv, list = readBlocks()) {
  const a = inv && typeof inv.direct === 'string' ? inv.direct.trim() : ''
  if (!a) return false
  const who = a.startsWith('@') ? { user: a.slice(1).toLowerCase() } : (EMAIL.test(a) ? { email: a.toLowerCase() } : null)
  return !!who && isBlocked(who, list)
}

export function block(who, name = '') { if (!keyOf(who || {})) return readBlocks(); return writeBlocks([...readBlocks(), { ...who, name, at: Date.now() }]) }
/** Every live entry that names this writer goes — one made from another of their proofs (an older key-only block) too. */
export function unblock(who) {
  if (!keyOf(who || {})) return readBlocks()
  const at = Date.now(), list = readBlocks()
  const gone = list.filter((b) => !b.gone && names(b, who)).map((b) => ({ ...b, name: '', at, gone: true }))
  return writeBlocks([...list, ...(gone.length ? gone : [{ ...who, name: '', at, gone: true }])])
}
export const blockedPeople = () => readBlocks().filter((b) => !b.gone)

/** The account document: read it, merge ours in, write it back when it differs (a pull when no `write`); never over an unknown state. */
export async function syncBlocksDocument({ read, write }) {
  const r = await read()
  if (!r || (r.status !== 200 && r.status !== 404)) return false
  const theirs = r.status === 200 && r.state && Array.isArray(r.state.list) ? r.state.list : []
  const merged = mergeBlocks(readBlocks(), theirs)
  writeBlocks(merged, { sync: false })
  if (write && JSON.stringify(cleanBlocks(theirs)) !== JSON.stringify(merged)) await write({ v: 1, list: merged }) // no `write`: a pull only
  return true
}
