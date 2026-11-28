import { ROOM_DEFAULTS_DOC, mergeRoomDefaults } from './roomDefaultPrefs.js'
// accountStores.js — the Spaces app's account sync documents, SEALED on the device (docs/sdk-convergence.md § The account
// stores). ⛔ Found 2026-10-05: the index doc carried every room key — a confidential room's included — as JSON the
// standard tier read on every sync (spaces/test/indexCarriesKeys.test.mjs). Now each doc is written sealed (accountSeal.js)
// under its own name ('x' + name: an app that has not updated yet keeps writing the plain one and never overwrites this),
// and the plain one is emptied once this device has written the sealed copy.
//
// READ-THROUGH: read the sealed doc; with none yet, the plain one (a device's first sync after the update). A plain doc that
// an older app wrote AFTER the move still counts: its entries the sealed doc lacks are merged in (and sealed on the next
// write), so no room is lost to the overlap. A sealed doc that will not open is NOT a definitive read: status 0, so the
// caller writes nothing (the index-clobber rule).
// ⛔ NO KEY, NO WRITE: without the account key (no backup master on this device) nothing is written — never plaintext again.
//
// `call(room, mk, name, patch?, summary?, by?)` is the transport (spaceClient.state); `key()` answers the CryptoKey or null.
import { sealDoc, openDoc, isSealedDoc } from './accountSeal.js'

export const SEALED = (name) => 'x' + name
export const MOVED = 'sealed' // the plain doc's marker once its content lives in the sealed one
// the maps (or { room } lists) whose entries a late plain write can add (index: rooms; pipes: pipes; temp index: rooms)
const MAPS = ['rooms', 'pipes']
// The paired-computers list (codeComputers.js): the COMPUTER writes it too (tools/opencode-pair.mjs, witbitz_code/account.py)
// and it holds no account key, so it only ever reads and writes the PLAIN doc. That doc is never emptied here, every read
// folds its entries in, and both directions merge by the list's own rule — never "this write wins" (the owner, 2026-10-08:
// an uninstall found the plain doc emptied, removed nothing, and the sealed copy kept the computer listed;
// spaces/test/computersFromTheComputer.test.mjs).
const REGISTRIES = { computers: 'computers' } // doc name → its map

/** Two entry maps of the computers list → one: per entry the higher `mod` wins, a tie goes to the removal. Held equal to
 *  codeComputers.mergeRegistry by test (that module is not in the worker's bundle). */
export function mergeRegistryMap (a, b) {
  const out = Object.create(null)
  const mod = (e) => (e && typeof e === 'object' && typeof e.mod === 'number' && Number.isFinite(e.mod) && e.mod > 0 ? e.mod : 0)
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue
    for (const id of Object.keys(src)) {
      const e = src[id], cur = out[id]
      if (!mod(e)) continue
      if (!cur || mod(e) > mod(cur) || (mod(e) === mod(cur) && e.removed && !cur.removed)) out[id] = e
    }
  }
  return out
}

// What a write carries over from the doc it replaces: for each OBJECT map (rooms, pipes) the entries it lacks — removals
// there are tombstones ({ deleted } / { removed }), never omission, so an absent entry is one this device has not seen yet.
// This write wins on an entry both hold. Not carried: a temp room in the synced index (`tmp-…`, purged on purpose — they
// live in the temp index) and ARRAY lists (the temp index removes by omission; it gets the version check only).
export function carryMissing (mine, cur, name = '') {
  if (!cur || typeof cur !== 'object' || !mine || typeof mine !== 'object') return mine
  const out = { ...mine }
  if (name === 'kept-agent-links') {
    const links = { ...(cur.links || {}) }
    for (const [id, link] of Object.entries(mine.links || {})) if (!links[id] || link.at > links[id].at || (link.at === links[id].at && link.gone)) links[id] = link
    return { ...out, links }
  }
  if (name === ROOM_DEFAULTS_DOC) return mergeRoomDefaults(mine, cur) || mine
  // Usage receipts are immutable, keyed by receipt id. A successful read-back lets a device advance its cursor;
  // a later stale writer must therefore carry the other device's receipts too, including after a CAS retry.
  if (/^usage-\d{4}-(0[1-9]|1[0-2])$/.test(name)) {
    const rows = (r) => r && typeof r === 'object' && !Array.isArray(r) ? r : {}
    return { ...out, r: { ...rows(cur.r), ...rows(mine.r) } }
  }
  const reg = REGISTRIES[name]
  if (reg) { out[reg] = mergeRegistryMap(cur[reg], mine[reg]); return out } // the computers list: by its own rule, entry by entry
  for (const m of MAPS) {
    const c = cur[m]
    if (!c || typeof c !== 'object' || Array.isArray(c) || Array.isArray(mine[m])) continue
    const have = mine[m] && typeof mine[m] === 'object' ? mine[m] : {}
    const add = {}
    for (const id of Object.keys(c)) if (!(id in have) && !(m === 'rooms' && id.startsWith('tmp-'))) add[id] = c[id]
    if (Object.keys(add).length) out[m] = { ...add, ...have }
  }
  return out
}

