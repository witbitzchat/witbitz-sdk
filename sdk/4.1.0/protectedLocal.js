// protectedLocal.js — DEVICE STORAGE PROTECTION for the PAGE's own secrets (docs/device-storage-protection.md, slice 2).
// The key worker seals ITS store (l1-worker.js §PROTECT); this seals what the main thread keeps in localStorage: the
// backup master, the room signing identities, split shares and commitments, sign-in tokens, the account/invite keys, the
// Connections / Siri / outside-agent keys, the Code pairing, contacts and the recents list (room titles).
//
// HOW, without touching the dozen modules that read them: every protected entry stays IN localStorage UNDER ITS OWN KEY,
// but as a sealed blob ({ v: 1, s }) — so the code that enumerates localStorage (`key(i)` / `length`) still sees it — and
// `Storage.prototype.getItem/setItem/removeItem` are wrapped so a protected key reads from an in-memory OVERLAY (filled at
// unlock, cleared at relock) and writes to the overlay + a fresh sealed blob. Readers are synchronous, WebCrypto is not:
// the overlay is what makes a synchronous read possible, and `ready()` is what boot awaits so no reader runs before it.
//
// INACTIVE (the switch off, or a framed app that does not own the lock): the wrappers pass straight through — every
// store byte-identical to today. Turning the switch on migrates the existing clear entries in place; turning it off
// writes them back in the clear.
//
// Limit, stated: while LOCKED the overlay is empty, so a protected key reads as absent (the app looks signed out under
// the lock screen) and a write made while locked lives only in the overlay until the next unlock persists it — a tab
// closed while locked loses that write. Boot waits for the unlock, so in practice nothing reads or writes before it.
import { importRaw, seal, open, isSealed } from './deviceSeal.js'
import { makeNamer, isOpaqueName } from './sealedNames.js'

