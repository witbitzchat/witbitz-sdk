// vaultKeep.js — WHAT AN SDK VAULT KEEPS FOR AN ACCOUNT, ON EVERY DEVICE OF IT (sync sweep 2026-11-11 P7; the owner: "8, yes").
// A builder's vault (vault-core.js) holds three things the page never sees: each connection's callKey, the Siri inbox's private
// keys and the outside agents' (A2A) lane keys. It kept them in its own storage only, so the same person's second device listed
// their connections (the server's list) but could not use one (`not_in_vault`), could not open Siri or an outside agent's message,
// and a lost device lost all three for good. The Witbitz app keeps the same things in the account's synced docs; this does that
// for the vault.
//
// WHERE: one doc (KEEP_DOC) in the account's INDEX ROOM (sdkAccount.js indexRoomOf — derived from the backup's master secret, so
// only the account's own devices can find or open it), sealed ON THE DEVICE under its own derived key: the room's key reaches the
// standard tier like any room's, but what this doc carries never does. A vault without the backup on has no index room: nothing
// syncs, as before.
// HOW DEVICES AGREE: per entry, last writer wins — a connection by its id, an A2A lane by its room, Siri as one entry — and a
// removed entry leaves a tombstone `{ at, gone: true }`, so a detach on one device is a detach everywhere. Merging is commutative.
// ★ THE CLOBBER RULE (as the index's): nothing is written unless the read before it was DEFINITIVE (a 200 that opened, or no doc
//   yet), and the write is conditional on the version read (a 409 → read and merge again).
import { sealDoc, openDoc } from './accountSeal.js'
import { normA2A } from './a2aCore.js' // a lane's one normal form (what sdk.a2a.restore makes of it)
// THE MERGE RULES ARE THE APP'S TOO (vault-core convergence C3): Siri by Space, agents by id, removal marks, tombstones, "write
// only what was applied" — one copy, keptMerge.js; this file keeps only the keep's own format (stamps, entries, the doc).
import { canon, unionMarks, mergePeers, mergeSiriRooms, siriKeyOf, siriDefaultOf, newerEntry as newer, mergeEntries as mergeMap, settleOf, MAX_TOMBS } from './keptMerge.js'
import { index2Doc } from './accountIndexDoc.js' // the app's xindex2 builder (phase 4, below)

export const KEEP_DOC = 'xvaultkeep' // x…: sealed on the device (agent/spaceService.mjs ACCOUNT_DOCS)
export const APP_KEEP_DOC = 'xindex2' // the Spaces app's sealed 'index2' (accountStores.js SEALED) — phase 4, below
const enc = new TextEncoder()
const SALT = enc.encode('witbitz-sdk-account-v1') // = sdkAccount.js — one derivation tree per account
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)
const ub64 = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }

/** The doc's sealing key, from the account's backup master (base64). */
export async function keepKeyOf (masterB64) {
  const km = await crypto.subtle.importKey('raw', ub64(masterB64), 'HKDF', false, ['deriveBits'])
  const raw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode('vault-keep-seal') }, km, 256))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export const emptyKeep = () => ({ v: 1, conns: {}, a2a: {}, siri: null })
const normKeep = (k) => ({ v: 1, conns: (k && k.conns && typeof k.conns === 'object') ? k.conns : {}, a2a: (k && k.a2a && typeof k.a2a === 'object') ? k.a2a : {}, siri: (k && k.siri && typeof k.siri === 'object') ? k.siri : null })

// ⛔ ONE NORMAL FORM BEFORE ANY COMPARISON (state machines pass 9, K#4): a lane was kept as enableLaneIn left it (the exported
//   private JWK, `ext` and `key_ops` included) while every device that applied it held it as sdk.a2a.restore → normA2A makes it.
//   The next pass read `prev` (raw) ≠ the store (normalised) as a change made HERE, stamped the lane "changed now" on every such
//   device, and that stamp beat what the others had done to it since (an agent let in elsewhere dropped, a removed one back).
//   A lane that is not a valid record (no normal form) is compared as it is.
const laneForm = (room, l) => { try { return normA2A({ lanes: { [room]: l } }).lanes[room] || l } catch { return l } }

