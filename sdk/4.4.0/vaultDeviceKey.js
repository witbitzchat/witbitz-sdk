// THE HOSTED VAULT'S DEVICE STORAGE KEY (docs/vault-at-rest-and-invites-plan.md § 1, phase 1). 32 random bytes made once per vault
// origin and kept WRAPPED (AES-GCM) under a NON-extractable key in this origin's IndexedDB — the builders' vault's pattern
// (vaultAtRest.deviceWrapKey). At every launch the vault unwraps it with no prompt and hands the bytes to the same three sealers
// passkey protection uses (protectedLocal, the key worker, idbSeal): a copy, sync or search of the saved data alone finds no room
// key. It does NOT stand against malware that copies the whole browser profile (the wrapping key is in it) — the passkey does.
//
// null when there is no IndexedDB (Lockdown Mode, some private windows): the vault stays as it is, clear — never a key lost for want
// of a seal (the builders' vault's rule). A wrapped key the wrapping key cannot open (IndexedDB half cleared) also answers null and
// `lost: true`: the sealed entries cannot be opened, and the caller treats the device as new.
const DB = 'wbvault-device-key'
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

/** The sealing switch's clear marker (protectedLocal.js STAYS_CLEAR): set once this vault's storage was sealed by the device key, so
 *  the next launch's protectedLocal starts sealed (reads wait for the unlock) instead of passing through. */
export const AT_REST_MARK = 'vault:atrest'

// ⛔ A READ THAT FAILED IS NOT A KEY THAT IS GONE (the owner's iPhone, 2026-11-14 12:43:56Z: "My account was reset"). Any error here
//   answered null — the same answer as "this browser has no IndexedDB" — and the vault, finding its storage sealed, took it for a lost
//   key and dropped every sealed entry, the account record among them. iOS fails IndexedDB opens now and then (a page woken from the
//   background: "Connection to Indexed Database server lost"). So: a failed read is tried again (`tries`), and one that keeps failing
//   answers `{ raw: null, error }` — the caller deletes nothing on it. `made` is true only when THIS call wrote the key: an `add` that
//   lost to an existing one (a read that came back empty for a moment) is not a new key.
const RETRY_MS = [150, 400, 900]

// THE OS KEY STORE MAY WAIT FOR THE PERSON (the owner's WSL, 2026-11-22): a keyring never set up asks for a password in a window of its own
//   (GNOME Keyring's prompt — on WSL it can open behind the app), and the read waits for that answer. It used to wait in silence under the
//   loading screen until the boot watch said "didn't finish loading" and offered a Repair that cannot help. Now: the wait is marked
//   `data-unlocking` (the boot watch holds its verdict, vault-boot-guard.js), the loading screen says what it waits for, and a key store
//   that never answers ends in an error (the caller's "Couldn't open your saved data" — Try again), never a hang.
export const KEY_WAIT_MS = 180000
const KEY_WAIT_SAY_MS = 3000
export async function waitForKeyStore (call, ms = KEY_WAIT_MS) {
  const doc = typeof document !== 'undefined' ? document : null
  const root = doc && doc.documentElement
  let said = null, sayT = 0, endT = 0
  try { if (root) root.setAttribute('data-unlocking', 'keyring') } catch { /* */ }
  sayT = setTimeout(() => {
    try {
      const t = doc && doc.querySelector('#bootLoad .bl-txt')
      if (t) { said = t.textContent; t.textContent = 'Waiting for your keyring… If a window asks for a keyring password, answer it — it may be behind this one.' }
    } catch { /* */ }
  }, KEY_WAIT_SAY_MS)
  try {
    return await Promise.race([typeof call === 'function' ? call() : call, new Promise((resolve) => { endT = setTimeout(() => resolve({ error: 'the keyring did not answer in ' + Math.round(ms / 1000) + ' s' }), ms) })])
  } finally {
    clearTimeout(sayT); clearTimeout(endT)
    try { if (root && root.getAttribute('data-unlocking') === 'keyring') root.removeAttribute('data-unlocking') } catch { /* */ }
    try { const t = said != null && doc.querySelector('#bootLoad .bl-txt'); if (t) t.textContent = said } catch { /* */ }
  }
}
/** @returns {Promise<{ raw: Uint8Array, made: boolean, os?: true } | { raw: null, lost: true } | { raw: null, error: string } | null>} */
export async function deviceStorageKey ({ desktop = globalThis.WitbitzDesktop, idb = (typeof indexedDB !== 'undefined' ? indexedDB : null), subtle = (globalThis.crypto && crypto.subtle), tries = RETRY_MS.length + 1, wait = (ms) => new Promise((r) => setTimeout(r, ms)), keyWaitMs = KEY_WAIT_MS } = {}) {
  // THE DESKTOP APP (desktop/keyStore.mjs, Linux and the Mac): the key is kept by the operating system's key store (the Keychain, the
  // Secret Service), not beside the files it seals — a copy of the app's files opens nothing. Its `error` is this function's (the caller
  // deletes nothing); a desktop app with no usable key store (Linux without a keyring) falls back to this origin's own key below.
  if (desktop && typeof desktop.storageKey === 'function') {
    let r = null
    try { r = await waitForKeyStore(() => desktop.storageKey(), keyWaitMs) } catch (e) { r = { error: String((e && e.message) || e).slice(0, 200) } }
    if (r && typeof r.raw === 'string' && r.raw) {
      const raw = Uint8Array.from(atob(r.raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      if (raw.length === 32) return { raw, made: !!r.made, os: true }
      return { raw: null, error: 'desktop key: bad length' }
    }
    // `refused`: the key store answered and would not open the key saved here (made under a keyring since replaced) — not "no keyring"
    if (!(r && /^no_(keystore|keyring)$/.test(String(r.error)))) return { raw: null, error: 'desktop key: ' + String((r && r.error) || 'no answer').slice(0, 160), ...(/^(keystore_refused|bad_key)/.test(String(r && r.error)) ? { refused: true } : {}) }
  }
  if (!idb || !subtle) return null
  let last = null
  for (let i = 0; i < tries; i++) {
    if (i) await wait(RETRY_MS[Math.min(i - 1, RETRY_MS.length - 1)])
    try { return await readOnce(idb, subtle) } catch (e) { last = e }
  }
  return { raw: null, error: String((last && (last.name ? last.name + ': ' : '') + (last.message || '')) || last || 'unknown').slice(0, 200) }
}

async function readOnce (idb, subtle) {
  let db = null
  try {
    db = await new Promise((res, rej) => { const r = idb.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const get = (k) => reqP(db.transaction('k', 'readonly').objectStore('k').get(k)).then((v) => v || null)
    // `add`, never `put`: two tabs making it at once — the first wins, both read back the same one
    const add = (k, v) => new Promise((res) => { const t = db.transaction('k', 'readwrite'); t.objectStore('k').add(v, k); t.oncomplete = () => res(true); t.onabort = () => res(false); t.onerror = (e) => { try { e.preventDefault() } catch { /* */ } } }) // true: this call wrote it
    let wrap = await get('wrap')
    if (!wrap) { await add('wrap', await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])); wrap = await get('wrap') }
    if (!wrap || wrap.type !== 'secret') return null
    let made = false, sealed = await get('sealed')
    if (!sealed) {
      const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12))
      made = await add('sealed', { iv, ct: new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wrap, raw)) })
      sealed = await get('sealed')
      if (!sealed) throw new Error('the device key could not be read back')
    }
    try { return { raw: new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, wrap, sealed.ct)), made } } catch { return { raw: null, lost: true } }
  } finally { try { db && db.close() } catch { /* */ } }
}
