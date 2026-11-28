// siri.js — the page's half of the CONFIDENTIAL VOICE INBOX (docs/siri-inbox.md). A Shortcut posts what you said to
// siri.witbitz.chat; TLS ends inside the standing Sentinel, which seals the words to the Space's INBOX PUBLIC KEY and
// keeps the box until one of your devices collects it. This module:
//   · mints the Shortcut's KEY (kept in store.js, riding the account; the Sentinel holds only its hash),
//   · mints a Space's INBOX KEYPAIR when you enable Siri there (the private half never leaves your devices),
//   · sends the account's RECORD to the Sentinel — every alias, every inbox public key, the key hash, the default —
//     sealed to the Sentinel's attested share key exactly as a connection grant is (attest → sealTo → sirigrant),
//   · COLLECTS: pulls the drops, opens this Space's with its private key, posts each as you (🎙 marks the voice), acks.
// Nothing here reaches the Sentinel except through the Lambda's op:'sentinel' door, which relays ciphertext both ways.
import { sealTo } from './sealShare.js'
import { genRecipientKey, openBox } from './e2ee.js'
import { loadSiri, saveSiri, normSiriAlias } from './store.js'

export const SIRI_ENDPOINT = 'https://siri.witbitz.chat/in'
export class SiriError extends Error { constructor(m, code = '') { super(m); this.code = code } }
// connections.js (the Sentinel attestation) pulls the Nitro verifier in; loaded only when a record is pushed, so this
// module — and the collector — stay loadable where there is no verifier (the tests, and one day a lighter surface).
// ⛑ STAMPED, like every other lazy import here (spaceClient.js, enclave.js, drawer.js). A BARE './connections.js' is a
// URL that never changes across builds, so a phone's 4-hour HTTP cache hands back the previous build's bytes under this
// build's signed manifest and the loader refuses the module: "Cannot load script due to integrity mismatch" — which is
// exactly what the owner's iPhone showed on the first Siri deploy (2026-09-26). spaces/test/stampedImports.test.mjs.
const attest = async (o) => (await import('./connections.js')).attestStandingSentinel(o)
export const SIRI_MARK = '🎙 ' // what a collected drop opens with, so everyone (and the assistant) sees it was said, not typed
const b64url = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))

/** A fresh Shortcut key: 32 random bytes, base64url, prefixed so it is recognisable in the Shortcuts app. */
export const newSiriKey = () => 'wsk_' + b64url(crypto.getRandomValues(new Uint8Array(32)))
/** What the Sentinel keeps of the key: sha256, standard base64. */
export async function siriKeyHash(key) { return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)))) }

/** The account's record as the Sentinel wants it (siri.mjs normSiriRecord), from the store's copy. */
export async function siriRecordFor(account, s = loadSiri()) {
  const rooms = Object.entries(s.rooms || {})
  return {
    // a key the hosted app's vault holds is here only as its hash (`tokenHash`; vaultAcctSecrets.js, review § 7.6) — the same value
    account, tokenHash: s.token ? await siriKeyHash(s.token) : String(s.tokenHash || ''),
    aliases: rooms.map(([room, r]) => ({ alias: r.alias, room, label: r.label || '', inboxPub: { x: r.pub.x, y: r.pub.y } })),
    defaultAlias: s.defaultRoom && s.rooms[s.defaultRoom] ? s.rooms[s.defaultRoom].alias : '',
    created: Date.now(),
  }
}

/** Send the whole record, sealed to the attested Sentinel. Idempotent: the Sentinel REPLACES what it held. `s`: the record to
 *  send — the store's, or a COPY with a change the caller keeps only once the Sentinel took it (pass 9, K#5). */
