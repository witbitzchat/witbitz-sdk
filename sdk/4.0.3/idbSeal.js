// idbSeal.js — DEVICE STORAGE PROTECTION for the page's IndexedDB CONTENT (docs/device-storage-protection.md, slice 3):
// the chat cache (`chat:<room>`: every message this device has shown), widget state (`wstate:<room>:<widget>`: itineraries,
// lists, places), cached attachments (`blob:<room>:<ref>`) and the Code section's offline transcripts (`code:…`). With the
// switch on they are ciphertext at rest under the device key, like the keys in slice 1 and the secrets in slice 2.
//
// Pure decisions, no storage of its own: idb.js asks `wrapForStore` before a put and `unwrapFromStore` after a get, so no
// cache module changes. States: INACTIVE (switch off, or a framed app that does not own the lock) → pass-through;
// ACTIVE + key (unlocked) → seal on write, open on read; ACTIVE, no key (locked) → a protected key reads as ABSENT (no
// cache → the room loads from the network after the unlock) and a write is DROPPED (never a clear write over a protected
// store; the cache refills on the next save). `zoom:` (a call's meeting link, its passcode included) is sealed since
// 2026-10-10 — a call tap on a protected device opens the app, not the meeting. Keys the service worker needs while locked (the
// notification mirror, the push prefetch — which holds the server's sealed boxes, unreadable without the room key anyway)
// are not protected, on purpose.
import { sealIf, openIf, isSealed, importRaw, seal, open } from './deviceSeal.js'
import { makeNamer, isOpaqueName } from './sealedNames.js'

// §NAMES (docs/desktop-protection.md, phase 2): on a protected device EVERY key in this store is kept under an opaque name
// (sealedNames.js) with its value sealed — `chat:<room>`, the worker's `mk:<room>`, `cnt:`, `viewing`, all of it — so a disk
// copy lists no room. The page (here) and the key worker (l1-worker.js §PROTECT) each set it from the device key; without
// the key (locked, memory-only) idb.js answers absent and drops writes. Only the names the SERVICE WORKERS share with the
// page keep their real name, since they hold no key: the tap record, the preview setting, the protection flag, the worker
// trail, the Code reminder key (codeRemind.js: at rest only while previews are opted in) — and `nk:` while previews are opted in.
// `devkey:v1` (devices.js) keeps its name and is never sealed either: it holds a NON-EXTRACTABLE CryptoKey, which no page
// or disk copy can turn into bytes, so sealing protects nothing — and sealing is JSON, which turned the key into `{}` (every
// protected device lost its device key at switch-on; account recovery v2's staging test, 2026-11-14).
export const IDB_SHARED_NAMES = Object.freeze(['notifTap', 'notifPreview', 'protectedNames', 'swTrail', 'codeRemindKey', 'devkey:v1', 'blocks:sw'])
const naming = { on: false, key: null, namer: null }
/** { on, key (CryptoKey for values), namer (sealedNames.makeNamer) } — on without a namer = locked. */
export function setIdbNaming ({ on = false, key = null, namer = null } = {}) { naming.on = !!on; naming.key = key; naming.namer = namer }
export const idbNamingState = () => naming
/** Key worker: the device key's raw bytes → this realm's naming (null = locked; off = unprotected). */
export async function armIdbNaming (rawKey) { setIdbNaming({ on: true, key: await importRaw(rawKey), namer: await makeNamer(rawKey) }) }

export const IDB_PROTECTED_PREFIXES = Object.freeze(['chat:', 'wstate:', 'blob:', 'code:', 'vchat:', 'vblob:', 'vblobidx', 'hidx:', 'zoom:', 'mailpend:']) // vchat: = the vault's durable seed of the framed app's chat (slice 4); hidx: = Help search's full-history copy (helpIndex.js); mailpend: = a mail's attachment parts waiting for their mail (mailShare.js)
export const isProtectedIdbKey = (k) => { const s = String(k); return IDB_PROTECTED_PREFIXES.some((p) => s.startsWith(p)) }

const st = { active: false, key: null }
/** The lock hooks drive this: { active, key } — key is a CryptoKey from deviceSeal.importRaw, or null while locked. */
export function setIdbProtection ({ active = st.active, key = st.key } = {}) { st.active = !!active; st.key = key || null; if (!st.active) setIdbNaming({ on: false }); else if (!st.key) setIdbNaming({ on: true }) } // locked: names on, no namer
export const idbProtection = () => ({ active: st.active, unlocked: !!st.key })

/** What to put under `k` for value `v`: the value (inactive or not a protected key), a sealed blob (unlocked), or
 *  `undefined` = DROP the write (locked: never a clear write over a protected store). */
export async function wrapForStore (k, v) {
  if (!st.active || !isProtectedIdbKey(k)) return v
  if (!st.key) return undefined
  return sealIf(st.key, v)
}
/** What a get returns for stored `v`: the value, the opened value, or null for a sealed value with no key (locked) or
 *  a key that cannot open it (never a throw up into a cache reader — it treats null as "no cache"). */
export async function unwrapFromStore (k, v) {
  if (!isProtectedIdbKey(k) || !isSealed(v)) return v // the worker's own sealed `mk:`/`us:`/`nk:` entries pass through untouched — it parks and opens them itself
  if (!st.key) return null
  try { return await openIf(st.key, v) } catch { return null }
}