export const PROTECTED_PREFIXES = Object.freeze([
  'space:vault',           // the backup master
  'space:id:',             // room signing identities (private keys)
  'space:sign:',           // room signing keypairs carried for the backup
  'space:myphoto', 'space:myphoto:safe', 'space:mykey:', // your profile picture and its safe copy (profilePhoto.js)
  'space:faces',           // pictures of people seen in verified Spaces, by email (profilePhoto.js)
  'space:us:', 'space:spc:', // split-key shares + commitments
  'space:mk:',             // room keys (the worker is the store when protected; any leftover is sealed too)
  'space:installHelp',     // the retired built-in install help's room + its key — an older device may still hold one (docs/install-help.md)
  'space:compsec',         // each paired computer's security check: its weak spots (codeSecurity.js)
  'space:tok:', 'space:esession', 'space:google-pending', // sign-in tokens, the email-session anchor, a browser sign-in waiting across a restart (its key)
  'space:acctv2',          // account recovery v2's state (acctV2App.js): the account id and its email (exact — `space:acctv2:base` stays clear)
  'space:acctv2:reset',    // an email move this device started (acctV2App.js RESET_KEY, § 11.5): its id and the address
  'space:awshandle',       // THIS device's own AWS key (a handle on the person's AWS budget — acctV2Wiring.js awsHandleStore): its PRIVATE half
  'space:invitekey', 'space:acctkey', // the invite key, the account-store key
  'space:attestedBox:', // an attested kind's invite box — its PRIVATE half (attestedBox.js), like the invite key above
  'space:connectionKeys', 'space:siri', 'space:a2a', 'space:code', 'space:clouddevice', // Connections call keys, the Siri inbox key, outside-agent keys, the Code pairing
  'space:connPending', // a call key whose grant's answer is still out (connectionsSheet.js — state machines pass 9, N#7)
  'space:contacts', 'space:agentlinks', 'space:recents', // content: people, agent links, the room list with its titles
  'space:blocks', // the people you blocked (blocks.js) — names and @usernames
  'space:blocks:keys', // the keys seen writing for a blocked email (blocksPush.js) — emails
  'space:share-in', 'space:share-last', // shareIn.js: words shared from another app (sessionStorage), the Space last shared into
  'space:moved-unsent:',   // space.js keepUnsentForMove: words you wrote that a moved room refused, carried to the new room's box (sessionStorage)
  'space:away-unsent:',    // space.js keepUnsentAway: words a Space refused after you had left it, kept for your return (sessionStorage; sync sweep 11-21 #7)
  'space:crossed:',        // content: the lines you authored that crossed into a shared room
  'space:inviteowed:',     // rekeyMembers.js: the people a member change added whose invites are still to go (their emails)
  // The 2026-10-10 audit (the owner: "Make sure that everything is encrypted when the lock is on") — every remaining store
  // that holds a key or content: computers' pairing secrets + cloud computers' provider keys, the account index / pipes /
  // temp-index pointers (each carries a room key), lane links (shared + lane keys), forked rooms' ancestor keys, the usage-
  // receipt keys, the agenda, outside-agent tasks, your name / @username / email, contacts' reach, pinned file names, view
  // labels — and the Code frame's own copies (it installs this module too: the computers, the direct-server password, the
  // session list). Left clear: room ids, flags, settings, diagnostics, public keys.
  'space:computers', 'space:cloud-computers', 'space:index-room', 'space:pipes-room', 'space:msgs-room', 'space:mail-handled', 'space:pipes', 'space:tempidx',
  'space:epoch:', 'space:usagekey', 'space:usagekey:old', 'space:todos', 'space:events', 'space:a2a-pending',
  'space:myname', 'space:username', 'space:myusers', 'space:acct-owner', 'space:recovery:owner-mismatch', 'space:reach', 'pinnedfiles:', 'viewmeta:',
  'oc.computers', 'oc.pass', 'oc.list',
  'space:negotiations', 'space:vaultprofile:', // legacy lane links (with their keys, migrated away) and the retired vault page's free-text profile
  // THE VAULT's own stores (slice 4 — the hosted app's top-level origin, vault-loader.js): the derived keyring with the
  // index/pipes pointers, the per-room email signing keypairs, the framed app's durable keys/tokens mirrored up, and the
  // mirrored content (contacts, the room list with titles, the temp-room pointers, your name). `space:vault` above is the
  // master there too. Left clear on purpose: `vault:lock` (the config), `vault:place`, the flags and the boot/tap trails.
  'vault:acct', 'vault:esign:', 'vault:appkv', 'vault:contacts', 'vault:roomlist', 'vault:tempidx', 'vault:myname',
  'vault:acctsecrets', // the Siri / A2A inbox private keys and the Siri Shortcut key the vault holds for the app (vaultAcctSecrets.js)
])
export const isProtectedKey = (k) => { const s = String(k); return PROTECTED_PREFIXES.some((p) => (p.endsWith(':') ? s.startsWith(p) : s === p)) }
/** A FRAMED app's marker (clear, non-secret): "my framer protects this device" — set when our vault first hands the key over,
 *  cleared when protection is switched off. The framed app has no lock config of its own to read. */
export const FRAMED_MARK = 'space:protected'
/** Does a lock config (space:lock / vault:lock) say the device is protected? */
export const cfgSaysProtected = (c) => !!(c && c.on && c.protect && c.protect.on)