const EDIT_KEY = 'space:siri-pending-edit'
let publishing = Promise.resolve()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function applyEdit(base, next, latest) {
  if ((base.rev || 0) !== (latest.rev || 0) || ((base.token || base.tokenHash) && (base.token || base.tokenHash) !== (latest.token || latest.tokenHash))) return latest
  const result = structuredClone(latest)
  for (const field of ['token', 'tokenHash', 'defaultRoom']) if ((field === 'defaultRoom' || !(latest.token || latest.tokenHash) || (base.token || base.tokenHash)) && !same(base[field], next[field]) && same(base[field], latest[field])) result[field] = next[field]
  for (const room of new Set([...Object.keys(base.rooms), ...Object.keys(next.rooms)])) {
    if (same(base.rooms[room], next.rooms[room]) || !same(base.rooms[room], latest.rooms[room])) continue
    if (next.rooms[room] && (latest.gone?.[room] || 0) < next.rooms[room].at) result.rooms[room] = next.rooms[room]
    else if (!next.rooms[room]) {
      delete result.rooms[room]
      result.gone = { ...(result.gone || {}), [room]: Math.max(Date.now(), (base.rooms[room]?.at || 0) + 1) }
      if (result.defaultRoom === room) result.defaultRoom = ''
    }
  }
  const aliases = Object.values(result.rooms).map(row => row.alias)
  if (new Set(aliases).size !== aliases.length) throw new SiriError('This Siri name is already in use.', 'alias')
  if (Object.keys(result.rooms).length > 64) throw new SiriError('Siri can use up to 64 Spaces.', 'too_many_rooms')
  return result
}
export function pushSiriRecord(options = {}) {
  const { account, s, base = loadSiri() } = options
  const run = async () => {
    if (options.current && !options.current()) throw new SiriError('The account changed.', 'account_changed')
    const read = () => JSON.parse(localStorage.getItem(EDIT_KEY) || '{}')
    const drop = entry => { const all = read(); if (same(all[account], entry)) { delete all[account]; if (Object.keys(all).length) localStorage.setItem(EDIT_KEY, JSON.stringify(all)); else localStorage.removeItem(EDIT_KEY) } }
    // ★ A REPLAYED ENTRY THAT IS DROPPED MAY ALREADY BE AT THE SENTINEL (its answer was lost — that is why it was pending). Dropping it
    //   alone left the Sentinel aliasing a Space to an inbox key whose private half existed only in the dropped entry: captures
    //   accepted that nobody could open (second review, 2026-11-27). So the record this device DOES hold is sent at once; if that
    //   fails too, the next Siri change sends it.
    const converge = async () => { try { await publishSiri({ ...options, s: loadSiri() }) } catch { /* the next Siri change sends the record */ } }
    const transmit = async (entry, replayed = false) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (options.current && !options.current()) throw new SiriError('The account changed.', 'account_changed')
        if (!same(read()[account], entry)) throw new SiriError('The Siri setup changed.', 'siri_busy')
        // An edit that can no longer apply (its name now taken, the 64 limit) is dropped, not kept: it was replayed before every
        // later Siri save and failed each of them, for good (review of the sweep fixes, 2026-11-27; 2ccbc1bff)
        const current = loadSiri()
        let candidate
        try { candidate = applyEdit(entry.base, entry.next, current) } catch (error) { drop(entry); if (replayed) await converge(); throw error }
        if (!attempt && same(candidate, current)) { drop(entry); return { ok: true } }
        const value = localStorage.getItem(EDIT_KEY)
        const saved = options.confirmStored ? await options.confirmStored(EDIT_KEY, value) : localStorage.getItem(EDIT_KEY) === value
        if (!saved) { drop(entry); if (replayed) await converge(); throw new SiriError('Could not save the pending Siri change on this device.', 'storage_failed') } // not kept either: a device that cannot store it would replay it for ever
        if (!same(read()[account], entry) || (options.current && !options.current())) throw new SiriError('The Siri setup changed.', 'siri_busy')
        let result
        try { result = await publishSiri({ ...options, s: candidate }) }
        catch (error) { if (error.definiteRefusal) { drop(entry); if (replayed) await converge() } throw error }
        if (!same(read()[account], entry) || (options.current && !options.current())) throw new SiriError('The Siri setup changed.', 'siri_busy')
        if (!same(current, loadSiri())) continue
        saveSiri(candidate)
        drop(entry)
        return result
      }
      throw new SiriError('The Siri setup is changing. Try again.', 'siri_busy')
    }
    const pending = read()[account]
    if (pending) {
      await transmit(pending, true)
      if (options.current && !options.current()) throw new SiriError('The account changed.', 'account_changed')
    }
    if (!s || same(base, s)) return publishSiri({ ...options, s: loadSiri() })
    const entry = { base, next: s }
    localStorage.setItem(EDIT_KEY, JSON.stringify({ ...read(), [account]: entry }))
    return transmit(entry)
  }
  const operation = publishing.then(run)
  publishing = operation.catch(() => {})
  return operation
}
async function publishSiri({ post, auth = {}, account, pins, verify, intake = null, s = loadSiri() } = {}) {
  if (!s.token && !s.tokenHash) throw new SiriError('no Siri key on this device yet', 'no_key')
  const rec = await siriRecordFor(account, s)
  // THE INTAKE (docs/message-intake.md): { room, pub, drop } — the Sentinel then drops what was said into the account's
  // message room, and any device of the account posts it (the app: intakeProducers.js). Without it: kept for a pull, as before.
  if (intake && intake.room && intake.pub && intake.drop) rec.intake = { room: intake.room, pub: { x: intake.pub.x, y: intake.pub.y }, drop: intake.drop }
  const { nonce, key } = await attest({ post, auth, pins, verify })
  const sealed = await sealTo(key, nonce, rec)
  const r = await post({ op: 'sentinel', sentinel: { mode: 'sirigrant', sealed }, ...auth })
  if (!r || r.error || !r.ok) throw Object.assign(new SiriError(`the Sentinel refused the record (${(r && (r.error || r.reason)) || 'no answer'})`, (r && r.error) || 'refused'), { definiteRefusal: !!r && !!(r.error || r.ok === false) && !(r.status >= 500) && !['busy', 'unreachable', 'sentinel_unavailable', 'timeout'].includes(r.error) })
  return r
}
export async function siriStatus({ post, auth = {} }) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'siristatus' }, ...auth })
  if (!r || r.error) throw new SiriError(`the Sentinel could not be reached (${(r && r.error) || 'no answer'})`, (r && r.error) || 'unreachable')
  return r
}
export function siriRevoke({ post, auth = {}, account, current = () => true, expectedRev }) {
  const run = async () => {
    if (!current()) throw new SiriError('The account changed.', 'account_changed')
    if (expectedRev !== undefined) {
      const s = loadSiri()
      if (s.rev !== expectedRev || s.token || s.tokenHash) throw new SiriError('The Siri setup changed.', 'siri_busy')
    }
    const r = await revokeRecord(post, auth, current, expectedRev === undefined)
    if (account) {
      const pending = JSON.parse(localStorage.getItem(EDIT_KEY) || '{}')
      delete pending[account]
      if (Object.keys(pending).length) localStorage.setItem(EDIT_KEY, JSON.stringify(pending))
      else localStorage.removeItem(EDIT_KEY)
    }
    return r
  }
  const operation = publishing.then(run)
  publishing = operation.catch(() => {})
  return operation
}
async function revokeRecord(post, auth, current, save) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'sirirevoke' }, ...auth })
  if (!r || r.error) throw new SiriError(`the Sentinel could not be reached (${(r && r.error) || 'no answer'})`, (r && r.error) || 'unreachable')
  // the setup is DELETED on every device of the account (pass 9, K#3): `rev` outranks any copy that still holds the old key,
  // and each Space is marked taken off, so no other device's copy brings an alias or the key back
  if (!current()) throw new SiriError('The account changed.', 'account_changed')
  if (!save) return r
  const was = loadSiri(), now = Date.now()
  saveSiri({ token: '', defaultRoom: '', rooms: {}, rev: (was.rev || 0) + 1, gone: { ...(was.gone || {}), ...Object.fromEntries(Object.keys(was.rooms).map((rm) => [rm, now])) } })
  return r
}

