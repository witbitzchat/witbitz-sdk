// vaultAtRest.js — what the BUILDERS' vault (vault-core.js) keeps on disk carries no room key in the clear
// (docs/sdk-vault-mode.md § At rest; the owner, 2026-11-13, decision 5 of docs/vault-core-convergence-review.md).
//
// The vault keeps, in its own origin's localStorage: the room list (`wbvault:rooms`, one invite link per Space — the link IS
// the key: `#mk=` or a split room's half `#us=`), and the account backup's state per account (`wbvault:backup` — its master
// opens every key, its rooms carry links and keys). Both were plain JSON. Here:
//   · a room entry keeps its link WITHOUT the key (`href`, the `mk=` / `us=` values emptied in place, every other mark kept) and
//     the key SEALED beside it (`ks`); the link is rebuilt, byte for byte, when it is loaded into the vault's memory;
//   · a backup state is sealed whole, per account; another account's entry is carried over as it is (another tab's write).
// Sealed under `key`, an AES-GCM CryptoKey (deviceSeal.js does the sealing): by default a NON-EXTRACTABLE key this vault makes
// once and keeps in its origin's IndexedDB (`deviceWrapKey`). That is the at-rest level the key worker's own IndexedDB has
// on an unprotected device — a copy of the localStorage alone, a sync of it, a search of it for `#mk=`, finds no key; a copy
// of the whole browser profile still does. Against that, the person's passkey lock (vaultProtect.js) is the answer.
//
// Read-through, never a destructive switch: an entry an older vault wrote (`link`, clear) is read as it is and written back
// sealed; an entry no key here opens is KEPT, keyless (the backup refills its link); with no key at all (no IndexedDB: an
// iPhone in Lockdown Mode, a private window that refuses it) the list is written as before — a key is never lost for want
// of a seal.
import { seal, open, isSealed } from './deviceSeal.js'