// PHASE 2 (docs/desktop-protection.md § Names; the owner, 2026-10-11: "Some metadata stays readable — why?"): on a protected
// device EVERY entry is sealed, not only the secrets above — room ids in `space:last`, the confidential-room list, the
// places trail, the flags — and stored under an OPAQUE name (sealedNames.js: `p:` + the encrypted real name), so a disk
// copy learns neither what is kept nor about which rooms. Only these stay readable: what the lock screen needs before the
// passkey (the lock configs) and the framed app's marker.
// And a reviewed handful of SETTINGS that name no room, no person and no activity, which modules read ONCE at load — before
// the unlock — so sealing them would reset them on every launch: feature flags, the side panel's width, the map language,
// the diagnostics switches, the boot counter and the PUBLIC app catalog. Anything naming a room or a person is sealed.
export const STAYS_CLEAR = Object.freeze(['space:lock', 'vault:lock', FRAMED_MARK,
  'space:maplang', 'space:maplang.eff', 'space:mapsapp', 'space:settings:open', 'space:side', 'space:side-hidden', 'space:side-w', 'space:assistw',
  'space:ohttp', 'space:caretdbg', 'space:rotlab', 'space:diag', 'space:notifPreview', 'space:boots', 'space:apps',
  'space:channel', 'space:runAt', // Official / Beta / Pinned + the newest build time run (channelChoice.js): read before the unlock, or a locked device would fall back to Official
  'space:strictfiles', // Strict file viewing (strictFiles.js): sealed, a locked device would read it as off and draw others' files behind the lock screen
  'space:autoupdate', // "Update automatically" (updateState.js): sealed, a locked device read it as On and updated behind the lock screen (sync sweep, 10-16)
  'space:atrest', // the regular app's storage is sealed by its DEVICE key (spaceAtRest.js SPACE_AT_REST_MARK): read at load, so its reads wait for the boot's unlock
  'vault:atrest', // the hosted vault's storage is sealed by its DEVICE key (vaultDeviceKey.js AT_REST_MARK): read at load, so its reads wait for the boot's unlock
  'vault:repairAt']) // a time only: when the vault's boot guard last repaired (vault-boot-guard.js) — read before any unlock (sync sweep 10-21 #9)
// + the sign-in callbacks' hand-back: written by a page that holds no key (github-callback.html, mcp-callback.html) and
// removed once read (connections.js) — sealed, a protected device never finished that path (sync sweep 10-20 #8)
export const STAYS_CLEAR_PREFIXES = Object.freeze(['space:flag:', 'space:ghcb:', 'space:mcpcb:'])
// Logs every writer APPENDS to (a JSON array of lines, capped like the writers cap it): unlocking joins their copies.
const APPEND_LOGS = Object.freeze(['space:bootlog', 'vault:bootlog']), LOG_CAP = 1000
const staysClear = (k) => { const s = String(k); return STAYS_CLEAR.includes(s) || STAYS_CLEAR_PREFIXES.some((p) => s.startsWith(p)) }
const sealsHere = (k) => !staysClear(k) && !isOpaqueName(String(k)) // on a protected device: everything else

const overlay = new Map()   // real name → clear string, while unlocked (or memory-only)
const lockedWrites = new Map() // real name → value | null (a removal): written while LOCKED, applied over the disk at unlock
let active = false          // the switch is on for THIS surface
let key = null              // the device's AES key (values) while unlocked
// ⛔ A RELOCK IS NOT A NEW KEY (2026-11-08, docs/state-machines.md I16 / A#11): a sealed write still on its way when the lock engaged
//   was dropped (`key !== k`) — the value was gone at the next unlock. Made under that key, it is still that key's: only a change of
//   the protection itself (switched on or off, released, memory-only) retires writes in flight. `sealGen` counts those.
let sealGen = 0
let namer = null            // the device's name keys (sealedNames.makeNamer) while unlocked
let raw = null              // the original Storage.prototype methods
let names = null            // the enumeration cache: the real names key(i)/length answer while active
let readyResolve = null, readyPromise = Promise.resolve()
// A pending promise is KEPT: a relock while someone already waits (the vault's boot awaits this, and the launch lock's onLock
// relocks after it started waiting) must not orphan them — the unlock settles the promise they hold (2026-10-13: the hosted
// app unlocked into an empty window on every protected launch).
const armReady = () => { if (readyResolve) return; readyPromise = new Promise((r) => { readyResolve = r }) }
const settleReady = () => { if (readyResolve) { readyResolve(); readyResolve = null } }

/** True while a protected key must be answered from the overlay. */
export const protectedLocalActive = () => active
/** Boot awaits this: resolved at once when inactive; after the unlock has filled the overlay when active. */
export const protectedLocalReady = () => readyPromise
/** A protected key can be read AND written truly now (inactive, unlocked, or memory-only) — while locked a read answers absent
 *  and a write would replace the sealed value at the unlock (vaultConnKeys.js asks before it merges). */