/** Enable Siri for a Space on this account: an alias, an inbox keypair (once), optionally the default. Local only —
 *  the caller pushes the record. Returns the store's copy. */
//  `mint` / `mintToken` (the hosted app, siriSheet.js — only where the vault holds Siri keys, acctHeld.js): the inbox keypair and
//  the Shortcut key are minted IN THE VAULT (vaultAcctSecrets.js, review § 7.6) → a public half / the key's hash; the room is a
//  held stub ({ alias, label, pub, at, held: 1 }) and the key is kept here as `tokenHash` only.
export async function enableSiriHere({ room, label = '', alias, makeDefault = false, mint = null, mintToken = null, draft = null } = {}) {
  const a = normSiriAlias(alias)
  if (!a) throw new SiriError('an alias is needed — the word you will say to Siri', 'alias')
  if (/[,:;]/.test(a)) throw new SiriError('an alias cannot contain , : or ;', 'alias')
  const taken = (st) => { for (const [rm, r] of Object.entries(st.rooms)) if (rm !== room && r.alias === a) throw new SiriError(`"${a}" already names another Space`, 'alias') }
  // THE SLOW PART FIRST, THEN THE CHANGE ON WHAT IS THERE NOW (sync sweep 2026-11-14 #2, as the SDK since 48ddb8733): the vault's mints
  // (up to 8 s each) or the keypair ran on a copy read BEFORE them, and saving that copy dropped another device's merge that landed
  // meanwhile — and the record pushed to the Sentinel lacked it.
  const s0 = draft || loadSiri(); taken(s0)
  if (!s0.rooms[room] && Object.keys(s0.rooms).length >= 64) throw new SiriError('Siri can use up to 64 Spaces.', 'too_many_rooms')
  const tokenHash = (!s0.token && !s0.tokenHash && mintToken) ? await mintToken() : ''
  const fresh = s0.rooms[room] ? null : mint ? { held: 1, pub: await mint() } : { kp: await genRecipientKey() }
  const s = draft || loadSiri(); taken(s)
  if (!s.rooms[room] && Object.keys(s.rooms).length >= 64) throw new SiriError('Siri can use up to 64 Spaces.', 'too_many_rooms')
  if (!s.token && !s.tokenHash) { if (tokenHash) s.tokenHash = tokenHash; else if (mintToken) s.tokenHash = await mintToken(); else s.token = newSiriKey() }
  const cur = s.rooms[room]
  if (cur) s.rooms[room] = { ...cur, alias: a, label: label || cur.label, at: Date.now() } // `at` moves on a rename: the newer copy leads a merge
  else {
    const f = fresh || (mint ? { held: 1, pub: await mint() } : { kp: await genRecipientKey() }) // removed elsewhere since the first read: made now
    s.rooms[room] = f.held ? { alias: a, label, pub: { x: f.pub.x, y: f.pub.y }, held: 1, at: Date.now() } : { alias: a, label, pub: { x: f.kp.publicJwk.x, y: f.kp.publicJwk.y }, priv: f.kp.privateJwk, at: Date.now() }
  }
  if (makeDefault) s.defaultRoom = room
  else if (s.defaultRoom === room) s.defaultRoom = ''
  return draft ? s : saveSiri(s)
}
export function disableSiriHere(room) {
  const s = loadSiri()
  if (!s.rooms[room]) return s
  s.gone = { ...(s.gone || {}), [room]: Math.max(Date.now(), (s.rooms[room].at || 0) + 1) } // recorded: off on the account's other devices too (pass 9, K#3)
  delete s.rooms[room]
  if (s.defaultRoom === room) s.defaultRoom = ''
  return saveSiri(s)
}
/** A new key: the old Shortcut stops working the moment the record is pushed. */
export function rotateSiriKey() { const s = loadSiri(); s.token = newSiriKey(); delete s.tokenHash; return saveSiri(s) }