/** What changed on this device since `prev` (the last merged view), stamped `now`. `cur` = { conns: [rec], siri: state, a2a: { lanes } }. */
export function stampKeep (prev, cur, now = Date.now()) {
  const p = normKeep(prev), out = { v: 1, conns: { ...p.conns }, a2a: { ...p.a2a }, siri: p.siri }
  const stampMap = (map, entries, field, form = (id, v) => v) => {
    const seen = new Set()
    for (const [id, val] of entries) {
      seen.add(id)
      const was = map[id]
      if (!was || was.gone || canon(form(id, was[field])) !== canon(form(id, val))) map[id] = { at: now, [field]: val }
    }
    // a lane's tombstone names its inbox (K#8): an inbox switched off is never switched on again by a copy of THAT inbox
    for (const [id, was] of Object.entries(map)) if (!seen.has(id) && !was.gone) map[id] = { at: now, gone: true, ...(field === 'lane' && was.lane && typeof was.lane.handle === 'string' ? { handle: was.lane.handle } : {}) }
  }
  stampMap(out.conns, ((cur && cur.conns) || []).filter((c) => c && c.id).map((c) => [String(c.id), c]), 'rec')
  stampMap(out.a2a, Object.entries((cur && cur.a2a && cur.a2a.lanes) || {}), 'lane', laneForm)
  // ⛔ an EMPTY Siri state on a device that never had one is "nothing yet", not a change: a fresh device would otherwise stamp its
  //   blank state newer than the account's and wipe Siri on every device. Once this device has held one, an empty one IS a change
  //   (Siri turned off everywhere — wb.siri.revoke()).
  const siri = cur && cur.siri ? cur.siri : null
  const blank = !siri || (!siri.token && !Object.keys(siri.rooms || {}).length)
  if (siri && !(blank && !p.siri) && (!p.siri || canon(p.siri.state) !== canon(siri))) {
    // WHAT WAS TAKEN OFF IS RECORDED (state machines pass 9, K#8): the entry merges Space by Space, so a Space this device had
    // and no longer has is marked `gone`; a blank state (Delete Siri setup) marks every Space and bumps `rev` — the old key
    // and its Spaces never come back from a copy made before the delete.
    const was = (p.siri && p.siri.state && p.siri.state.rooms) || {}
    const off = Object.fromEntries(Object.keys(was).filter((r) => !(siri.rooms || {})[r]).map((r) => [r, Math.max(now, num(Number(was[r] && was[r].at)) + 1)]))
    const gone = unionMarks(p.siri && p.siri.gone, off), rev = num(Number(p.siri && p.siri.rev)) + (blank && p.siri ? 1 : 0)
    out.siri = { at: now, state: siri, ...(Object.keys(gone).length ? { gone } : {}), ...(rev ? { rev } : {}) }
  }
  return out
}

