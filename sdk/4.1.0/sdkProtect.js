// sdkProtect.js — wb.protect: DEVICE STORAGE PROTECTION for what an app keeps on the device (https://witbitz.chat/docs/sdk-accounts.md#protect). The owner, 2026-10-06: "Build it and then use it in spaces".
//
// The SDK hands an app JSON to persist — the sign-in session, room snapshots (they carry room keys), the Siri / A2A /
// backup state (private keys) — and an infostealer copies localStorage along with the rest of the profile. With
// protection on, every value the app writes through `save()` / `seal()` is AES-GCM ciphertext under a key a PLATFORM
// passkey derives (Windows Hello → TPM, Touch ID → Secure Enclave, Android → StrongBox): PRF, or a secret stored in the
// credential's largeBlob. That key is nowhere on disk; this object holds it in memory while unlocked and drops it on lock.
//
//   const p = wb.protect
//   p.available()                       → can this browser hold such a passkey at all
//   await p.enable({ label })           one passkey; everything already saved through save() is sealed in place
//   await p.save(name, value) / load(name) / remove(name)   a Storage (localStorage by default), sealed while on
//   await p.seal(value) / open(stored)  for a store of the app's own; both pass values through while protection is off
//   p.lock() / await p.unlock()         drop the key / a user-verified passkey assertion brings it back
//   p.autoLock(minutes)                 lock when the page comes back after being hidden longer than this
//   await p.disable()                   write what save() wrote back in the clear, forget the protection
//   p.on('locked' | 'unlocked' | 'change', cb) → unsubscribe
//
// ⚑ A LOST PASSKEY LOSES THE SEALED STATE. `enable()` refuses unless the account backup is on (wb.backup) or the app says
// `withoutBackup: true` — the backup is what brings the rooms back on a new device.
// ⚑ The Spaces app takes its passkey → key step from here too (enrollProtectKey / unlockProtectKey): one derivation, and
// the protection passkey under its OWN user handle, so it never replaces the account's recovery passkey (spacePasskey.js).
import { deriveSealRaw, importRaw, seal as sealWith, open as openWith, isSealed } from './deviceSeal.js'
import { passkeyPossible, enrollPasskey, unlockPasskey, describePasskey } from './spacePasskey.js'

export const PROTECT_CFG = 'witbitz:protect'
/** The protection passkey's own user handle (spacePasskey.js keys one handle per purpose). A shared handle REPLACED the
 *  account's recovery passkey: an authenticator keeps one credential per (site, user handle). */
export const PROTECT_USER_KEY = 'space:pkuser:protect'
const CHECK = 'witbitz-protect-check-v1' // sealed into the config at enable: an unlock knows it has the right key before it opens anything
const fail = (code, msg) => Object.assign(new Error('witbitz: ' + msg), { code })

/** The browser's WebAuthn as a passkey for protection: { possible, enroll(label) → { credId, secret, mode },
 *  unlock(credId) → { credId, secret, mode, secrets } }. `rpId` / `rpName` default to this page's host. */
export function webauthnPasskey ({ rpId, rpName, userName = 'Device protection', userKey = PROTECT_USER_KEY } = {}) {
  return {
    // A SECURE CONTEXT, not only https: a builder developing on http://localhost has WebAuthn too (passkeyPossible() asks https).
    possible: () => { try { return passkeyPossible() || !!(typeof window !== 'undefined' && window.isSecureContext && window.PublicKeyCredential && navigator.credentials && navigator.credentials.create) } catch { return false } },
    enroll: (label) => enrollPasskey(label, rpId, { rpName: rpName || (typeof location !== 'undefined' ? location.hostname : ''), userName, userKey }),
    unlock: (credId) => unlockPasskey(credId, rpId),
  }
}

/** The secret an assertion answered for this mode — a credential can answer both (a PRF and a largeBlob), and only the one
 *  protection was enabled with opens what it sealed. */
const secretsOf = (r, mode) => {
  const all = (r && Array.isArray(r.secrets) && r.secrets.length ? r.secrets : (r && r.secret ? [{ secret: r.secret, mode: r.mode }] : []))
  return [...all.filter((s) => s.mode === mode), ...all.filter((s) => s.mode !== mode)]
}

/** THE SHARED STEP, for an app with stores of its own (the Spaces app): a new protection passkey → { credId, mode, raw },
 *  `raw` being the 32 device-key bytes (deviceSeal.importRaw makes the key). */
export async function enrollProtectKey (label, { rpId, passkey } = {}) {
  const pk = passkey || webauthnPasskey({ rpId, rpName: 'Witbitz Spaces', userName: describePasskey('Spaces device protection') }) // purpose · device · date in the keychain
  const r = await pk.enroll(label)
  if (!r || !r.secret) throw fail('prf_unsupported', 'this passkey cannot hold a key')
  return { credId: r.credId, mode: r.mode || 'prf', raw: await deriveSealRaw(r.secret) }
}
/** …and an unlock with it → { credId, mode, raw }. `mode` picks the secret protection was enabled with. */
export async function unlockProtectKey (credId, mode, { rpId, passkey } = {}) {
  const pk = passkey || webauthnPasskey({ rpId })
  const r = await pk.unlock(credId)
  const [s] = secretsOf(r, mode)
  if (!s) throw fail('wrong_passkey', 'the passkey answered no key')
  return { credId: r.credId || credId, mode: s.mode || mode, raw: await deriveSealRaw(s.secret) }
}