export const protectedLocalOpen = () => !active || !!key || memoryOnly
/** The stored bytes under a key, unwrapped by nothing — what a disk copy would see. */
export const rawGet = (k) => (raw ? raw.getItem.call(localStorage, k) : localStorage.getItem(k))
/** Every key as stored on disk (opaque names included) — what a disk copy would list. */
export const rawKeys = () => { const out = []; const n = raw ? rawLength() : localStorage.length; for (let i = 0; i < n; i++) { const k = raw ? raw.key.call(localStorage, i) : localStorage.key(i); if (k != null) out.push(k) } return out }
let lengthDesc = null
const rawLength = () => (lengthDesc ? lengthDesc.get.call(localStorage) : localStorage.length)

// Disk writes are async (WebCrypto) and must land in the order they were made: one chain.
let chain = Promise.resolve()
const onDisk = (fn) => { chain = chain.then(fn).catch(() => {}); return chain }
const writeSealed = (name, v) => { const k = key, nm = namer, g = sealGen; if (!k || !nm) return; onDisk(async () => { const o = await nm.opaque(name); const blob = await seal(k, v); if (sealGen !== g) return; try { raw.setItem.call(localStorage, o, JSON.stringify(blob)) } catch { /* private mode / full */ } try { raw.removeItem.call(localStorage, name) } catch { /* */ } }) }
const removeSealed = (name) => { const nm = namer; if (!nm) return; onDisk(async () => { try { raw.removeItem.call(localStorage, await nm.opaque(name)) } catch { /* */ } }) }
/** Resolves once every queued disk write has landed (tests, and the switch-off). */
export const protectedLocalFlushed = () => chain
/** What is ON DISK for `name` once the queued writes have landed — opened as a protected read would open it; null when
 *  nothing is there or it cannot be kept (locked, memory-only). Writes swallow their errors (a full or private store), so a
 *  caller that must know a value is durable reads it back here (account recovery v2: a new recovery code is kept BEFORE
 *  its activation is sent — implementation review R2-03). */
export async function durableRead (name) {
  await chain
  if (!active || !raw) return rawGet(name)
  if (memoryOnly || !key || !namer) return null
  try {
    const v = raw.getItem.call(localStorage, await namer.opaque(name))
    const blob = v && parseSealed(v)
    return blob ? String(await open(key, blob)) : null
  } catch { return null }
}

// LOCKED or MEMORY-ONLY, an entry still CLEAR on disk (never migrated: an unsecured computer, or a flag an older build wrote)
// reads through — unless it is a secret: those are only ever answered by the overlay.
const readThrough = (n) => { if (isProtectedKey(n)) return null; const v = raw.getItem.call(localStorage, n); return v != null && !parseSealed(v) ? v : null }
const enumerate = () => {
  if (names) return names
  const set = new Set(overlay.keys())
  for (const [n, v] of lockedWrites) if (v != null) set.add(n)
  for (const k of rawKeys()) if (!isOpaqueName(k) && (staysClear(k) || (!key && readThrough(k) != null))) set.add(k)
  names = [...set]; return names
}