export function makeAccountStore ({ call, key, oldKeys = async () => [] }) {
  // A NEW ACCOUNT KEY (account recovery v2: starting on the new service and every new recovery code make a new master;
  // the owner's iPhone, 2026-11-15): documents sealed under a PREVIOUS master open with `oldKeys` (the device that changed
  // it keeps them: vault prevMasters, ≤ 3, 30 days) — a read writes the document back under the current key at once, so a
  // device that holds only the new key (restored from the new backup) can read it; a write merges it as usual.
  const openAny = async (k, sealed) => {
    try { return { st: await openDoc(k, sealed), old: false } } catch { /* a previous key? */ }
    let olds = []
    try { olds = (await oldKeys()) || [] } catch { olds = [] }
    for (const ok of olds) { try { return { st: await openDoc(ok, sealed), old: true } } catch { /* the next one */ } }
    return null
  }
  const cleared = new Set() // room|name whose plain doc this page already emptied (or found emptied)
  const read = async (room, mk, name) => { try { return await call(room, mk, name) } catch { return { status: 0 } } }
  // A computer removed here leaves the plain doc too, so its relay secret is not kept there — only TOMBSTONES are written
  // (nothing this device holds that the plain doc lacks), over the version just read; a miss waits for the next write.
  const removalsToPlain = async (room, mk, name, reg, body) => {
    try {
      const pr = await read(room, mk, name)
      const cur = pr && pr.status === 200 && pr.state && typeof pr.state === 'object' && !pr.state.z ? pr.state : null
      const map = cur && cur[reg] && typeof cur[reg] === 'object' ? cur[reg] : null
      if (!map) return
      const gone = {}
      for (const [id, e] of Object.entries((body && body[reg]) || {})) if (e && e.removed && map[id] && !map[id].removed && mergeRegistryMap({ [id]: map[id] }, { [id]: e })[id] === e) gone[id] = e
      if (Object.keys(gone).length) await call(room, mk, name, { ...cur, [reg]: { ...map, ...gone } }, 'computer removed', '', Number.isInteger(pr.v) ? pr.v : 0)
    } catch { /* the next write tries again */ }
  }
  return {
    /** → { status, state, sealed: bool, v? } — status 200 only for a DEFINITIVE read. `v`: the sealed doc's version, for a
     *  write that must not land over a change it never merged (put's `ifV`). */
    async get (room, mk, name, { plainOpen = (s) => s } = {}) {
      const k = await key()
      const plainR = await read(room, mk, name)
      const plain = plainR && plainR.status === 200 && plainR.state && typeof plainR.state === 'object' ? await plainOpen(plainR.state) : null
      if (plain && plain.moved === MOVED) cleared.add(room + '|' + name)
      if (!k) return { status: plainR ? plainR.status : 0, state: plain && plain.moved !== MOVED ? plain : null, sealed: false }
      const sr = await read(room, mk, SEALED(name))
      if (!(sr && sr.status === 200)) return { status: (sr && sr.status) || 0, state: null, sealed: false }
      if (!isSealedDoc(sr.state)) return { status: plainR ? plainR.status : 0, state: plain && plain.moved !== MOVED ? plain : null, sealed: false } // not moved yet → the plain doc
      const opened = await openAny(k, sr.state)
      if (!opened) return { status: 0, state: null, sealed: true, unopenable: true }
      let st = opened.st
      let v = Number.isInteger(sr.v) ? { v: sr.v } : {}
      if (opened.old) { // under a previous key: write it back under this one (over the version just read; a race → the next read)
        try { const w = await call(room, mk, SEALED(name), await sealDoc(k, st), 'sealed under the new account key', '', Number.isInteger(sr.v) ? sr.v : 0); if (w && w.status === 200) v = {} } catch { /* the next read heals it */ }
      }
      const reg = REGISTRIES[name]
      if (reg) return { status: 200, state: plain && plain.moved !== MOVED ? { ...st, [reg]: mergeRegistryMap(st[reg], plain[reg]) } : st, sealed: true, ...v } // the computer's own writes
      if (plain && plain.moved !== MOVED) { // an older app wrote the plain doc after the move: take what the sealed one lacks
        st = { ...st }
        for (const m of MAPS) {
          if (Array.isArray(plain[m])) { // a list of { room } entries (the temp-room index): the sealed one's win, the plain one adds what it lacks
            const have = new Set((Array.isArray(st[m]) ? st[m] : []).map((e) => e && e.room))
            st[m] = [...(Array.isArray(st[m]) ? st[m] : []), ...plain[m].filter((e) => e && e.room && !have.has(e.room))]
          } else if (plain[m] && typeof plain[m] === 'object') st[m] = { ...plain[m], ...(st[m] || {}) }
        }
        cleared.delete(room + '|' + name)
      }
      return { status: 200, state: st, sealed: true, ...v }
    },
    /** Write sealed; then empty the plain doc (once). → { status } — 0 + error 'no_account_key' without the key.
     *  ⛔ TWO DEVICES MUST NOT OVERWRITE EACH OTHER (a reviewer's finding, 2026-10-05): re-read the CURRENT sealed doc,
     *  carry over the map entries this write lacks (carryMissing — rooms/pipes are tombstoned, never dropped by
     *  omission), and write only if the doc has not moved since that read (ifV → 409 → again). A current doc that cannot
     *  be read or opened is NOT written over. spaces/test/accountStoresConcurrent.test.mjs.
     *  ⛔ `ifV` — THE VERSION THE CALLER MERGED (2026-11-07, the implicit-state-machine review): the re-read above carries over
     *  only the room/pipe maps; a list (contacts, events, to-dos), the device registry or the read positions written by
     *  another device between the CALLER's read and this one was replaced. With `ifV` the write lands only over that version:
     *  anything else answers 409 { error: 'moved' } and the caller reads and merges again. Without it: as before. */
    async put (room, mk, name, obj, summary, by, { ifV } = {}) {
      const pinned = Number.isInteger(ifV)
      const k = await key()
      if (!k) return { status: 0, error: 'no_account_key' }
      for (let i = 0; i < 5; i++) {
        const sr = await read(room, mk, SEALED(name))
        if (!(sr && sr.status === 200)) return { status: (sr && sr.status) || 0, error: 'unread' } // unknown is not empty
        if (pinned && isSealedDoc(sr.state) && sr.v !== ifV) return { status: 409, error: 'moved' } // written since the caller's read
        let body = obj
        if (isSealedDoc(sr.state)) {
          const opened = await openAny(k, sr.state) // a previous key's document is merged and written under this one
          if (!opened) return { status: 0, error: 'unopenable' }
          body = carryMissing(obj, opened.st, name)
        }
        const r = await call(room, mk, SEALED(name), await sealDoc(k, body), summary, by, Number.isInteger(sr.v) ? sr.v : 0)
        const status = (r && r.status) || 0
        if (status === 409 && pinned) return { status: 409, error: 'moved' }
        if (status === 409) { await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 80) * (i + 1))); continue } // another device wrote first: re-read, re-merge
        if (status === 200 && REGISTRIES[name]) await removalsToPlain(room, mk, name, REGISTRIES[name], body)
        if (status === 200 && !REGISTRIES[name] && !cleared.has(room + '|' + name)) { // the computers list's plain doc is the computer's channel: never emptied
          let w = null; try { w = await call(room, mk, name, { v: 2, moved: MOVED }, summary, by) } catch { /* emptied on a later write */ }
          if (w && w.status === 200) cleared.add(room + '|' + name)
        }
        return { status }
      }
      return { status: 409, error: 'busy' }
    },
  }
}