export class Protect {
  /** @param {object} o { storage?, storeKey?, passkey?, backup?, rpId?, rpName?, doc?, now? } — `storage` is a Storage
   *  (localStorage by default), `backup` the account backup (wb.backup), `passkey` replaces WebAuthn (tests, a native shell). */
  constructor ({ storage, storeKey = PROTECT_CFG, passkey, backup = null, rpId, rpName, doc, now } = {}) {
    const hidden = (k, v) => Object.defineProperty(this, k, { value: v, writable: true, enumerable: false, configurable: true })
    hidden('_storage', storage || (typeof localStorage !== 'undefined' ? localStorage : null))
    hidden('_storeKey', storeKey)
    hidden('_pk', passkey || webauthnPasskey({ rpId, rpName }))
    hidden('_backup', backup)
    hidden('_doc', doc || (typeof document !== 'undefined' ? document : null))
    hidden('_now', typeof now === 'function' ? now : () => Date.now())
    hidden('_key', null) // the AES-GCM key — in memory only, and only while unlocked
    hidden('_ls', { locked: new Set(), unlocked: new Set(), change: new Set() })
    hidden('_away', null)
    if (this._cfg().auto) this._watch()
  }

  _cfg () { try { return JSON.parse((this._storage && this._storage.getItem(this._storeKey)) || 'null') || {} } catch { return {} } }
  _setCfg (c) { if (!this._storage) return; if (c) this._storage.setItem(this._storeKey, JSON.stringify(c)); else this._storage.removeItem(this._storeKey) }
  _emit (ev) { for (const f of [...this._ls[ev], ...(ev === 'change' ? [] : this._ls.change)]) { try { f(this.state) } catch { /* a listener must not break the lock */ } } }

  /** { on, locked, mode, auto } — `locked` is true while protection is on and the key is not in memory. */
  get state () { const c = this._cfg(); return { on: !!c.on, locked: !!c.on && !this._key, mode: c.on ? c.mode || null : null, auto: +c.auto || 0 } }
  toJSON () { return { protect: this.state } }

  /** Can this browser hold a protection passkey (WebAuthn on https)? PRF / largeBlob support is only known at enable. */
  available () { try { return !!this._pk.possible() } catch { return false } }

  on (ev, cb) { const s = this._ls[ev]; if (!s || typeof cb !== 'function') throw fail('bad_event', 'protect events are locked, unlocked and change'); s.add(cb); return () => s.delete(cb) }

  async enable ({ label = '', withoutBackup = false } = {}) {
    if (this._cfg().on) throw fail('already_enabled', 'protection is already on for this app on this device')
    if (!this.available()) throw fail('unavailable', 'this browser cannot hold a passkey for storage protection')
    // No backup to check (a Protect made before its client, or alone) is no backup: never a silently skipped guard (code review).
    if (!withoutBackup && !(this._backup && this._backup.enabled)) throw fail('backup_required', 'turn on the account backup (wb.backup) first: a lost passkey would lose everything sealed under it (or pass withoutBackup: true)')
    const r = await this._pk.enroll(label || 'Device protection')
    if (!r || !r.secret) throw fail('prf_unsupported', 'this passkey cannot hold a key')
    const mode = r.mode || 'prf'
    const key = await importRaw(await deriveSealRaw(r.secret))
    // pass 7, F#7: the check is sealed BEFORE the config is read — a name save() added while it was awaited (the config read
    // before it) was dropped from `keys` by the write below, and its value stayed clear for good
    const check = await sealWith(key, CHECK)
    const prev = this._cfg()
    // RECORD THE SWITCH FIRST, the key held — then seal what was saved while off. A crash in between leaves clear values,
    // which read as they are and are sealed at the next unlock (_sealPending). The other order (seal, then record) left
    // sealed values behind an "off" config with no passkey recorded: unopenable for good (code review, 2026-10-06).
    this._key = key
    this._setCfg({ on: true, credId: r.credId, mode, at: this._now(), check, keys: Array.isArray(prev.keys) ? prev.keys : [], auto: +prev.auto || 0 })
    await this._sealPending()
    this._emit('unlocked')
    return this.state
  }

  async unlock () {
    const c = this._cfg()
    if (!c.on) throw fail('not_enabled', 'protection is off')
    if (this._key) return this.state
    const r = await this._pk.unlock(c.credId)
    for (const s of secretsOf(r, c.mode)) {
      let key = null
      try { key = await importRaw(await deriveSealRaw(s.secret)); if (await openWith(key, c.check) !== CHECK) key = null } catch { key = null }
      if (key) { this._key = key; try { await this._sealPending() } catch { /* a full disk must not cost the unlock */ } this._emit('unlocked'); return this.state }
    }
    throw fail('wrong_passkey', 'that passkey does not open this device\'s protected storage')
  }

