// vaultCoreLock.js — THE LOCK AND DEVICE STORAGE PROTECTION of a builders' vault (vault-core.js; docs/sdk-vault-mode.md § The lock;
// the owner, 2026-11-13: "Do all including #5"). Loaded ONLY for a vault started with `lock: true` — a vault without it never
// fetches this file, nor anything it imports — and on only once the PERSON turns it on, in the vault's own sheet
// (wb.vault.showLock()): first the lock (a passkey covers the page at every launch), then "Also protect this device's storage".
//
// Nothing here is new machinery: it is our own vault's (vault-loader.js vaultProtectHooks), wired for this one:
//   spaceLock.js       the lock, its sheet, the passkey ceremonies, the write-ahead switch-on, Start over
//   sdkProtect.js      the protection passkey → the 32 device-key bytes (its own user handle; the SDK's wb.protect derives the same way)
//   protectedLocal.js  this origin's localStorage sealed under that key, under OPAQUE names — every `wbvault:*` entry included;
//                      only the lock config (`vault:lock`) stays readable, since the lock screen reads it before any passkey
//   l1-worker.js       the key worker seals its own store (seal / unseal / relock / unprotect), as it does in our vaults
// What this vault adds: it waits for the unlock BEFORE it reads anything or frames the page (`boot`), and a lock that engages
// while it runs (away too long) RELOADS it — the vault's memory holds every link, so the only lock that drops them is a new
// launch behind the lock screen.
import { makeLock } from './spaceLock.js'
import { enrollProtectKey, unlockProtectKey, webauthnPasskey } from './sdkProtect.js'
import { clearLocalForBuilderReset, installProtectedLocal, protectedLocalActive, protectedLocalReady, unlockProtectedLocal, relockProtectedLocal, unprotectProtectedLocal } from './protectedLocal.js'
import { BLOCKS_SW_KEY } from './blocksPush.js'
import { idb } from './idb.js'
import { migrateIdbProtection, armIdbProtection, moveToOpaqueNames, unprotectIdb, setIdbProtection } from './idbSeal.js' // the worker's IndexedDB: what it does not seal itself (a room's read position, cnt:) moves under opaque names too

export const resetMarker = 'witbitz-builder-reset-pending'
export async function finishBuilderReset () {
  clearLocalForBuilderReset(resetMarker)
  sessionStorage.clear()
  if (typeof indexedDB === 'undefined') return false
  const results = await Promise.all(['spaces', 'wbvault-at-rest', 'wbvault-acct'].map(name => new Promise(resolve => {
    const q = indexedDB.deleteDatabase(name)
    q.onsuccess = () => resolve(true)
    q.onerror = q.onblocked = () => resolve(false)
  })))
  if (!results.every(Boolean)) return false
  localStorage.removeItem(resetMarker)
  return true
}

export const LOCK_KEY = 'vault:lock' // a name protectedLocal keeps clear (STAYS_CLEAR): read before any passkey

/**
 * @param {object} o
 * @param {string} o.brand                 the vault's name, in the sheet and on the passkeys
 * @param {() => void} o.mountUi           puts #lockscreen / #lockset in the page (screens.lockUi)
 * @param {(why?: string) => void} o.hide  hide the builder's page (the lock covers it)
 * @param {() => void} o.show
 * @param {(view: object) => void} [o.onState]  the lock's state changed (→ the page, `ev:'lock'`)
 * @param {(q: object) => Promise<boolean>} o.confirm  the vault's confirm screen (Start over)
 */