/**
 * COLLECT: pull the account's drops; open and post the ones for THIS Space (in the order they were said); ack what
 * was posted (and what can no longer be opened — a drop for a key this account no longer has is unrecoverable);
 * report the Spaces that hold the rest, so the caller can say "Siri left a message for Family".
 * `send(text)` posts as the member (composer.js sendNow); a send that throws leaves the drop UNacked, to be collected next time.
 */
/**
 * `deliver` — hand each drop to the CALLER instead of posting it (a builder, 2026-09-27: their app files captures into
 * its own inbox verbatim, and posting starts an assistant turn they do not want). Posting was already this collector's
 * one injected step, so `deliver` replaces that call and nothing else moves: same pull, same ack rules, same
 * `elsewhere`. Two deliberate differences from the posting path:
 *   • the caller gets the words AS SPOKEN. `SIRI_MARK` exists to tell a ROOM that something was said rather than
 *     typed; an inbox has no audience to tell, and a caller that wants the mark can add it.
 *   • it gets `{ id, room, alias, at }` — which drop, which Space, the word that was actually said (how an app
 *     routes), and when Siri took it, not when we collected it.
 * ★ AT-LEAST-ONCE, and the asymmetry is the point. A `deliver` that throws or rejects is NOT acked, so a failed inbox
 * write never eats a capture — the next collect sees it again. The converse is the cost the caller must design for: a
 * write that SUCCEEDS and whose ack then fails is redelivered, so dedupe on `id`.
 */