  /** Seal every value save() wrote that is still clear — what an interrupted enable() left behind. */
  async _sealPending () {
    if (!this._key) return
    for (const k of Array.isArray(this._cfg().keys) ? this._cfg().keys : []) { const v = this._read(k); if (v !== undefined && !isSealed(v)) this._write(k, await sealWith(this._key, v)) }
  }

  lock () { const was = !!this._key; this._key = null; if (was && this._cfg().on) this._emit('locked'); return this.state }

  // ONE AT A TIME (state machines pass 7, F#8): disable() opens and rewrites every saved value across awaits, and a save() that
  // finished in between left a sealed value behind the "off" it then wrote — load() deletes those. The two run in order.
  _serial (fn) { const run = (this._chain || Promise.resolve()).then(fn, fn); this._chain = run.catch(() => {}); return run }

  async disable () { return this._serial(() => this._disable()) }
  async _disable () {
    const c = this._cfg()
    if (!c.on) return this.state
    if (!this._key) await this.unlock() // the passkey confirms it, and its key writes the values back
    const key = this._key
    // a value sealed by an EARLIER setup (another passkey) never opens: dropped, not a throw that leaves protection half off (sync sweep backlog P3)
    for (const k of Array.isArray(c.keys) ? c.keys : []) { const v = this._read(k); if (isSealed(v)) { let clear; try { clear = await openWith(key, v) } catch { this._storage.removeItem(k); continue } this._write(k, clear) } }
    this._key = null
    this._setCfg(c.auto || (c.keys && c.keys.length) ? { on: false, keys: c.keys || [], auto: +c.auto || 0 } : null)
    this._emit('change')
    return this.state
  }

  /** Seal a value for a store of the app's own — the value itself while protection is off. Refuses while locked. */
  async seal (value) {
    if (!this._cfg().on) return value
    if (!this._key) throw fail('locked', 'protected storage is locked — wb.protect.unlock() first')
    return sealWith(this._key, value)
  }
  /** Open what seal() returned — a clear value passes through. Refuses a sealed one while locked. */
  async open (stored) {
    if (!isSealed(stored)) return stored
    if (!this._key) throw fail('locked', 'protected storage is locked — wb.protect.unlock() first')
    return openWith(this._key, stored)
  }

  _read (name) { const s = this._storage && this._storage.getItem(name); if (s == null) return undefined; try { return JSON.parse(s) } catch { return s } }
  _write (name, v) { this._storage.setItem(name, JSON.stringify(v)) }
  /** Persist `value` under `name` in the Storage — sealed while protection is on, and resealed / written back clear when it changes. */
  async save (name, value) { return this._serial(() => this._save(name, value)) }
  async _save (name, value) {
    if (!this._storage) throw fail('no_storage', 'no Storage to save into (pass storage to wb.protect)')
    const c = this._cfg()
    if (c.on && !this._key) throw fail('locked', 'protected storage is locked — wb.protect.unlock() first')
    const keys = Array.isArray(c.keys) ? c.keys : []
    if (!keys.includes(name)) this._setCfg({ ...c, keys: [...keys, String(name)] })
    if (!c.on) { this._write(name, value); return }
    const sealed = await sealWith(this._key, value)
    // pass 7, F#8: disable() ran while it was sealed — a sealed value behind an "off" config is what load() deletes; write it clear
    this._write(name, this._cfg().on ? sealed : value)
  }
  /** The value saved under `name` (undefined if none). Refuses a sealed one while locked. */
  async load (name) {
    const v = this._read(name)
    if (v === undefined) return undefined
    if (!isSealed(v)) return v
    // sealed while protection is OFF, or sealed under another key: an earlier setup's leftover, which nothing can open — it
    // reads as absent and goes, never a throw (sync sweep backlog P3). Sealed under THIS key while locked still refuses.
    if (!this._cfg().on) { this._storage.removeItem(name); return undefined }
    if (!this._key) throw fail('locked', 'protected storage is locked — wb.protect.unlock() first')
    try { return await openWith(this._key, v) } catch { this._storage.removeItem(name); return undefined }
  }
  remove (name) {
    if (this._storage) this._storage.removeItem(name)
    const c = this._cfg(); if (Array.isArray(c.keys) && c.keys.includes(name)) this._setCfg({ ...c, keys: c.keys.filter((k) => k !== name) })
  }

  /** Lock when the page returns after being hidden longer than `minutes` (0 = only an explicit lock() or a new launch). */
  autoLock (minutes) {
    const m = Math.max(0, +minutes || 0)
    const c = this._cfg(); this._setCfg({ ...c, auto: m, keys: c.keys || [] })
    if (m) this._watch()
    return this.state
  }
  _watch () {
    if (this._away || !this._doc || !this._doc.addEventListener) return
    this._away = { at: 0 }
    this._doc.addEventListener('visibilitychange', () => {
      const auto = +this._cfg().auto || 0
      if (this._doc.hidden) { this._away.at = this._now(); return }
      if (auto && this._away.at && this._now() - this._away.at > auto * 60000) this.lock()
      this._away.at = 0
    })
  }
}