/** Wrap Storage.prototype once (idempotent). `proto` is injectable for tests. */
export function installProtectedLocal (proto = (typeof Storage !== 'undefined' ? Storage.prototype : null), { on = false } = {}) {
  if (!proto || raw) { if (on && !active) { active = true; names = null; armReady() } return }
  raw = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear, key: proto.key }
  lengthDesc = Object.getOwnPropertyDescriptor(proto, 'length') || null
  const mine = (t) => active && t === localStorage
  proto.getItem = function (k) {
    if (!mine(this) || !sealsHere(k)) return raw.getItem.call(this, k)
    const n = String(k); if (overlay.has(n)) return overlay.get(n)
    if (lockedWrites.has(n)) return lockedWrites.get(n)
    if (!key && !memoryOnly && lockedReads.size < 200) lockedReads.add(n) // a read made before the unlock answers absent: kept so it can be seen (protectedLocalLockedReads)
    return key ? null : readThrough(n)
  }
  proto.setItem = function (k, v) {
    if (!mine(this) || !sealsHere(k)) return raw.setItem.call(this, k, v)
    const n = String(k), s = String(v); names = null
    if (key) { overlay.set(n, s); writeSealed(n, s) } else if (memoryOnly) overlay.set(n, s); else lockedWrites.set(n, s)
  }
  proto.removeItem = function (k) {
    if (!mine(this) || !sealsHere(k)) return raw.removeItem.call(this, k)
    const n = String(k); names = null; overlay.delete(n)
    if (key) { removeSealed(n); try { raw.removeItem.call(this, n) } catch { /* */ } } else if (!memoryOnly) lockedWrites.set(n, null)
  }
  proto.clear = function () { if (this === localStorage) { overlay.clear(); lockedWrites.clear(); names = null; if (memoryOnly) return } return raw.clear.call(this) } // memory-only: the disk (an account, sealed entries) is never touched
  proto.key = function (i) { if (!mine(this)) return raw.key.call(this, i); const a = enumerate(); return i >= 0 && i < a.length ? a[i] : null }
  if (lengthDesc && lengthDesc.get) Object.defineProperty(proto, 'length', { configurable: true, enumerable: lengthDesc.enumerable, get () { return mine(this) ? enumerate().length : lengthDesc.get.call(this) } })
  if (on) { active = true; armReady() }
}
let memoryOnly = false
const lockedReads = new Set()
/** The names read while LOCKED (answered absent) — a module that read a setting at load, before the unlock, shows up here. */
export const protectedLocalLockedReads = () => [...lockedReads]

const parseSealed = (s) => { try { const o = JSON.parse(s); return isSealed(o) ? o : null } catch { return null } }

/** Switch ON / unlock: import the device key, fill the overlay from disk — opaque entries opened; phase-1 entries (sealed
 *  under their own names) and clear entries MOVED under opaque names — apply what was written while locked, then answer
 *  `ready()`. A wrong key throws on the first sealed entry and changes nothing. */