const SECRET = /([#&])(mk|us)=([^&]*)/g // the fragment params that ARE a key (or a split room's half of one)

/** `…#mk=K&gate=email` → { href: '…#mk=&gate=email', secret: { mk: 'K' } }; null when the link carries no key. */
export function splitLink (link) {
  if (typeof link !== 'string' || !link.includes('#')) return null
  const i = link.indexOf('#'), head = link.slice(0, i), frag = link.slice(i)
  const secret = {}
  const keyless = frag.replace(SECRET, (_, sep, name, v) => { if (v) secret[name] = v; return sep + name + '=' })
  return Object.keys(secret).length ? { href: head + keyless, secret } : null
}
/** The inverse of splitLink: each emptied key param gets its value back, in place. */
export function joinLink (href, secret) {
  return String(href).replace(/([#&])(mk|us)=(?=&|$)/g, (m, sep, name) => (secret && typeof secret[name] === 'string' ? sep + name + '=' + secret[name] : m))
}

/** The vault's own sealing key: a non-extractable AES-GCM key kept in this origin's IndexedDB, made once (the first of two
 *  tabs to make it wins: `add`, then read back). null when there is no IndexedDB to keep it in.
 *  ⛔ A READ THAT FAILED IS NOT "NO KEY" (sync sweep 2026-11-15 #3; our vault's 12a425b16, the owner's iPhone 11-14): iOS fails an
 *  IndexedDB open now and then. Every error answered null, the vault ran with no key, the sealed backup state read as "off", and
 *  turning backup on made a new master and code. Now a failed read is tried again, and one that keeps failing THROWS
 *  (code `device_key_unreadable`) — the caller asks the person, it never runs keyless over sealed data. */
const WRAP_RETRY_MS = [150, 400, 900]
export async function deviceWrapKey ({ idb = (typeof indexedDB !== 'undefined' ? indexedDB : null), name = 'wbvault-at-rest', wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!idb || !(globalThis.crypto && crypto.subtle)) return null
  let last = null
  for (let i = 0; i <= WRAP_RETRY_MS.length; i++) {
    if (i) await wait(WRAP_RETRY_MS[i - 1])
    try { return await wrapKeyOnce(idb, name) } catch (e) { last = e }
  }
  throw Object.assign(new Error('this vault\'s saved data could not be opened (' + String((last && (last.name || last.message)) || last || 'IndexedDB') .slice(0, 120) + ')'), { code: 'device_key_unreadable' })
}
async function wrapKeyOnce (idb, name) {
  let db = null
  try {
    db = await new Promise((res, rej) => { const r = idb.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const get = () => new Promise((res, rej) => { const q = db.transaction('k', 'readonly').objectStore('k').get('wrap'); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error) })
    let k = await get()
    if (!k) {
      const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await new Promise((res) => { const t = db.transaction('k', 'readwrite'); t.objectStore('k').add(made, 'wrap'); t.oncomplete = res; t.onabort = res; t.onerror = (e) => { try { e.preventDefault() } catch { /* */ } } })
      k = await get()
    }
    if (k && k.type === 'secret') return k
    throw Object.assign(new Error('no usable key in IndexedDB'), { name: 'NoKey' })
  } finally { try { db && db.close() } catch { /* */ } }
}

const read = (st, k) => { try { const v = st.getItem(k); return v ? JSON.parse(v) : null } catch { return null } }
const write = (st, k, v) => { try { if (v == null) st.removeItem(k); else st.setItem(k, JSON.stringify(v)) } catch { /* a full or blocked store: the vault still works this session */ } }
const isState = (x) => !!(x && typeof x === 'object' && !Array.isArray(x) && typeof x.master === 'string')

/** @param {{ storage: Storage, key: CryptoKey|null }} o */
/** Does this storage hold anything sealed — a room's key, an account's backup state? A vault with NO key (no IndexedDB this launch)
 *  must not run over it: it would read the backup as off (sync sweep 11-18; our vault asks there too). */
export function holdsSealed (storage, { rooms, backup } = {}) {
  const list = rooms ? read(storage, rooms) : null
  if (Array.isArray(list) && list.some((e) => e && isSealed(e.ks))) return true
  const b = backup ? read(storage, backup) : null
  return !!(b && typeof b === 'object' && !Array.isArray(b) && Object.values(b).some((v) => isSealed(v)))
}

export function createAtRest ({ storage, key }) {
  let chain = Promise.resolve()
  const onDisk = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p }
  const sealedOf = new Map() // room → { secret (JSON), ks } — an unchanged key is not sealed again on every save
  // ⛔ AN ENTRY THIS KEY CANNOT OPEN (another key's, or no key at all: IndexedDB failed at start) is carried over AS IT IS on every
  //   save — read as keyless and written as `rest`, the next save erased its sealed key for good (review, 2026-11-13).
  const unopened = new Map() // room → { href, ks }

  async function entryOut (r) {
    const { link, mk, ...rest } = r
    if (link === undefined && unopened.has(r.room)) { const u = unopened.get(r.room); return { ...rest, href: u.href, ks: u.ks } }
    const s = key ? splitLink(link) : null
    if (!s) return link === undefined ? rest : { ...rest, link } // no key here (or a keyless link): as before
    if (mk && s.secret.us) s.secret.whole = mk
    const sj = JSON.stringify(s.secret), had = sealedOf.get(r.room)
    const ks = had && had.secret === sj ? had.ks : await seal(key, s.secret)
    sealedOf.set(r.room, { secret: sj, ks })
    return { ...rest, href: s.href, ks }
  }
  async function entryIn (e) {
    if (!e || typeof e !== 'object' || typeof e.room !== 'string') return null
    const { href, ks, ...rest } = e
    if (!isSealed(ks)) return { ...rest } // an older vault's entry (`link` in it), or a keyless one
    let secret = null
    try { secret = key ? await open(key, ks) : null } catch { secret = null }
    if (!secret || typeof secret !== 'object') { unopened.set(e.room, { href, ks }); return { ...rest } } // sealed under a key this vault does not have: keyless in memory, kept as it is on disk
    unopened.delete(e.room)
    sealedOf.set(e.room, { secret: JSON.stringify(secret), ks })
    return { ...rest, link: joinLink(href, secret), ...(secret.us && secret.whole ? { mk: secret.whole } : {}) }
  }
  return {
    /** The room list, links whole (in memory only). An older clear list is written back sealed at once. */
    async loadRooms (k) {
      const raw = read(storage, k)
      const list = Array.isArray(raw) ? raw : []
      const out = (await Promise.all(list.map(entryIn))).filter(Boolean)
      if (key && list.some((e) => e && typeof e.link === 'string' && splitLink(e.link))) this.saveRooms(k, out)
      return out
    },
    /** Write the list — the links' keys sealed. In the order called; resolves once this one is on disk. */
    saveRooms (k, rooms) {
      const snap = (Array.isArray(rooms) ? rooms : []).map((r) => ({ ...r }))
      return onDisk(async () => { write(storage, k, await Promise.all(snap.map(entryOut))) })
    },
    /** Every account's backup state (the vault's `wbvault:backup` = { email: state }), opened. */
    async loadBackups (k) {
      const raw = read(storage, k)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'master' in raw) return {}
      const out = {}
      let clear = false
      for (const [email, v] of Object.entries(raw)) {
        if (isState(v)) { out[email] = v; clear = true; continue } // an older vault's: read through
        if (!isSealed(v) || !key) continue
        try { const s = await open(key, v); if (isState(s)) out[email] = s } catch { /* another key's: left on disk, not ours to read */ }
      }
      if (clear && key) for (const [email, s] of Object.entries(out)) if (isState(raw[email])) this.putBackup(k, email, s)
      return out
    },
    /** Move a matching signed-out email request to the signed-in account in one storage write. */
    claimEmailMove(k, email) {
      const owner = String(email || '').trim().toLowerCase()
      return onDisk(async () => {
        const before = read(storage, k), slot = before?.['']
        if (!owner || !slot || before[owner]) return false
        let draft = slot
        if (isSealed(slot) && key) { try { draft = await open(key, slot) } catch { return false } }
        if (!isState(draft) || !draft.v2?.resetDraft || String(draft.email || '').toLowerCase() !== owner) return false
        const all = read(storage, k)
        if (!all || all[owner] || JSON.stringify(all['']) !== JSON.stringify(slot)) return false
        delete all['']
        all[owner] = slot
        storage.setItem(k, JSON.stringify(all))
        return true
      })
    },
    /** One account's state (null removes it); the other accounts' entries are carried over as they are on disk. */
    putBackup (k, email, state) {
      return onDisk(async () => {
        const v = state == null ? null : key ? await seal(key, state) : state
        const now = read(storage, k)
        const all = now && typeof now === 'object' && !Array.isArray(now) && !('master' in now) ? now : {}
        // ⛔ a sealed state THIS key cannot open (its master opens every room key in the account's backup) is never written over
        //   and lost: it is kept aside first, under `<k>:unopened` (review, 2026-11-13)
        const was = all[email]
        if (isSealed(was)) {
          let ours = false; try { ours = !!(key && isState(await open(key, was))) } catch { ours = false }
          if (!ours) { const aside = read(storage, k + ':unopened'); write(storage, k + ':unopened', { ...(aside && typeof aside === 'object' && !Array.isArray(aside) ? aside : {}), [email]: was }) }
        }
        if (v == null) delete all[email]; else all[email] = v
        write(storage, k, all)
      })
    },
    /** Resolves once every write made so far is on disk. */
    flushed: () => chain,
  }
}