// per entry: last writer wins, a tie goes to the tombstone, past 300 tombstones the oldest go (keptMerge.js newerEntry / mergeEntries)
// ⛔ A LANE AND SIRI MERGE BY THEIR PARTS (state machines pass 9, K#8): their unit was the WHOLE lane and the WHOLE Siri state,
//   last writer wins — two devices that changed one lane inside one interval: the later stamp won, an agent removed on one came
//   back from the other (and the next push granted it again), an agent let in on one was dropped (and revoked); Siri the same
//   per Space. Now:
//   · two copies of ONE inbox (same handle) are one lane — the newer's name and rules, the agents of both by id, and an agent
//     either copy REMOVED (`removed`, a2aCore.js removePeerIn) never comes back: a2aCore.js mergeA2ARecords' rules;
//   · a lane's tombstone names its inbox, and wins over any copy of that inbox whatever the clocks say (a handle is never
//     reused — switching on again mints a new one);
//   · Siri: the Spaces of both, less those a copy took off after they were made (`gone`); the copy with the higher `rev` (a
//     Delete Siri setup) decides the key, and a copy made before that delete brings back none of its Spaces.
//   (C3, the app's rule adopted: of the Spaces left, a Space whose newer copy is from before its `gone` mark is the other copy's
//   when that one was made after the mark — a Space switched on again was lost; and a tie in `rev` keeps a key either copy has.)
function laneEntry (x, y) {
  if (!x || !y) return x || y
  if (!x.gone && !y.gone && x.lane && y.lane && x.lane.handle === y.lane.handle) {
    const base = newer(x, y), other = base === x ? y : x
    return { at: Math.max(num(x.at), num(y.at)), lane: mergePeers(base.lane, other.lane) }
  }
  const tomb = x.gone ? x : y.gone ? y : null, live = tomb === x ? y : x
  if (tomb && !live.gone && tomb.handle && live.lane && live.lane.handle === tomb.handle) return tomb
  return newer(x, y)
}
function siriEntry (x, y) {
  if (!x || !y) return x || y || null
  const base = newer(x, y), other = base === x ? y : x
  const rev = Math.max(num(Number(x.rev)), num(Number(y.rev))), gone = unionMarks(x.gone, y.gone)
  const atRev = [base, other].filter((e) => num(Number(e.rev)) === rev && e.state) // a copy from before a delete brings nothing back
  const roomsOf = (e) => (atRev.includes(e) ? e.state.rooms || {} : {})
  const rooms = mergeSiriRooms(roomsOf(base), roomsOf(other), gone) // the newer's copy of a Space while it outlives its mark
  const lead = atRev[0] ? atRev[0].state : { token: '', defaultRoom: '' }
  const keyOf = (e) => ({ token: e.state ? e.state.token : '', rev: e.rev })
  const def = siriDefaultOf(rooms, ...atRev.map((e) => e.state.defaultRoom))
  return { at: Math.max(num(x.at), num(y.at)), state: { ...lead, token: siriKeyOf(keyOf(base), keyOf(other)), defaultRoom: def, rooms }, ...(Object.keys(gone).length ? { gone } : {}), ...(rev ? { rev } : {}) }
}
/** The union of two views, the newer of each entry kept (a lane and Siri: merged by their parts). Pure — the whole agreement between devices is here. */
export function mergeKeep (a, b) {
  const x = normKeep(a), y = normKeep(b)
  return { v: 1, conns: mergeMap(x.conns, y.conns), a2a: mergeMap(x.a2a, y.a2a, laneEntry), siri: siriEntry(x.siri, y.siri) }
}

/** What the vault holds from a merged view: { conns: [rec], siri: state | null, a2a: { lanes } }. */
export function viewOfKeep (k) {
  const x = normKeep(k)
  return {
    conns: Object.values(x.conns).filter((e) => e && !e.gone && e.rec).map((e) => e.rec),
    siri: x.siri && x.siri.state ? x.siri.state : null,
    a2a: { lanes: Object.fromEntries(Object.entries(x.a2a).filter(([, e]) => e && !e.gone && e.lane).map(([room, e]) => [room, e.lane])) },
  }
}
export const sameKeep = (a, b) => canon(normKeep(a)) === canon(normKeep(b))

// ── THE SAME KEEP IN THE SPACES APP'S FORMAT (docs/sdk-account-format-plan.md phase 4; the owner, 2026-11-13: "yes. Do 1-5") ──
// Beside KEEP_DOC the account's index room holds the app's `xindex2` (index2Doc: `connections` + `connGone`, `siri`, `a2a`),
// sealed under the app's account-store key (loc.app — sdkAccount.js _where, as phase 3's `xindex`). A pass READS BOTH and writes
// BOTH: KEEP_DOC stays for every kit built from an older SDK (they read only it). TRANSLATE, DO NOT DROP: a keep entry's stamp is
// the app record's `at` (a connection's, a lane's, Siri's — an added field the app's normal forms ignore), a tombstone is the
// app's removal mark (`connGone[id]`, `a2a.gone[handle]`), Siri's `gone`/`rev` are the app's own. The rules stay keptMerge.js's:
// the app's mark rule (an entry is off when a mark is as new) is the keep's tie-goes-to-the-tombstone.
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
/** The app's `xindex2` (as read; none → empty) → { keep, laneGone }: a keep view, and the inboxes the doc says were switched off
 *  (`a2a.gone` is by handle, not by lane — applied by dropGoneLanes). A stub (`held`, no callKey) is not a key: left out. */