//
// `switchOn`: protection is being TURNED ON with a new passkey (spaceLock.enableProtection). Protection was off, so no lock
// names a passkey for whatever sealed entries are still here — an earlier setup's leftovers (a reset, site data cleared in
// part): nothing can ever open them. They are dropped rather than refused — refusing failed every "Secure this computer"
// for good, each retry a new passkey that opened none of them (the owner's second desktop, 2026-10-29: protect_failed).
// A GUEST'S VISIT STAYS MEMORY-ONLY (sync sweep 11-04 #1, #5): an unlock would turn memory-only off and write the visit into the
// account's storage; a "forget" would delete this device's sealed entries. During the demo's temporary room neither happens.
const guestVisit = () => { try { return memoryOnly && typeof location !== 'undefined' && isGuestTempRoom(location) } catch { return false } }
export async function unlockProtectedLocal (rawKey, { switchOn = false } = {}) {
  if (guestVisit()) return
  if (!raw) installProtectedLocal()
  await chain // a second unlock (the frame takes the key at its store's hand-over, then again from framedProtect): writes still on their way land first, or the disk read below would put an older value back
  const k = await importRaw(rawKey), nm = await makeNamer(rawKey)
  const next = new Map(), move = [], stale = []
  let opaque = 0, ours = 0
  // ALL AT ONCE (2026-11-17, the owner's iPhone: "storage opened with the device key in 223 ms"): WebKit answers each WebCrypto call
  // on another thread, so ~1200 entries × 3 calls awaited one by one cost 127 ms in WebKit here, issued together 4 ms (Chromium: 11 / 9).
  // Every entry is opened first, then taken in the disk's order below — the same outcome, the same throws.
  const entries = []
  for (const stored of rawKeys()) {
    if (staysClear(stored)) continue
    const v = raw.getItem.call(localStorage, stored); if (v == null) continue
    entries.push([stored, v])
  }
  const opened = await Promise.all(entries.map(async ([stored, v]) => {
    if (isOpaqueName(stored)) {
      const name = await nm.real(stored); if (name == null) return { stale: true } // another key's leftover: not ours to read
      const blob = parseSealed(v); if (!blob) return { name, skip: true }
      return { name, clear: String(await open(k, blob)) }
    }
    const blob = parseSealed(v)
    if (blob && isProtectedKey(stored)) { // phase 1: sealed under its own name
      try { return { clear: String(await open(k, blob)) } } catch (e) { if (!switchOn) throw e; return { stale: true } }
    }
    return { clear: v } // clear: never protected before, or written by an older build
  }))
  const logCopies = new Map() // an APPEND LOG's every copy, merged below — never one copy replacing another
  entries.forEach(([stored], i) => {
    const r = opened[i]
    if (isOpaqueName(stored)) {
      opaque++
      if (r.stale) { stale.push(stored); return }
      ours++
      if (!r.skip) { next.set(r.name, r.clear); if (APPEND_LOGS.includes(r.name)) logCopies.set(r.name, [r.clear, ...(logCopies.get(r.name) || [])]) } // the sealed copy is the older history: first
    } else {
      if (r.stale) { stale.push(stored); return }
      next.set(stored, r.clear)
      if (APPEND_LOGS.includes(stored)) logCopies.set(stored, [...(logCopies.get(stored) || []), r.clear])
      move.push(stored)
    }
  })
  // THE BOOT LOG KEEPS EVERY LINE (2026-11-17, the owner's iPhone sealed by the device key: each Diagnostics showed ONE launch, and one
  // lost every line after the unlock). The loader writes its lines to a CLEAR `space:bootlog` before this module runs, the sealed copy
  // holds the history, and a line written while locked waits in lockedWrites — whichever the disk listed last replaced the others,
  // and a locked write was dropped because the disk had the name. Now the copies are joined (history first, each line once, the cap kept).
  const logWritten = []
  for (const n of APPEND_LOGS) {
    const parts = [...(logCopies.get(n) || []), lockedWrites.get(n)].filter((v) => v != null)
    if (parts.length < 2) continue
    const seen = new Set(), lines = []
    for (const v of parts) { let a = null; try { a = JSON.parse(v) } catch { a = null } if (!Array.isArray(a)) continue; for (const l of a) { const t = String(l); if (!seen.has(t)) { seen.add(t); lines.push(t) } } }
    while (lines.length > LOG_CAP) lines.shift()
    next.set(n, JSON.stringify(lines)); lockedWrites.delete(n); logWritten.push(n)
  }
  if (opaque && !ours && !switchOn) throw new Error('this key opens nothing here') // a wrong key: every name fails to open, change nothing
  if (switchOn) for (const n of stale) { try { raw.removeItem.call(localStorage, n) } catch { /* */ } }
  // A write made while locked is kept only where the disk has NOTHING under that name: a module that found a value "missing"
  // at load (it was sealed) and wrote a default — a fresh device id, an empty list — must never replace the real one.
  const written = []
  for (const [n, v] of lockedWrites) if (v != null && !next.has(n)) { next.set(n, v); written.push(n) }
  const removed = []
  if (switchOn) sealGen++ // a new protection: writes made under another one are not this one's
  key = k; namer = nm; active = true; memoryOnly = false; names = null
  overlay.clear(); for (const [n, v] of next) overlay.set(n, v)
  lockedWrites.clear()
  for (const n of new Set([...move, ...written, ...logWritten])) if (overlay.has(n)) writeSealed(n, overlay.get(n))
  settleReady()
  // Modules that cached a value at load (read while locked → absent) re-read it now: enclave.js (the confidential rooms),
  // trustedBuilds.js, unread.js. An event, not an import — the SDK shares those modules and must not install this one.
  try { if (typeof dispatchEvent === 'function' && typeof Event === 'function') dispatchEvent(new Event('wb-protected-unlocked')) } catch { /* */ }
  return { entries: next.size, migrated: move.length }
}
/** RE-KEY (docs/vault-at-rest-and-invites-plan.md § 1): the storage, sealed and open under one key, is written again under another —
 *  the hosted vault's device key ↔ a passkey's. Every entry in the overlay is sealed under the new key's opaque name FIRST, then the
 *  old key's opaque names go: never a clear moment on disk. Unlocked only; throws when locked (nothing would be carried). */
