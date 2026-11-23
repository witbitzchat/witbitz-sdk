// spaces/public/idb.js — tiny IndexedDB key/value wrapper (single 'kv' store in the 'spaces' DB).
// Shared LEAF: the SW-visible mk mirror, the chat-ledger cache, and blob (image/PDF) caching all use it.
// Zero deps besides deviceSeal (through idbSeal.js) — only the indexedDB global otherwise.
//
// §PROTECT (docs/device-storage-protection.md, slice 3): the content caches (`chat:`, `wstate:`, `blob:`, `code:`) go
// through idbSeal.js — with device storage protection on they are sealed on write and opened on read; while the device is
// locked a protected key reads as absent and a write is dropped. Every other key, and every call while protection is off,
// is exactly what it was. `getRaw/setRaw/entriesRaw` bypass the layer for the migration itself.
import { wrapForStore, unwrapFromStore, migrateIdbProtection, unprotectIdb, idbNamingState, IDB_SHARED_NAMES } from './idbSeal.js'
import { seal, open as openSealed } from './deviceSeal.js'
import { isOpaqueName } from './sealedNames.js'

// §NAMES (docs/desktop-protection.md, phase 2): the naming state lives in idbSeal.js (set from the device key there and in the
// key worker); every get/set/del/entries below asks it.
const isNamed = (k) => { const n = idbNamingState(); return n.on && !IDB_SHARED_NAMES.includes(String(k)) && !isOpaqueName(String(k)) && !String(k).startsWith('nk:') } // nk: keeps its name: the worker writes it CLEAR (setRaw) only when previews are opted in, sealed under an opaque name otherwise
// ★ NO INDEXEDDB (the owner, 2026-10-12: an iPhone in Lockdown Mode — since iOS 17 it switches IndexedDB OFF, and an
//   installed web app cannot be exempted): every write here was dropped and every read was empty, so the chat cache and
//   Help's search copy held nothing ("0 messages from 0 of 152 Spaces") while the app itself worked from the network. With
//   no IndexedDB the same store lives in this page's MEMORY for the session — kept as a copy (structuredClone), as
//   IndexedDB keeps one — and is gone at the next launch, which is what Lockdown Mode asks for anyway.
export const idbMemory = { on: false }
export const idb = (() => {
  let dbp, mem = null
  const memory = () => { if (!mem) { mem = new Map(); idbMemory.on = true } return mem }
  const copy = (v) => (v == null ? v : typeof structuredClone === 'function' ? structuredClone(v) : v)
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { rej(Object.assign(new Error('no IndexedDB'), { noIdb: true })); return }
    let r
    try { r = indexedDB.open('spaces', 1) } catch (e) { rej(Object.assign(e instanceof Error ? e : new Error(String(e)), { noIdb: true })); return }
    r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(Object.assign(r.error || new Error('open failed'), { noIdb: true }))
  }))
  // `fn` on IndexedDB, or `onMem(map)` when there is none (it never opened — a failed TRANSACTION stays a failure, as before)
  const tx = (mode, fn, onMem) => open().then((db) => new Promise((res, rej) => { const t = db.transaction('kv', mode), rq = fn(t.objectStore('kv')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error) }),
    (e) => { if (e && e.noIdb && onMem) return onMem(memory()); throw e })
  const inRange = (k, pfx) => !pfx || String(k).startsWith(pfx)
  // §APP STORE (appStore.js; docs/hosted-app-design.md §6): in the hosted app every raw call below is the VAULT's — its store
  // under this app's address — and this frame keeps no database of its own. Set by the page's loader before the app runs.
  const vault = () => (typeof globalThis !== 'undefined' && typeof globalThis.__wbAppIdb === 'function' ? globalThis.__wbAppIdb : null)
  const getRaw = (k) => (vault() ? vault()('get', k).then((v) => (v === undefined ? null : v)) : tx('readonly', (s) => s.get(k), (m) => copy(m.get(k)))).catch(() => null)
  const setRaw = (k, v) => (vault() ? vault()('set', k, v) : tx('readwrite', (s) => s.put(v, k), (m) => { m.set(k, copy(v)) })).catch(() => {})
  // ★★ A PREFIX READ LOADS ONLY THAT PREFIX (2026-10-06). Every key here is a string, so the keys under `pfx` are exactly the
  //    range [pfx, pfx + '\uffff'): IndexedDB answers it from the index without touching another prefix's VALUES. This used to be
  //    getAllKeys() + getAll() over the WHOLE store and a filter in JS — so the worker's `mk:` map at boot, its unseal/relock
  //    scans (three prefixes, on every unlock, i.e. on every load of a protected device) and the Code frame's session list each
  //    pulled every cached room's chat, widget state and attachment bytes into memory to keep a few hundred bytes of keys. On
  //    the owner's iPhone (204 rooms) that was the page's process being killed and restored moments after a Code open — the
  //    `back_forward` loads with no `leave` before them (docs/device-storage-protection.md § Memory).
  const range = (pfx) => (pfx ? IDBKeyRange.bound(pfx, pfx + '\uffff', false, true) : undefined)
  const entriesRaw = (pfx) => vault() ? vault()('entries', pfx || '').then((es) => (es || []).map(([k, v]) => [String(k), v])).catch(() => []) : open().then((db) => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readonly'), s = t.objectStore('kv'), ks = s.getAllKeys(range(pfx)), vs = s.getAll(range(pfx))
    t.oncomplete = () => { const keys = ks.result || [], vals = vs.result || [], out = []; for (let i = 0; i < keys.length; i++) if (String(keys[i]).startsWith(pfx)) out.push([String(keys[i]), vals[i]]); res(out) }
    t.onerror = () => rej(t.error)
  }), (e) => { if (e && e.noIdb) return [...memory()].filter(([k]) => inRange(k, pfx)).map(([k, v]) => [String(k), copy(v)]); throw e }).catch(() => [])
  // Keys only — a scan over a prefix that never loads the values (the protection migration walks the content ONE entry at a
  // time with it: a getAll() of the values holds every cached room in memory at once, and that killed the page on an iPhone).
  const keysRaw = (pfx) => (vault() ? vault()('keys', pfx || '') : tx('readonly', (s) => s.getAllKeys(range(pfx)), (m) => [...m.keys()])).then((ks) => (ks || []).map(String).filter((k) => k.startsWith(pfx))).catch(() => [])
  const delRaw = (k) => (vault() ? vault()('del', k) : tx('readwrite', (s) => s.delete(k), (m) => { m.delete(k) })).catch(() => {})
  const delPrefixRaw = (pfx) => (vault() ? vault()('delPrefix', pfx || '') : tx('readwrite', (s) => { const rq = s.getAllKeys(range(pfx)); rq.onsuccess = () => { for (const k of (rq.result || [])) if (String(k).startsWith(pfx)) s.delete(k) } },
    (m) => { for (const k of [...m.keys()]) if (String(k).startsWith(pfx)) m.delete(k) })).catch(() => {})
  // §NAMES: the real names behind every opaque key (keys only — no value is read), [opaque, real] pairs.
  const nameIndex = async () => { const nm = idbNamingState().namer; if (!nm) return []; const out = []; for (const o of await keysRaw('p:')) { const n = await nm.real(o); if (n != null) out.push([o, n]) } return out }
  // a value not yet moved under its opaque name (an unlock's migration runs in the background) still answers from its real name
  const legacyGet = (k) => getRaw(k).then((v) => (v == null ? v : unwrapFromStore(k, v)))
  const self = {
    get: (k) => (!isNamed(k) ? legacyGet(k) : !idbNamingState().namer ? Promise.resolve(null)
      : (async () => { const v = await getRaw(await idbNamingState().namer.opaque(k)); return v != null ? openSealed(idbNamingState().key, v) : legacyGet(k) })()).catch(() => null),
    set: (k, v) => (!isNamed(k) ? wrapForStore(k, v).then((stored) => (stored === undefined ? undefined : setRaw(k, stored)))
      : !idbNamingState().namer ? Promise.resolve(undefined) // locked or memory-only: dropped, never a write under a real name
        : (async () => { const nm = idbNamingState().namer, key = idbNamingState().key; const o = await nm.opaque(k); const stored = await seal(key, v); await setRaw(o, stored); await delRaw(k) })()).catch(() => {}),
    del: (k) => (!isNamed(k) || !idbNamingState().namer ? delRaw(k) : idbNamingState().namer.opaque(k).then((o) => Promise.all([delRaw(o), delRaw(k)]))).catch(() => {}),
    delPrefix: (pfx) => (!idbNamingState().on || !idbNamingState().namer ? delPrefixRaw(pfx)
      : nameIndex().then((ix) => Promise.all([...ix.filter(([, n]) => n.startsWith(pfx)).map(([o]) => delRaw(o)), delPrefixRaw(pfx)]))).catch(() => {}),
    // All [key, value] pairs whose key starts with pfx. Used by the L1 worker to load its room→mk map.
    entries: (pfx) => (async () => {
      const legacy = await entriesRaw(pfx).then((es) => Promise.all(es.map(async ([k, v]) => [k, await unwrapFromStore(k, v)])))
      if (!idbNamingState().on || pfx.startsWith('nk:') || IDB_SHARED_NAMES.some((n) => n.startsWith(pfx) || pfx.startsWith(n))) return legacy
      if (!idbNamingState().namer) return [] // locked: nothing readable
      const key = idbNamingState().key, seen = new Set(), out = []
      for (const [o, n] of await nameIndex()) { if (!n.startsWith(pfx)) continue; const v = await getRaw(o); if (v == null) continue; try { out.push([n, await openSealed(key, v)]); seen.add(n) } catch { /* another key's leftover */ } }
      for (const [k, v] of legacy) if (!seen.has(k)) out.push([k, v])
      return out
    })().catch(() => []),
    // §NAMES: the real names under a prefix, values never read (the protection migration and listings).
    names: (pfx) => (idbNamingState().on && idbNamingState().namer ? nameIndex().then(async (ix) => [...ix.map(([, n]) => n).filter((n) => n.startsWith(pfx)), ...await keysRaw(pfx)]) : keysRaw(pfx)).catch(() => []),
    getRaw, setRaw, delRaw, entriesRaw, keysRaw, nameIndex,
    // §PROTECT: switch on / unlock (seal the clear content in place) and switch off (write it back) — the lock hooks call these.
    protect: (rawKey) => migrateIdbProtection(self, rawKey),
    unprotect: (rawKey) => unprotectIdb(self, rawKey),
  }
  return self
})()