export function appToKeep (doc) {
  const d = obj(doc), conns = {}, a2a = {}
  for (const [id, c] of Object.entries(obj(d.connections))) {
    if (!c || typeof c.callKey !== 'string' || !c.callKey) continue
    const { at, held: _h, ...rec } = c
    conns[id] = { at: num(Number(at)), rec: { id, ...rec } }
  }
  for (const [id, at] of Object.entries(obj(d.connGone))) if (num(Number(at))) conns[id] = newer(conns[id], { at: Number(at), gone: true })
  for (const [room, l] of Object.entries(obj(obj(d.a2a).lanes))) { if (!l || typeof l !== 'object') continue; const { at, ...lane } = l; a2a[room] = { at: num(Number(at)), lane } }
  const s = obj(d.siri), { at: sAt, gone, rev, ...st } = s
  const marks = unionMarks(gone, null), r = num(Number(rev))
  const siri = (st.token || Object.keys(obj(st.rooms)).length || Object.keys(marks).length || r)
    ? { at: num(Number(sAt)), state: { token: typeof st.token === 'string' ? st.token : '', defaultRoom: typeof st.defaultRoom === 'string' ? st.defaultRoom : '', rooms: obj(st.rooms) }, ...(Object.keys(marks).length ? { gone: marks } : {}), ...(r ? { rev: r } : {}) }
    : null
  return { keep: { v: 1, conns, a2a, siri }, laneGone: unionMarks(obj(d.a2a).gone, null) }
}
/** A lane whose inbox a mark switched off becomes its tombstone (laneEntry's rule: it wins over any copy of that inbox). */
export function dropGoneLanes (keep, laneGone) {
  const k = normKeep(keep), a2a = { ...k.a2a }
  for (const [room, e] of Object.entries(a2a)) {
    const h = e && !e.gone && e.lane && e.lane.handle
    if (h && laneGone && laneGone[h]) a2a[room] = { at: Math.max(num(e.at), num(Number(laneGone[h]))), gone: true, handle: h }
  }
  return { ...k, a2a }
}
/** A merged keep → the app's `xindex2`. `prev` = the doc as read: its marks are kept (a mark only it had stays), and the sections
 *  a vault does not keep (contacts, events, todos, code) are carried as they were. */
export function keepToApp (keep, prev = null) {
  const k = normKeep(keep), p = obj(prev), connections = {}, gone = {}, lanes = {}, laneGone = {}
  for (const [id, e] of Object.entries(k.conns)) {
    if (e && e.gone) gone[id] = num(e.at) || 1
    else if (e && e.rec) { const { id: _id, ...rec } = e.rec; connections[id] = { ...rec, at: num(e.at) } }
  }
  for (const [room, e] of Object.entries(k.a2a)) {
    if (e && e.gone) { if (typeof e.handle === 'string' && e.handle) laneGone[e.handle] = num(e.at) || 1 } else if (e && e.lane) lanes[room] = { ...e.lane, at: num(e.at) }
  }
  const connGone = unionMarks(obj(p.connGone), gone, MAX_TOMBS), aGone = unionMarks(obj(obj(p.a2a).gone), laneGone, MAX_TOMBS)
  for (const [id, at] of Object.entries(connGone)) if (connections[id] && num(connections[id].at) <= at) delete connections[id] // the app's rule: a mark as new takes it off
  const s = k.siri
  const siri = s && s.state ? { ...s.state, ...(s.gone ? { gone: s.gone } : {}), ...(s.rev ? { rev: s.rev } : {}), at: num(s.at) } : { token: '', defaultRoom: '', rooms: {} }
  const keepOr = (x, d) => (x === undefined ? d : x)
  return index2Doc({ contacts: keepOr(p.contacts, []), events: keepOr(p.events, []), todos: keepOr(p.todos, []), code: keepOr(p.code, null), connections, connGone: Object.keys(connGone).length ? connGone : undefined, siri, a2a: { lanes, ...(Object.keys(aGone).length ? { gone: aGone } : {}) } })
}
/** The same doc, its write time aside. An unknown doc is never the same. */
const sameAppDoc = (a, b) => !!(a && b) && canon({ ...a, at: 0 }) === canon({ ...b, at: 0 })