export async function rekeyProtectedLocal (newRaw) {
  if (!raw || !active || !key || !namer) throw new Error('rekey: not unlocked')
  await chain
  const oldNm = namer, k = await importRaw(newRaw), nm = await makeNamer(newRaw)
  const old = []
  for (const stored of rawKeys()) if (isOpaqueName(stored) && (await oldNm.real(stored)) != null) old.push(stored)
  sealGen++; key = k; namer = nm; names = null
  for (const [n, v] of overlay) writeSealed(n, v)
  await chain
  for (const o of old) { try { raw.removeItem.call(localStorage, o) } catch { /* */ } }
  return { entries: overlay.size, moved: old.length }
}
/** Relock: nothing readable stays in memory; the sealed blobs stay on disk. */
export function relockProtectedLocal () { overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = false; if (active) armReady() }
/** MEMORY ONLY (docs/desktop-protection.md, a room link on an unsecured computer): every entry but the lock config is
 *  answered from and written to the overlay alone — nothing reaches the disk — and boot is not held. */
export function memoryOnlyProtectedLocal () { sealGen++; if (!raw) installProtectedLocal(); overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = true; active = true; settleReady() }
/** Switch OFF: every entry back in the clear under its real name; the opaque entries go; the wrappers pass through again. */
export async function unprotectProtectedLocal (rawKey) {
  if (!raw) installProtectedLocal()
  await chain
  const k = await importRaw(rawKey), nm = await makeNamer(rawKey)
  for (const stored of rawKeys()) {
    const v = raw.getItem.call(localStorage, stored); if (v == null) continue
    if (isOpaqueName(stored)) {
      const name = await nm.real(stored); const blob = parseSealed(v)
      if (name != null && blob) raw.setItem.call(localStorage, name, String(await open(k, blob)))
      if (name != null) raw.removeItem.call(localStorage, stored)
    } else if (isProtectedKey(stored)) { const blob = parseSealed(v); if (blob) raw.setItem.call(localStorage, stored, String(await open(k, blob))) } // phase 1
  }
  sealGen++; overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = false; active = false; settleReady()
}
/** A FRAMED app whose framer no longer protects the device (the marker is stale, or the vault never answered): the sealed
 *  entries cannot be opened without a key that is gone — drop them (they are mirrors the vault seeds back) and pass through. */