// ⛔ ONE SPACE'S PULL, AND EACH DROP ACKED AS IT IS POSTED (state machines pass 9, K#6 K#9):
//   · the pull named no Space, so the Sentinel leased EVERY Space's drops to a collector that posts one Space's: for a minute
//     nobody could collect the others — the toast "open Family to deliver it" led to an empty pull, and a collector going Space
//     after Space never reached the later ones. The pull now names the Space; the others come back named, not leased
//     (`elsewhere` — a Sentinel before that names them only by handing them out, as before, and they are still listed);
//   · the lease is fixed at the pull (60 s) and the ack came after the whole loop, each drop a full turn: past a minute
//     another device (or a second collect) pulled the rest — those already posted too — and posted them again. Each drop is
//     now acked as it is posted, and nothing more is posted COLLECT_WINDOW_MS after the pull: the rest wait, unacked, for
//     the next pull (`more: true`).
export const COLLECT_WINDOW_MS = 45_000
// `open(drop, rec)` → the plaintext of a drop for a Space whose private key this copy does not hold (a held stub — the hosted
// app's vault opens it, siriCollect.js; review § 7.6). Without it such a drop is left, unopened, for a device that can.
export async function collectSiriDrops({ post, auth = {}, room, send, deliver = null, s = loadSiri(), now = Date.now, open = null } = {}) {
  const t0 = now()
  const r = await post({ op: 'sentinel', sentinel: { mode: 'siripull', ...(room ? { room } : {}) }, ...auth })
  if (!r || r.error || !Array.isArray(r.drops)) return { delivered: 0, elsewhere: [], error: (r && r.error) || 'no answer' }
  const elsewhere = new Map()
  const nameElsewhere = (rm) => { const rec = s.rooms[rm]; if (rec && rm !== room) elsewhere.set(rm, { room: rm, label: rec.label || rec.alias, alias: rec.alias }) }
  let delivered = 0, unopened = 0, more = false
  for (const d of r.drops) {
    if (!d || typeof d.id !== 'string') continue
    const rec = s.rooms[d.room]
    if (!rec) continue // enabled on another device and not synced here yet: leave it for that device
    if (d.room !== room) { nameElsewhere(d.room); continue }
    if (now() - t0 > COLLECT_WINDOW_MS) { more = true; continue } // its lease runs out before it could be posted and acked: the next pull takes it
    const text = rec.priv ? await openBox(d.box, rec.priv) : open ? await Promise.resolve().then(() => open(d, rec)).catch(() => null) : null
    // ⛔ NOT OPENED HERE IS NOT UNOPENABLE (2026-11-07, the implicit-state-machine review): this acked — deleted — a drop this
    //   device's key could not open, as "sealed to a key this Space no longer has". A device that has not synced a rotated Siri key
    //   yet holds the OLD one, and destroyed for good what another of the person's devices could open. Left for that device; the
    //   Sentinel drops what nobody collects after DROP_TTL_MS (30 days, infra/cloud-computer/sentinel/siri.mjs).
    if (text == null) { unopened++; continue }
    try {
      if (deliver) await deliver(text, { id: d.id, room: d.room, alias: d.alias, at: d.at })
      else await send(SIRI_MARK + text)
    } catch { continue /* not delivered: not acked; collected next time. A failed write must never cost the member the capture. */ }
    delivered++
    try { await post({ op: 'sentinel', sentinel: { mode: 'siriack', ids: [d.id] }, ...auth }) } catch { /* the next pull sees it again; the room dedupes nothing, so say so in the doc */ }
  }
  for (const e of Array.isArray(r.elsewhere) ? r.elsewhere : []) if (e && typeof e.room === 'string') nameElsewhere(e.room)
  return { delivered, elsewhere: [...elsewhere.values()], ...(unopened ? { unopened } : {}), ...(more ? { more } : {}) }
}

export const aliasFor = (title) => String(title || '').replace(/[,:;]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 32)
export function uniqueAlias(base, taken) {
  const b = aliasFor(base) || 'space'
  if (!taken.has(b)) return b
  for (let n = 2; ; n++) { const c = `${b.slice(0, 32 - String(n).length - 1)} ${n}`; if (!taken.has(c)) return c }
}

export function siriAliasesDiffer(rooms, status) {
  const aliases = Array.isArray(status.aliases) ? status.aliases : []
  return aliases.length !== Object.keys(rooms).length || aliases.some(a => !rooms[a.room] || rooms[a.room].alias !== a.alias)
}