/** One sync pass: stamp → read → merge → write if it moved (conditional) → the merged view.
 *  deps: { loc: { room, mk, master }, client (spaceClient: state(room, mk, name, patch?, summary?, by?, ifV?)), prev, cur, now? }
 *  → { ok: true, keep, own } | { ok: false, why, keep, own } (nothing written on a read that was not definitive).
 *  `keep` = the merged view as far as the pass got (it may hold the OTHER devices' entries, saved or not); `own` = this device's
 *  own view, stamped: `prev` + what changed here, never an entry `prev` and `cur` did not have. A caller that keeps a `prev`
 *  uses keepPass (below), which says which of the two it may record. */
export async function syncKeep ({ loc, client, prev, cur, now = Date.now }) {
  const key = await keepKeyOf(loc.master)
  const own = stampKeep(prev, cur, now())
  let local = own
  for (let i = 0; i < 4; i++) {
    let r
    try { r = await client.state(loc.room, loc.mk, KEEP_DOC) } catch (e) { return { ok: false, why: 'unreadable', keep: local, own } }
    if (!r || r.status !== 200) return { ok: false, why: 'unreadable', status: r && r.status, keep: local, own }
    const v = Number.isInteger(r.v) ? r.v : 0
    let remote = null
    const st = r.state
    if (!(st == null || (typeof st === 'object' && !Object.keys(st).length))) { try { remote = normKeep(await openDoc(key, st)) } catch { return { ok: false, why: 'unopenable', keep: local, own } } }
    // READ-THROUGH (phase 4): with the app's key (loc.app), the app's `xindex2` is read too — the same clobber rule: unknown is not empty
    let x = null
    if (loc.app) {
      let rx
      try { rx = await client.state(loc.room, loc.mk, APP_KEEP_DOC) } catch { return { ok: false, why: 'unreadable', keep: local, own } }
      if (!rx || rx.status !== 200) return { ok: false, why: 'unreadable', status: rx && rx.status, keep: local, own }
      const sx = rx.state
      x = { doc: null, v: Number.isInteger(rx.v) ? rx.v : 0 }
      if (!(sx == null || (typeof sx === 'object' && !Object.keys(sx).length))) { try { x.doc = await openDoc(loc.app, sx) } catch { return { ok: false, why: 'unopenable', keep: local, own } } }
    }
    const fromApp = x ? appToKeep(x.doc) : null
    const merged = fromApp ? dropGoneLanes(mergeKeep(mergeKeep(local, remote), fromApp.keep), fromApp.laneGone) : mergeKeep(local, remote)
    // DUAL WRITE: the keep's own doc for every older kit, then the app's; each only when it differs from what it holds, each over
    // the version read. A 409 on either reads both and merges again; a failed save on either is a pass that did not save.
    const appDoc = x ? keepToApp(merged, x.doc) : null
    const writes = [[!(remote && sameKeep(merged, remote)), KEEP_DOC, key, merged, v, 'vault keep'], [!!x && !sameAppDoc(appDoc, x.doc), APP_KEEP_DOC, loc.app, appDoc && { ...appDoc, at: now() }, x && x.v, 'index2']]
    let raced = false
    for (const [differs, name, k, body, ver, sum] of writes) {
      if (!differs) continue
      const w = await client.state(loc.room, loc.mk, name, await sealDoc(k, body), sum, 'device', ver).catch(() => null)
      if (w && w.status === 409) { raced = true; break } // another device wrote between: read and merge again
      if (!w || w.status !== 200) return { ok: false, why: 'save_failed', status: w && w.status, keep: merged, own }
    }
    if (raced) { local = merged; continue }
    return { ok: true, keep: merged, own }
  }
  return { ok: false, why: 'kept_changing', keep: local, own }
}