export function forgetProtectedLocal () { if (guestVisit()) return;
  if (!raw) installProtectedLocal()
  for (const stored of rawKeys()) { const v = raw.getItem.call(localStorage, stored); if (isOpaqueName(stored) || (v != null && parseSealed(v))) { try { raw.removeItem.call(localStorage, stored) } catch { /* */ } } }
  try { raw.removeItem.call(localStorage, FRAMED_MARK) } catch { /* */ }
  sealGen++; overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = false; active = false; settleReady()
}
/** A FRAME whose parent switched protection off: the parent wrote every entry back in the clear — just pass through. */
export function releaseProtectedLocal () { sealGen++; overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = false; active = false; settleReady() }
// ANOTHER DOCUMENT of this origin wrote an entry (the app and its Code frame share localStorage, each with its own overlay):
// take the new value into this overlay, so neither reads a stale copy until it reloads.
try {
  if (typeof window !== 'undefined') addEventListener('storage', (e) => {
    if (!active || !key || !namer || !e.key || e.storageArea !== localStorage || !isOpaqueName(e.key)) return
    const k = key, nm = namer
    nm.real(e.key).then((name) => {
      if (name == null || key !== k) return
      names = null
      if (e.newValue == null) { overlay.delete(name); return }
      const blob = parseSealed(e.newValue); if (blob) open(k, blob).then((v) => { if (key === k) overlay.set(name, String(v)) }).catch(() => {})
    }).catch(() => {})
  })
} catch { /* no window */ }
// SELF-INSTALL at import. This module is the FIRST import of space.js (and of vault-loader.js), so it evaluates before any
// module that reads a protected key; it wraps the prototype once and switches on when the device is protected (active ⇒
// reads answer null until the unlock fills the overlay). A TOP-LEVEL page owns a lock: the standalone app's `space:lock`
// or the vault's `vault:lock`. A FRAMED app owns none — its framer (our vault, slice 4) hands it the key, and the marker it
// leaves says to start sealed; framed by anyone else, or unmarked, nothing happens.
try {
  if (typeof window !== 'undefined' && typeof Storage !== 'undefined') {
    const rawGet0 = (k) => { try { return Storage.prototype.getItem.call(localStorage, k) } catch { return null } }
    const cfgOn = (k) => { try { return cfgSaysProtected(JSON.parse(rawGet0(k) || 'null')) } catch { return false } }
    // a SAME-ORIGIN frame of the app (the Code section, codeView.js) shares its localStorage: it reads the app's own lock
    // config, and the app hands it the key ({ch:'codeProtect'}), exactly as idbSeal.js does for the idb
    let sameOriginFramed = false; try { sameOriginFramed = window.top !== window && window.parent.location.origin === location.origin } catch { sameOriginFramed = false }
    // A same-origin frame shares only the APP's lock (space:lock — the Code frame inside the app). The vault's vault:lock is
    // the vault's own: an app the vault frames on its origin (dev, a test fixture) waits for the vault's hand-off marker,
    // never reads that config as its own and sits sealed waiting for a key (2026-10-13, vaultProtect).
    const on = window.top === window ? (cfgOn('space:lock') || cfgOn('vault:lock') || rawGet0(FRAMED_MARK) === '1' || rawGet0('vault:atrest') === '1' || rawGet0('space:atrest') === '1')
      : sameOriginFramed ? (cfgOn('space:lock') || rawGet0(FRAMED_MARK) === '1' || rawGet0('space:atrest') === '1') : rawGet0(FRAMED_MARK) === '1' // space:atrest: the app's device key (spaceAtRest.js) — a same-origin frame (Code, the lane panel) waits for its parent's hand-off
    installProtectedLocal(Storage.prototype, { on })
    // A GUEST'S TEMPORARY ROOM (the HN demo's link: ?room=tmp-…, #…guest=1 — the app's address, regular or framed by the vault):
    // the visitor came to look, so NOTHING of the visit reaches the disk — memory-only from this module's first line, before
    // any module writes a device id, a boot log or the room's settings (the owner, 2026-11-04: "Fix Secure this computer"; the
    // hosted frame kept space:model:<room>, space:tempidx, space:usagekey … in its own storage). On a PROTECTED device too: the
    // visit reads nothing sealed and writes nothing, so it needs no unlock (the owner's computer: the demo met "Spaces is locked").
    if (isGuestTempRoom(location)) memoryOnlyProtectedLocal()
  }
} catch { /* no storage (a worker, a sandbox): nothing to protect here */ }

/** The demo's guest link for a temporary room: ?room=tmp-… with guest=1 — after the # (the app's address, the frame's) or in
 *  the query (the vault's own link, hnPage.js vaultLinkOf). THE one test: nameGate.js, encHint.js and space.js ask it too — a
 *  guest=1 on any other room changes nothing (sync sweep 11-04 #7, #12). */
export function isGuestTempRoom (loc) {
  try {
    const q = new URLSearchParams(loc.search || '')
    return (/[#&]guest=1(?:&|$)/.test(String(loc.hash || '')) || q.get('guest') === '1') && String(q.get('room') || '').startsWith('tmp-')
  } catch { return false }
}

/** For tests: forget the wrapping (restores the prototype). */
export function _uninstallProtectedLocal (proto = (typeof Storage !== 'undefined' ? Storage.prototype : null)) {
  if (!raw || !proto) return
  Object.assign(proto, raw); if (lengthDesc) Object.defineProperty(proto, 'length', lengthDesc); raw = null; lengthDesc = null; overlay.clear(); lockedWrites.clear(); key = null; namer = null; names = null; memoryOnly = false; active = false; readyPromise = Promise.resolve(); readyResolve = null
}