export function createVaultLock ({ brand = 'this app', mountUi, hide, show, onState, confirm, onUnprotected, beforeProtect, reload = () => location.reload() }) {
  installProtectedLocal() // idempotent: its own import already switched it on, on a protected device
  let raw = null, previews = false, workerCall = null, released = null, onReleased = null, running = false
  const passkey = webauthnPasskey({ rpName: brand, userName: brand + ' — device protection' }) // never "Witbitz Spaces" in a builder's users' keychain
  const lock = makeLock({
    storeKey: LOCK_KEY,
    appName: brand,
    // a lock that ENGAGES while the vault runs (away too long — `why` is set; the sheet's own call passes none) restarts it behind the
    // lock screen, protected or not: the vault's memory holds every link, and the page behind a mere cover kept calling (review)
    cover: { onEngage: (why) => { hide(why); if (running && why) reload() }, onRelease: () => { show(); if (onReleased) { const f = onReleased; onReleased = null; f() } } },
    onState: () => { try { onState && onState(view()) } catch { /* the page is gone */ } },
    protect: {
      enroll: async (label) => { const k = await enrollProtectKey(label, { passkey }); return { credId: k.credId, mode: k.mode, secret: k.raw } },
      unlock: async (credId) => { const c = lock.cfg(); const k = await unlockProtectKey(credId, c.protect && c.protect.mode, { passkey }); return { credId: k.credId, secret: k.raw } },
      // ON, in our vault's order: this origin's localStorage (protectedLocal moves every entry under an opaque name), the worker
      // (a key arriving meanwhile is written sealed), then the rest of the worker's IndexedDB under opaque names
      onProtect: async (secret, o) => { if (beforeProtect) await beforeProtect(); raw = secret; previews = !!(o && o.previews); if (!previews) await idb.del(BLOCKS_SW_KEY); await unlockProtectedLocal(secret, { switchOn: true }); if (workerCall) await workerCall({ t: 'seal', key: secret, previews }); await migrateIdbProtection(idb, secret) },
      onUnlock: async (secret, o) => { raw = secret; previews = !!(o && o.previews); await unlockProtectedLocal(secret); await armIdbProtection(secret); moveToOpaqueNames(idb).catch(() => {}); if (workerCall) await workerCall({ t: 'unseal', key: secret, previews }) },
      onPreviews: async (on) => { previews = !!on; if (!on) await idb.del(BLOCKS_SW_KEY); if (workerCall) await workerCall({ t: 'previews', on: previews }) },
      // a lock that engages while the vault RUNS: start again behind the lock screen (the vault's memory holds the links). At a
      // launch nothing was unlocked yet: nothing to drop, no reload.
      onLock: () => { raw = null; relockProtectedLocal(); setIdbProtection({ active: true, key: null }); if (workerCall) workerCall({ t: 'relock' }).catch(() => {}) }, // the reload follows from the cover (onEngage), at a launch none
      onUnprotect: async (secret) => { await unprotectProtectedLocal(secret); await unprotectIdb(idb, secret); if (workerCall) await workerCall({ t: 'unprotect', key: secret }); raw = null; try { if (onUnprotected) await onUnprotected() } catch { /* */ } },
      // A PROTECTED device whose passkey is gone can never open its sealed copy: this origin starts over (the Spaces live in the
      // account backup and the other devices)
      startOver: async () => {
        if (!(await confirm({ title: 'Start over on this device?', text: 'This copy can’t be unlocked anymore, so it will be cleared. Your Spaces stay in your account — restore them with your recovery code.', ok: 'Start over', cancel: 'Cancel' }).catch(() => false))) return
        localStorage.setItem(resetMarker, '1')
        reload()
      },
    },
  })
  const view = () => { const c = lock.cfg(); return { available: true, on: !!c.on, protect: !!(c.on && c.protect && c.protect.on) } }
  return {
    /** Before the vault reads anything: the lock screen at every launch while the lock is on; resolves once it is unlocked
     *  (on a protected device, once the passkey has opened this origin's storage). */
    async boot () {
      mountUi()
      lock.wireVisibility()
      if (!lock.cfg().on) { running = true; return } // turned on later in the sheet, it then engages while running
      released = new Promise((res) => { onReleased = res })
      lock.engage('launch')
      if (lock.isLocked()) await released
      if (protectedLocalActive()) await protectedLocalReady()
      running = true
    },
    /** The worker exists: from now on the hooks reach it. */
    setWorker (fn) { workerCall = fn },
    /** What a NEW worker must hear before anything else (replayed at every start / restart): the device key, on a protected device. */
    workerUnseal: () => (raw ? { t: 'unseal', key: raw, previews } : null),
    previewsAllowed: () => !view().protect || previews,
    /** The lock sheet — resolves with the lock's state when the person closes it. */
    showSheet () {
      return new Promise((resolve) => {
        lock.showSheet(); show() // the sheet is a card over the page: only a real lock hides it
        const cl = document.getElementById('lockClose')
        const done = () => { if (cl) cl.removeEventListener('click', done); resolve(view()) }
        if (cl) cl.addEventListener('click', done); else resolve(view())
      })
    },
    view,
    locked: () => lock.isLocked(),
  }
}