/** THE STORES ARE THE STORAGE'S, AND EVERY TAB OF A VAULT SHARES IT (state machines pass 9, K#1). A builder's app open in two
 *  tabs is two vault frames: each loaded connections, Siri and the lanes into memory ONCE, while `prev` is read from the
 *  shared storage at every pass. What tab A attached was in A's `prev`; tab B's pass compared it with ITS memory, read it as
 *  "removed here" and stamped it gone for every device — flapping each minute, and the callKey (or an inbox's private key)
 *  left the disk when B applied. A watch over the stores' keys: `moved()` → the keys ANOTHER writer changed since this tab
 *  last looked (each reported once); `wrote(key)` after this tab's own write. The vault re-reads a moved store before any
 *  look at it (vault-core.js adoptOtherTab), so a pass never mistakes another tab's change for this device's. */
export function tabStores (st, keys) {
  const raw = (k) => { try { return st.getItem(k) } catch { return null } }
  const seen = new Map(keys.map((k) => [k, raw(k)]))
  return {
    wrote (k) { seen.set(k, raw(k)) },
    moved () { const out = []; for (const k of keys) { const now = raw(k); if (now !== seen.get(k)) { seen.set(k, now); out.push(k) } } return out },
  }
}

// What a vault holds, in one comparable shape: the connections by id (their order is not a change), Siri, the lanes.
const heldOf = (c) => ({
  conns: Object.fromEntries(((c && c.conns) || []).filter((x) => x && x.id).map((x) => [String(x.id), x])),
  siri: (c && c.siri) || null,
  a2a: (c && c.a2a && c.a2a.lanes) || {},
})
const sameHeld = (a, b) => canon(heldOf(a)) === canon(heldOf(b))

/** A VAULT'S WHOLE PASS: the sync, and what the vault may do with its answer. vault-core.js keepSync runs this.
 *  ⛔ `prev` MEANS "WHAT THIS DEVICE HOLDS": stampKeep reads an entry that `prev` has and the device lacks as REMOVED HERE, and
 *  stamps it gone for every device. So a merged view — it carries the other devices' entries — becomes `prev` only when it is
 *  also PUT INTO the vault. Two ways that was broken (sync sweep 2026-11-12):
 *   #1  a pass that did not save (save_failed, kept_changing, a read that failed after a lost race) was recorded but not applied:
 *       the next pass stamped every other device's connection, Siri and outside agent gone — deleted on EVERY device of the account;
 *   #2  the merged view is made from the state read BEFORE the round trip, and applying it replaces the vault's stores: a
 *       connection attached meanwhile was dropped (its callKey with it), a detach made meanwhile was undone.
 *  The rule: the merged view is recorded and applied only by a pass that SAVED and during which the vault did NOT change.
 *  Any other pass records this device's own stamped view (`own` — what changed here keeps the time it was first seen) and
 *  applies nothing; a vault that changed meanwhile is synced again (`again`).
 *  deps: syncKeep's, with `read()` → { conns, siri, a2a } (the vault's stores NOW) in place of `cur`, and `settle(answer)`:
 *  where the vault records and applies. It runs in the SAME synchronous step as the "did the vault change?" check, so nothing
 *  can be attached or detached between the check and the apply.
 *  → syncKeep's answer + { record: the view to keep as `prev`, apply: the merged view to put into the stores | null, again } */
export async function keepPass ({ loc, client, prev, read, now = Date.now, settle }) {
  const cur = JSON.parse(JSON.stringify(read() || {})) // a copy: what the pass is given must not move under it
  const r = await syncKeep({ loc, client, prev, cur, now })
  // ── no await from here to the end of `settle` ──
  const moved = !sameHeld(cur, read())
  const out = { ...r, ...settleOf({ ok: r.ok, moved, keep: r.keep, own: r.own, prev, same: sameKeep }) }
  if (typeof settle === 'function') settle(out)
  return out
}