/** The protected keys under every prefix, WITHOUT their values (keysRaw where the store has it; else the keys of entriesRaw). */
const protectedKeys = async (idb) => { const out = []; for (const pfx of IDB_PROTECTED_PREFIXES) { if (typeof idb.keysRaw === 'function') out.push(...await idb.keysRaw(pfx)); else for (const [k] of await idb.entriesRaw(pfx)) out.push(k) } return out }

/** UNLOCK: hold the key, no scan. A clear legacy entry still reads (unwrapFromStore passes it through) and is sealed by its
 *  next write; the full migration runs ONCE, at switch-on. Scanning the whole content store on every unlock loaded every
 *  cached room into memory at once and killed the page on an iPhone ("A problem repeatedly occurred", 2026-10-06). */
export async function armIdbProtection (rawKey) { const key = await importRaw(rawKey); setIdbProtection({ active: true, key }); setIdbNaming({ on: true, key, namer: await makeNamer(rawKey) }) }
/** §NAMES: move every entry still under its real name under its opaque name, ONE at a time (keys first — never the whole
 *  store in memory). Phase-1 content sealed in place is opened first; the key worker's own sealed keys move as they are.
 *  An entry already present under its opaque name (written since) wins — the old one is only deleted. Cheap once done. */
export async function moveToOpaqueNames (idb) {
  const { key, namer } = naming; if (!key || !namer) return 0
  try { await idb.setRaw('protectedNames', true) } catch { /* the service workers' cue: no prefetch on this device */ }
  let n = 0
  for (const k of await idb.keysRaw('')) {
    if (isOpaqueName(k) || IDB_SHARED_NAMES.includes(k) || k.startsWith('nk:')) continue
    let v = await idb.getRaw(k); if (v === undefined || v === null) continue
    if (isProtectedIdbKey(k) && isSealed(v)) { try { v = await openIf(st.key || key, v) } catch { continue } }
    const o = await namer.opaque(k)
    if ((await idb.getRaw(o)) == null) await idb.setRaw(o, await seal(key, v))
    await idb.delRaw(k); n++
  }
  return n
}

/** Switch on: seal every clear protected entry in place (migration) — ONE entry at a time, keys first, never the whole store. */
export async function migrateIdbProtection (idb, rawKey) {
  await armIdbProtection(rawKey)
  return moveToOpaqueNames(idb)
}
/** Switch off: open every sealed protected entry and write it back in the clear, one at a time; then pass-through. */
export async function unprotectIdb (idb, rawKey) {
  const key = await importRaw(rawKey), namer = await makeNamer(rawKey)
  for (const o of await idb.keysRaw('p:')) { const name = await namer.real(o); const v = await idb.getRaw(o); if (name != null && v != null) { try { await idb.setRaw(name, await open(key, v)) } catch { /* junk */ } } await idb.delRaw(o) } // back under real names (the key worker opens its own keys after)
  for (const k of await protectedKeys(idb)) { const v = await idb.getRaw(k); if (isSealed(v)) { try { await idb.setRaw(k, await openIf(key, v)) } catch { await idb.delRaw(k) } } } // an entry the key cannot open is junk: drop it
  try { await idb.delRaw('protectedNames') } catch { /* */ }
  setIdbProtection({ active: false, key: null })
}
/** A FRAMED app whose framer no longer protects the device: the sealed content cannot be opened — drop it (it is a cache)
 *  and pass through. */
export async function dropSealedIdb (idb) {
  for (const k of await protectedKeys(idb)) { const v = await idb.getRaw(k); if (isSealed(v)) { try { await idb.delRaw(k) } catch { /* */ } } }
  for (const o of await idb.keysRaw('p:')) { try { await idb.delRaw(o) } catch { /* */ } }
  try { await idb.delRaw('protectedNames') } catch { /* */ }
  setIdbProtection({ active: false, key: null })
}

// SELF-INIT from the lock's stored config, like protectedLocal.js: a protected standalone app starts ACTIVE and LOCKED
// (reads answer null) until the unlock supplies the key. A worker realm has no window: inactive there (the worker seals
// its own store itself, l1-worker.js §PROTECT).
try {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const rawGet0 = (k) => { try { return typeof Storage !== 'undefined' ? Storage.prototype.getItem.call(localStorage, k) : localStorage.getItem(k) } catch { return null } }
    const cfgOn = (k) => { try { const c = JSON.parse(rawGet0(k) || 'null'); return !!(c && c.on && c.protect && c.protect.on) } catch { return false } }
    // a TOP-LEVEL page reads its own lock config (the standalone app's, or the vault's); a FRAMED app reads the marker its
    // framing vault left (protectedLocal.js FRAMED_MARK) — the key arrives from the vault after boot
    // a same-origin frame of the app (the Code section, codeView.js) shares its localStorage AND its idb: read the app's own
    // lock config there too — its parent hands the key down ({ch:'codeProtect'}); a cross-origin frame reads the marker
    let sameOriginFramed = false; try { sameOriginFramed = window.top !== window && window.parent.location.origin === location.origin } catch { sameOriginFramed = false }
    const on = (window.top === window || sameOriginFramed) ? (cfgOn('space:lock') || cfgOn('vault:lock') || rawGet0('space:protected') === '1' || (window.top === window && rawGet0('vault:atrest') === '1') || rawGet0('space:atrest') === '1') : rawGet0('space:protected') === '1'
    if (on) setIdbProtection({ active: true, key: null })
  }
} catch { /* no storage here */ }
