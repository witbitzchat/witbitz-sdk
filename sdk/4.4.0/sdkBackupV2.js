// sdkBackupV2.js — A BUILDER'S ACCOUNT ON THE NEW ACCOUNT SERVICE (account recovery v2, docs/account-recovery-protocol.md), run
// in the builder's VAULT (vault-core.js), where the master never leaves. The owner, 2026-11-16: "Yes. Do the sdk." — the SDK
// follows our own two apps (2026-11-15): a NEW account made in a vault that names its tenant starts on the new service; an
// account already on the old backup store stays there; a restore asks the new service first, then the old store.
//
// What it reuses: the reviewed flows of acctV2App.js (makeAcctV2: the first code shown and kept before its activation, the
// pending-code reconcile, restore, the status check, sign out the other devices, a new code, delete) over acctV2Client.js. What
// is the SDK's: where the state lives (the backup state's `v2`, persisted by the vault and sealed on its disk), the device key
// (the vault origin's IndexedDB, one per account — `v2.dk`), and the record it backs up (the SDK's account record).
//
// TWO MASTERS. `state.master` stays the account's IDENTITY — its index room, usage and erase keys derive from it (sdkAccount.js,
// sdkErase.js) — and a new recovery code does not change it. `state.v2.bm` is the BACKUP master the service's two objects are
// sealed under (backupVault.js), replaced by every new code. The backup carries the identity (`sdkMaster`), so a restore brings
// both back.
//
// THE TENANT names the app on every request (`x-acct-tenant`): the builder's accounts are its own on the service, and the service
// believes it only from one of the tenant's declared AND proven origins (control-plane/src/lib/acct/appScope.mjs) — so the
// VAULT's origin must be one. A vault whose origin the service refuses (403 tenant_origin) before anything is made goes on with the
// old store, as before this release.
// Security keys use the shared account-service ceremonies. To add a second device, restore with the
// recovery code. Legacy migration and email-move flows reuse the reviewed account-service protocol below.
import { makeAcctV2, STATE_KEY, ERASE_KEY, MOVE_KEY, RESET_KEY } from './acctV2App.js'
import { canonicalAddress } from './acctV2Client.js'
import { refusedAsRevoked, statusDue } from './acctV2Check.js'
import { codeSecret, newRecoveryCode, seal, unseal } from './recovery.js'
import { backupLocation, wrapperLocation, newMasterSecret, sealWrapper, openWrapper } from './backupVault.js'
import { ensureKeyRecord, newKeyRecord } from './deviceKeyCore.js'
import { recordFromRooms, roomsOfRecord, tombOfRecord, vaultOwner, SDK_APP } from './accountRecord.js'
import { applyPlan } from './backupRecord.js'
import { indexRoomOf, mergeIndex } from './sdkAccount.js'
import { appStoreKey, sealDoc, openDoc } from './accountSeal.js' // a push address sealed under the backup master (as acctV2VaultWiring.js)
import { v2Of, halfMade, keptPrevMasters } from './sdkBackup.js'
import { unb64u } from './acctV2Wire.js'
import { browserKeys } from './acctV2WebAuthn.js'
import { tokenClaims, tokenApp } from './accountScope.js'
import { GOOGLE_CLIENT_ID } from './config.js'
import { signRestoreChallenge, spkNonce } from './entrySig.js'

export const TENANT_ID = /^t_[0-9a-f]{32}$/
/** The account service's address — the same API domain the default Space endpoint uses (acctV2Switch.js PROD_SERVICE). */
export const ACCOUNT_SERVICE = 'https://api.witbitz.chat/v1'

/** A compatible, fresh vault sign-in can prove the address without a second email code. */
export async function restoreSignInProof(session, { action, email, origin, base = ACCOUNT_SERVICE }) {
  if (base !== ACCOUNT_SERVICE || !action || !session?.sign?.priv || !session.sign.pub || !email) return null
  const claims = tokenClaims(session.idToken), address = canonicalAddress(email)
  if (!address || address !== canonicalAddress(session.email) || address !== canonicalAddress(claims?.email) || tokenApp(claims) !== null) return null
  const now = Date.now() / 1000
  if (!(claims.exp > now && claims.iat > now - 295 && claims.iat <= now + 60)) return null
  if (claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com') {
    const domain = address.split('@')[1]
    if (claims.aud !== GOOGLE_CLIENT_ID || claims.email_verified !== true) return null
    if (!['gmail.com', 'googlemail.com'].includes(domain) && claims.hd !== domain) return null
  } else if (claims.iss !== origin && !(origin === 'https://spaces.witbitz.chat' && claims.iss === 'https://witbitz-vault-prod.pages.dev')) return null
  if (claims.nonce !== await spkNonce(session.sign.pub)) return null
  return { signIn: { idToken: session.idToken, spk: session.sign.pub, sig: await signRestoreChallenge(session.sign.priv, action) } }
}

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const utf8 = (s) => new TextEncoder().encode(s)
const fail = (code, msg, extra = {}) => Object.assign(new Error('witbitz: ' + msg), { code, ...extra })
const rand = (n) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[^A-Za-z0-9]/g, '').slice(0, n)
const is32 = (s) => { try { return typeof s === 'string' && unb64(s).length === 32 } catch { return false } }

/** This browser's name on the service ("Chrome on iPhone") — the words of our vault's (acctV2VaultWiring.js vaultDeviceLabel). */
export function deviceLabel(ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /(Mac OS X|Macintosh)/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  const br = /Edg\//.test(ua) ? 'Edge' : /(OPR\/|Opera)/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return br + ' on ' + os
}

/** Where a vault keeps its device keys: raw values (a non-extractable CryptoKey is kept AS a key, never as bytes) in this origin's
 *  IndexedDB `name`. A failed read throws — the caller never mistakes it for "no key" (a new key would be another device). */
export function idbKeyStore(name = 'wbvault-acct', idb = (typeof indexedDB !== 'undefined' ? indexedDB : null)) {
  const open = () => new Promise((res, rej) => { if (!idb) return rej(new Error('no IndexedDB')); const r = idb.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const run = async (mode, fn) => {
    const db = await open()
    try { return await new Promise((res, rej) => { const t = db.transaction('k', mode); const q = fn(t.objectStore('k')); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) }) } finally { try { db.close() } catch { /* */ } }
  }
  return {
    get: async (k) => (await run('readonly', (s) => s.get(k))) ?? null,
    set: async (k, v) => { await run('readwrite', (s) => s.put(v, k)) },
    del: async (k) => { await run('readwrite', (s) => s.delete(k)) },
    clear: async () => { await run('readwrite', (s) => s.clear()) },
  }
}

/** THE RESTORE SCREEN, unchanged for the new service (vault-screens.js restore): it calls `restore({ code, email? })` and, on
 *  `email_code_required` with a `ticket`, asks the person for the mailed code and calls again with `{ code, ticket, emailCode }`.
 *  The new service asks for the mailed code in the MIDDLE of its flow (acctV2Client.restore) — so the flow is held there: the
 *  first call answers `email_code_required` (a `v2-` ticket) as soon as the code is mailed, and the second call hands the code in
 *  and waits for the flow's end. `run(q, getCode)` → the restore. A builder's own restore screen works as it did. */
export function restoreBridge(run, { waitMs = 15 * 60_000 } = {}) {
  let held = null // { ticket, give(code), outcome: Promise }
  return async (q = {}) => {
    if (held && q.ticket && q.ticket === held.ticket && q.emailCode) {
      const h = held; held = null
      h.give(String(q.emailCode).trim())
      const x = await h.outcome
      if (x.e) throw x.e
      return x.r
    }
    held = null
    let asked, give, timer
    const askedP = new Promise((res) => { asked = res })
    const getCode = () => new Promise((res, rej) => { give = res; timer = setTimeout(() => rej(fail('cancelled', 'no code was entered')), waitMs); if (timer && timer.unref) timer.unref(); asked() })
    const outcome = Promise.resolve().then(() => run({ ...q, ...(q.ticket && /^v2-/.test(q.ticket) ? { ticket: undefined, emailCode: undefined } : {}) }, getCode)).then((r) => ({ r }), (e) => ({ e }))
    const first = await Promise.race([outcome.then((x) => ({ x })), askedP.then(() => null)])
    if (first) { clearTimeout(timer); if (first.x.e) throw first.x.e; return first.x.r }
    const ticket = 'v2-' + rand(12)
    held = { ticket, give: (c) => { clearTimeout(timer); give(c) }, outcome }
    throw Object.assign(fail('email_code_required', 'we emailed a code — call again with { code, ticket, emailCode }'), { ticket })
  }
}

/**
 * The new account service for a builder's vault → the object sdkBackup.js consults (`backup._v2`), or null when the vault names
 * no tenant (no header would make its accounts the regular Witbitz app's — never).
 * @param {object} o { tenant, base?, fetch, keyStore: { get(k), set(k, v) } (raw IndexedDB values), label?() → this device's name,
 *   persistNow(state) → Promise<boolean> (the state is on disk, read back — a new code is kept BEFORE its activation),
 *   onRevoked() (a request was refused as signed out: run the status check now), afterSignOut?(address) (the other devices were just
 *   signed out: the room pass renews at once — vault-core.js) }
 */
export function accountService({ tenant, base = ACCOUNT_SERVICE, fetch: f = (...a) => globalThis.fetch(...a), keyStore, label = () => deviceLabel(), persistNow, legacyRecovery, onRevoked = () => {}, afterSignOut = null, pushEndpoint = null, withdrawPush = null } = {}) {
  if (!TENANT_ID.test(String(tenant || '')) || !base || !keyStore) return null
  const headers = { 'x-acct-tenant': tenant }
  const fetchWatched = async (...args) => {
    const r = await f(...args)
    if (r && r.status === 403 && typeof r.clone === 'function') r.clone().json().then((j) => { if (refusedAsRevoked(r.status, j)) onRevoked() }).catch(() => {})
    return r
  }
  // one device key PER ACCOUNT in this vault (a vault keeps one backup per signed-in person): `devkey:v1|<dk>`
  let keyEpoch = 0
  const keysOf = (dk) => {
    const epoch = keyEpoch
    return { get: (k) => keyStore.get(k + '|' + dk), set: async (k, v) => {
      if (epoch !== keyEpoch) throw fail('account_changed', 'this device was signed out while its key was being made')
      await keyStore.set(k + '|' + dk, v)
      if (epoch !== keyEpoch && typeof keyStore.del === 'function') await keyStore.del(k + '|' + dk)
    } }
  }

  /** The SDK's account record for state `s` (rooms, tombstones, email, invite key, index pointer) + the identity master. */
  async function recordOf(s, rooms = s.rooms) {
    return { ...recordFromRooms({ rooms, tomb: s.tomb, email: s.email, inviteKey: s.invite, indexRoom: await indexRoomOf(s.master) }), sdkMaster: s.master }
  }
  /** The rooms another device wrote into the head, kept beside this device's (never one this device forgot). */
  async function recordOverHead(s, key, head) {
    const remote = head?.blob ? await openRecord(key, head.blob) : null
    if (!remote) throw fail('unopenable', 'the current backup could not be opened')
    const { rooms, tomb } = mergeIndex(s, { rooms: roomsOfRecord(remote), tomb: tombOfRecord(remote) })
    return recordOf({ ...s, tomb }, rooms)
  }
  const openRecord = async (key, sealed) => { try { const d = await unseal(key, sealed); return vaultOwner(d) === 'sdk' ? d : null } catch { return null } }

  /** makeAcctV2 over backup state `s` (its `v2` holds what the flows keep). `hooks`: { applyRestored?, wipe?, changed?, current? }
   *  — `current()` false: the vault moved to another account (or state) meanwhile, and a new code is NOT kept (no activation is sent). */
  const memOf = new WeakMap()
  function client(s, hooks = {}) {
    if (!s.v2) s.v2 = {}
    if (!s.v2.dk) s.v2.dk = rand(16)
    // per ACCOUNT STATE for the session, not per call: syncPush's "already sent" mark lives here — a map made fresh each call resent
    // the device's push record on every status check (and on every change, Codex 11-16 #2)
    const mem = memOf.get(s) || new Map(); memOf.set(s, mem)
    const fields = new Map([[STATE_KEY, 'svc'], [ERASE_KEY, 'erase'], [MOVE_KEY, 'emailMove'], [RESET_KEY, 'reset']])
    const storage = {
      getItem(k) {
        if (!fields.has(k)) return mem.get(k) ?? null
        const value = s.v2[fields.get(k)]
        return value == null ? null : k === STATE_KEY ? JSON.stringify(value) : value
      },
      setItem(k, v) {
        if (!fields.has(k)) { mem.set(k, String(v)); return }
        s.v2[fields.get(k)] = k === STATE_KEY ? v2Of({ svc: JSON.parse(v) })?.svc : String(v)
        hooks.changed?.()
      },
      removeItem(k) {
        if (!fields.has(k)) { mem.delete(k); return }
        // Keep this device's request until its new account and first code are both durable.
        if (k === RESET_KEY && hooks.finishingReset) return
        delete s.v2[fields.get(k)]
        hooks.changed?.()
      },
      flushed: async () => { if (typeof persistNow === 'function' && !(await persistNow(s))) throw fail('save_failed', 'the deletion request could not be kept on this device') },
    }
    const ks = keysOf(s.v2.dk)
    let rec = null
    const deviceKey = async () => { rec = rec || await ensureKeyRecord(ks); return rec && rec.priv && rec.spk ? { priv: rec.priv, pub: rec.pub, spk: rec.spk } : null }
    async function sealed(payload, newCode, newMaster) {
      const cs = codeSecret(newCode), loc = await backupLocation(newMaster)
      return { newCode, newMaster, backupId: loc.id, wrapperId: (await wrapperLocation(cs)).id, backupBlob: utf8(await seal(loc.key, payload)), wrapperBlob: utf8(await sealWrapper(cs, newMaster)) }
    }
    return makeAcctV2({
      base, fetch: fetchWatched, headers, storage,
      canApplyStatus: hooks.canApplyStatus,
      deviceKey,
      newDeviceKey: async () => { rec = await newKeyRecord(ks); return rec },
      vault: () => (s.v2.bm || s.v2.pending ? { ...(s.v2.bm ? { master: s.v2.bm, ...(hooks.legacy ? { code: hooks.legacy.code } : {}) } : {}), ...(s.v2.pending ? { pending: { ...s.v2.pending } } : {}) } : null),
      codeBytesOf: codeSecret,
      beforeLegacyCommit: hooks.beforeLegacyCommit,
      legacyAborted: hooks.legacyAborted,
      backupIdOf: async (m) => (await backupLocation(m)).id,
      wrapperIdOf: async (c) => (await wrapperLocation(c)).id,
      acctKey: () => hooks.legacy?.acctKey || null,
      deviceKeys: () => [],
      wipe: async () => { if (hooks.wipe) await hooks.wipe() },
      label: () => { try { return String(label() || 'This device').slice(0, 64) } catch { return 'This device' } },
      keys: browserKeys(),
      prepareSetup: async () => sealed(await recordOf(s), newRecoveryCode(), newMasterSecret()),
      // § 8.2: merged with the current head (another device's rooms kept), sealed under the NEW master
      prepareRotation: async (readHead) => {
        const oldLoc = await backupLocation(unb64(s.v2.bm))
        const head = await readHead(oldLoc.id)
        return sealed(await recordOverHead(s, oldLoc.key, head), newRecoveryCode(), newMasterSecret())
      },
      openWrapper: (codeBytes, blob) => openWrapper(codeBytes, blob),
      openBackup: async (m, blob) => openRecord((await backupLocation(m)).key, blob),
      applyRestored: (r) => hooks.applyRestored(r),
      // R2-03: the new code's master is ON DISK (read back) before its activation is sent — the code itself is never kept
      holdPending: async (prep) => {
        if (hooks.current && !hooks.current()) return false // review 2026-11-16: never written under another account's entry
        s.v2.pending = { master: b64(prep.newMaster), rid: prep.rid || null, at: Date.now() }
        let kept = false
        try { kept = persistNow ? (await persistNow(JSON.parse(JSON.stringify(s)))) === true : false } catch { kept = false }
        if (!kept) delete s.v2.pending // not kept → no activation is sent (acctV2App keepPending): nothing is on its way
        return kept
      },
      dropPending: () => { delete s.v2.pending; if (hooks.changed) hooks.changed() },
      adoptRotation: (prep) => {
        // the master this replaces is KEPT a while (Codex sweep 2026-11-16 #1): the devices this new code signs out registered their
        // push addresses under it, and prunePush must still open them to take them off every Space (as our vault's prevMasters)
        if (s.v2.bm) s.v2.pb = keptPrevMasters([{ m: s.v2.bm, at: Date.now() }, ...(s.v2.pb || [])])
        s.v2.bm = b64(prep.newMaster instanceof Uint8Array ? prep.newMaster : unb64(prep.newMaster))
        delete s.v2.pending
        if (hooks.changed) hooks.changed()
      },
      ...pushDeps(s),
    })
  }
  // § 8.8 — ONLY in a vault that sends notifications (vault-core.js `push: true`; sync sweep 11-16 #14, as our vault's
  // acctV2VaultWiring.js): this device's push address registered with the service, sealed under the BACKUP master, so a device
  // still signed in can take a signed-out one's address off every Space (withdrawPush) — a vault without push passes none of these.
  const pushKey = async (s) => { if (!s.v2 || !s.v2.bm) throw fail('no_master', 'no backup master'); return appStoreKey(unb64(s.v2.bm)) }
  const pushDeps = (s) => (typeof pushEndpoint !== 'function' || typeof withdrawPush !== 'function' ? {} : {
    sealId: async () => (s.v2 && s.v2.bm ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('push-seal|' + s.v2.bm)))].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('') : ''),
    // undefined = NOT KNOWN YET (the subscription is still loading — Codex sweep 2026-11-16 #2): syncPush then sends nothing
    pushEndpoint: async () => { try { const e = await pushEndpoint(); return e === undefined ? undefined : (e || null) } catch { return undefined } },
    sealPush: async (endpoint) => { const d = await sealDoc(await pushKey(s), { e: endpoint }); return (d.z ? '1.' : '0.') + d.s },
    openPush: async (sealed) => { // the current master, then the kept previous ones (#1)
      const [z, x] = String(sealed).split('.')
      for (const m of [s.v2 && s.v2.bm, ...keptPrevMasters(s.v2 && s.v2.pb).map((p) => p.m)].filter(Boolean)) { try { return (await openDoc(await appStoreKey(unb64(m)), { v: 1, z: z === '1', s: x })).e || null } catch { /* another master */ } }
      return null
    },
    withdrawPush: async (endpoints) => !!(await withdrawPush(endpoints)),
  })

  // a flow that may hold a new code (a first one, a new one) is running: the status check waits — its reconcile would close the
  // session whose activation is on its way (review 2026-11-16)
  let busy = 0
  const busyWhile = async (fn) => { busy++; try { return await fn() } finally { busy-- } }

  // ── what sdkBackup.js asks ─────────────────────────────────────────────────────────────────────────────────────────
  const moveDates = p => p ? { ready_at: p.ready_at, expires: p.expires } : null
  const resetState = b => {
    if (!b._s?.v2?.resetDraft) throw fail('no_reset', 'this device has no pending email move')
    return b._s
  }
  async function withReset(b, state, fn) {
    if (busy || b._isEnabling()) throw fail('busy', 'an account operation is already in progress')
    const current = () => {
      if (b._s !== state) throw fail('account_changed', 'the account changed during the email move')
    }
    const save = async () => {
      current()
      if (typeof persistNow !== 'function' || !(await persistNow(structuredClone(state)))) {
        throw fail('save_failed', 'this device could not keep the pending move')
      }
      current()
    }
    const screen = ask => async (...args) => {
      current()
      if (typeof ask !== 'function') throw fail('no_screen', 'the email move needs a vault screen')
      const answer = await ask(...args)
      current()
      return answer
    }
    return busyWhile(() => fn({ current, save, screen, changed: () => { current(); b._changed() } }))
  }
  const svc = {
    async beginEmailMove(b, { email, getCode } = {}) {
      const address = canonicalAddress(email || b._email())
      if (!address) throw fail('email_required', 'enter the email address to move')
      if (b._s && (!b._s.v2?.resetDraft || b._s.email !== address)) throw fail('already_enabled', 'this device already holds an account or another email move')
      if (busy || b._isEnabling()) throw fail('busy', 'an account operation is already in progress')
      const s = b._s || { v: 1, format: 'account', master: b64(newMasterSecret()), email: address, rooms: [], v2: { resetDraft: true } }
      b._s = s
      return withReset(b, s, async ({ save, screen, changed }) => {
        const a = client(s, { changed })
        await save()
        const existing = a.pendingReset()
        if (existing) return moveDates(existing)
        try {
          const pending = await a.resetBegin({ address, getCode: screen(getCode) })
          await save()
          return moveDates(pending)
        } catch (error) {
          if (!a.pendingReset() && ['feature_unavailable', 'tenant_origin', 'bad_tenant', 'cancelled', 'no_screen', 'email_code_wrong'].includes(error.code)) {
            if (b._s === s) b._drop()
          }
          throw error
        }
      })
    },
    async pendingEmailMove(b) {
      if (!b._s?.v2?.resetDraft) return null
      const s = b._s
      return withReset(b, s, async ({ current, changed }) => {
        const a = client(s, { changed })
        if (s.v2.svc) return moveDates(a.pendingReset())
        if (!a.pendingReset()) return null
        const p = await a.refreshReset()
        current()
        if (!p && !a.pendingReset()) b._drop()
        return moveDates(p || a.pendingReset())
      })
    },
    async finishEmailMove(b, { getCode, showCode } = {}) {
      const s = resetState(b)
      if (typeof showCode !== 'function') throw fail('no_screen', 'the new recovery code needs a vault screen')
      return withReset(b, s, async ({ current, save, screen, changed }) => {
        const a = client(s, { current: () => b._s === s, changed, finishingReset: true })
        if (!s.v2.bm || s.v2.svc?.setup === 'pending') {
          await a.resetFinish({ getCode: screen(getCode), showCode: screen(showCode) })
        }
        await save()
        current()
        const reset = s.v2.reset
        delete s.v2.resetDraft
        delete s.v2.reset
        try { await save() } catch (error) {
          s.v2.resetDraft = true
          s.v2.reset = reset
          throw error
        }
        b._changed(); b._started()
        return { enabled: true }
      })
    },
    async cancelPendingEmailMove(b, { getCode } = {}) {
      const s = resetState(b)
      if (s.v2.svc) throw fail('already_migrated', 'finish the first recovery code for the new account')
      return withReset(b, s, async ({ current, changed, screen }) => {
        const a = client(s, { changed })
        if (a.pendingReset()) {
          try { await a.resetCancel({ getCode: screen(getCode) }) }
          catch (e) { if (!['reset_ended', 'no_reset'].includes(e.code)) throw e }
        }
        current(); b._drop()
        return { cancelled: true }
      })
    },
    get busy() { return busy > 0 },
    tenant, base,
    async migrate(b, { code, getCode, silent = false } = {}) {
      const s = b._s
      if (!s || !b.enabled) throw fail('not_enabled', 'restore this legacy account before moving it')
      if (s.v2 && s.v2.svc && !s.v2.moving) throw fail('already_migrated', 'this account already uses the account service')
      if (b._migrating || busy) throw fail('busy', 'another account operation is running')
      if (b.format !== 'account') throw fail('legacy_format', 'upgrade this backup to the account format before moving it')
      if (typeof persistNow !== 'function' || typeof b._afterMigration !== 'function') throw fail('migration_unavailable', 'migration needs durable storage and the account index')
      if (s.v2?.moving) silent = s.v2.moveMode === 'signed' || s.v2.svc?.silent === 'moved'
      const current = () => { if (b._s !== s) throw fail('account_changed', 'the account changed during migration') }
      b._migrating = true
      clearTimeout(b._timer); b._timer = null
      return busyWhile(async () => {
        try {
          if (!(s.v2 && s.v2.svc)) {
            let legacy
            if (silent) {
              if (!legacyRecovery || !s.email || canonicalAddress(b._email()) !== canonicalAddress(s.email)) throw fail('silent_unavailable', 'a signed-in eligible legacy account is required')
              legacy = await legacyRecovery(s.email)
              current()
              if (!legacy?.code || !legacy.acctKey?.priv) throw fail('silent_unavailable', 'this vault has no registered legacy signing key or recovery code')
              code = legacy.code
            }
            try { codeSecret(code) } catch { throw fail('code_required', 'enter this account’s recovery code to move it') }
            if (!silent && typeof getCode !== 'function') throw fail('no_screen', 'migration needs an emailed code')
            const address = canonicalAddress(s.email || b._email())
            if (!address) throw fail('email_required', 'this legacy account needs its recovery email')
            const a = client(s, { legacy, changed: () => { current(); b._changed() }, legacyAborted: () => {
              current(); delete s.v2; b._changed()
            }, beforeLegacyCommit: async ({ codeBytes, params, read }) => {
              current()
              const wrapper = await read(params.wrapper_id), backup = await read(params.backup_id)
              current()
              const master = await openWrapper(codeBytes, new TextDecoder().decode(unb64u(wrapper.blob)))
              if (!master || b64(master) !== s.master) throw fail('wrong_account', 'that code does not open this account')
              const payload = await openRecord((await backupLocation(master)).key, new TextDecoder().decode(unb64u(backup.blob)))
              if (!payload) throw fail('unopenable', 'the legacy backup cannot be opened as an SDK account')
              current()
            } })
            // This device key and backup master must survive a lost commit reply. The recovery code is never stored.
            s.v2.bm = s.master; s.v2.moving = true; if (silent) s.v2.moveMode = 'signed'
            if (!(await svc.deviceSpk(b))) throw fail('no_device_key', 'the migration device key could not be kept')
            if (!(await persistNow(s))) throw fail('save_failed', 'the migration state could not be kept on this device')
            current()
            if (silent) await a.silentMove({ address })
            else await a.migrate({ address, typedCode: code, getCode: async () => { current(); const c = await getCode(); current(); return c } })
            current(); b._changed()
            if (!(await persistNow(s))) throw fail('save_failed', 'the migrated account state could not be kept')
          }
          current()
          await b._afterMigration({ signed: silent })
          current()
          await svc.write(b, s)
          current()
          delete s.v2.moving
          if (!(await persistNow(s))) { s.v2.moving = true; throw fail('save_failed', 'migration completion could not be kept; retry the move') }
          b._changed()
          return { migrated: true, trust: s.v2.svc.trust }
        } finally { b._migrating = false }
      })
    },
    async emailMove(b) {
      onService(b)
      const r = await svc.status(b, { force: true })
      if (!r || r.state !== 'active') throw fail('status_unavailable', 'the account service could not confirm this account is active')
      return r.move || null
    },
    async requestMoveTime(b) {
      if (!(await svc.emailMove(b))) throw fail('no_reset', 'no email move is pending')
      const s = onService(b)
      return busyWhile(() => client(s).objectMove())
    },
    async cancelEmailMove(b, { getCode } = {}) {
      if (typeof getCode !== 'function') throw fail('no_screen', 'cancelling an email move needs an emailed code')
      if (!(await svc.emailMove(b))) throw fail('no_reset', 'no email move is pending')
      const s = onService(b)
      return busyWhile(() => client(s).cancelMove({ address: addressOf(b, s), getCode }))
    },
    /** A new account here: the address proved by an email code, the first recovery code shown (`showCode`) and kept before its
     *  activation, then the first backup. A failure after the account exists KEEPS it (half-made), so the next enable() finishes
     *  it instead of making another (an address with an account and no code could not start again). → { code } | null (the
     *  service refused this vault's tenant before anything was made: the old store, as before) */
    async enable(b, { email, getCode, showCode, rooms = [] } = {}) {
      if (typeof getCode !== 'function' || typeof showCode !== 'function') throw fail('no_screen', 'the new account service needs the vault\'s screens (an emailed code, the recovery code)')
      const resume = b._s && halfMade(b._s) ? b._s : null
      const address = canonicalAddress((resume && resume.v2.svc && resume.v2.svc.address) || email || b._email())
      if (!address) throw fail('email_required', 'the account needs an email address — sign in first, or pass `email`')
      // A FIRST CODE ALREADY ON ITS WAY (its activation sent, the answer lost): the service decides first — adopted, the account is
      // whole; still open, nothing new is made over it (a second code's master would replace the first's; review 2026-11-16)
      if (resume && resume.v2.pending) {
        await busyWhile(() => client(resume, { changed: () => { if (b._s === resume) b._changed() }, wipe: async () => { if (b._s === resume) b._drop() } }).checkStatus())
        if (b._s !== resume) throw fail('cancelled', 'this account is no longer on this device')
        if (!halfMade(resume)) { b._changed(); b._started(); return { code: '' } } // the first code (already shown) is active
        if (resume.v2.pending) throw fail('try_again', 'the first recovery code is still being activated — try again in a minute')
      }
      const s = resume || { v: 1, format: 'account', master: b64(newMasterSecret()), rooms, email: address, v2: {} }
      b._s = s; b._enabling = s; b._enablingDirty = false
      let code = ''
      try {
        await busyWhile(() => client(s, { current: () => b._s === s }).startFresh({ address, getCode, showCode: async (c) => { code = c; await showCode(c) } }))
      } catch (e) {
        if (b._enabling === s) b._enabling = null
        const made = !!(s.v2 && s.v2.svc && s.v2.svc.acct)
        if (b._s === s) { if (!made) b._s = null; b._changed() } // made: kept, not enabled (halfMade) — the app persists it
        if (!made && !resume && e && (e.code === 'tenant_origin' || e.code === 'bad_tenant')) return null
        throw e
      }
      const queued = b._enablingDirty
      b._enabling = null; b._enablingDirty = false
      if (b._s !== s) throw fail('cancelled', 'the backup was replaced while it was being set up')
      b._changed(); b._started()
      if (queued) b._schedule()
      return { code }
    },

    /** § 8.1 — the recovery code on the new service. → { rooms } | null (not an account there, or the service could not say before it
     *  knew the code: the old store is asked). `getCode` is the emailed code's question; `askAddress()` the email when none is known. */
    async restore(b, { code, email, getCode, askAddress } = {}) {
      let typed
      try { codeSecret(code); typed = code } catch { throw fail('bad_code', 'that is not a recovery code') }
      if (typeof getCode !== 'function') return null // no screen for the emailed code (a page outside a vault): the old store only
      const s1 = { v: 1, format: 'account', master: '', rooms: [], v2: {} }
      let found = false, done = null
      const address = async () => {
        found = true // the service knows this code
        const x = canonicalAddress(email || b._email() || (askAddress ? await askAddress() : ''))
        if (!x) throw fail('email_required', 'this account also needs its email address')
        return x
      }
      const a = client(s1, {
        applyRestored: async ({ master: bm, payload, legacy }) => {
          const identity = is32(payload.sdkMaster) ? payload.sdkMaster : legacy && payload.sdkMaster === undefined ? b64(bm) : null
          if (vaultOwner(payload) !== 'sdk' || !identity) throw fail('not_sdk_backup', 'that code opens a backup made by a different app')
          const plan = applyPlan(payload, {}, { app: SDK_APP })
          done = { master: identity, rooms: roomsOfRecord(plan ? { ...payload, recents: plan.add } : payload), tomb: tombOfRecord(payload),
            ...(payload.email ? { email: payload.email } : {}), ...((plan ? plan.inviteKey : payload.inviteKey) ? { invite: plan ? plan.inviteKey : payload.inviteKey } : {}),
            format: 'account', v2: { ...s1.v2, bm: b64(bm) } }
          return done.rooms.length
        },
      })
      try {
        await a.restoreHere({ address, getCode, typedCode: typed })
      } catch (e) {
        if (e && e.code === 'no_account') return null
        if (!found && e && (e.code === 'tenant_origin' || e.code === 'bad_tenant' || !(e.status && e.status < 500))) return null // the service could not say: the old store
        throw e
      }
      if (!done) throw fail('unopenable', 'the backup could not be opened')
      return done
    },

    /** The routine write (sdkBackup.js _write): read the head, keep another device's rooms, seal, commit over the version read. */
    async write(b, s0) {
      if (halfMade(s0)) return // its first code is not active yet: nothing to write over
      const a = client(s0, { changed: () => { if (b._s === s0) b._changed() } })
      const loc = await backupLocation(unb64(s0.v2.bm))
      for (let attempt = 0; attempt < 4; attempt++) {
        let head
        try { head = await a.readBackup(loc.id) } catch (e) { throw fail('save_failed', 'the backup could not be read', { status: e && e.status, reason: e && e.code }) }
        if (b._s !== s0) return
        const blob = await seal(loc.key, await recordOverHead(s0, loc.key, head))
        if (b._s !== s0) return
        let r
        try { r = await a.writeBackup(loc.id, blob, head) } catch (e) { throw fail('save_failed', 'the backup could not be saved', { status: e && e.status, reason: e && e.code }) }
        if (r === 'conflict') { await new Promise((res) => setTimeout(res, 100 + Math.floor(Math.random() * 300))); continue }
        b.lastError = null
        return
      }
      throw fail('save_failed', 'the backup kept changing under this save (another device writing) — the next change tries again', { status: 409 })
    },

    // ── the account's own calls (the vault's screens ask the person) ──────────────────────────────────────────────────
    /** § 8.3 — every other device of the account is signed out; each one notices at its next status check and forgets it. */
    /** ONE other device of the account, signed out AT THE SERVICE (the regular app's revokeAtService; sync sweep 11-19 P8): `spk` = that
     *  device's key as its index entry names it. The email code proves it is the account's owner. */
    async listDevices(b) { return client(onService(b)).devices() },
    async signOutDevice(b, { spk, getCode }) {
      const s = onService(b)
      return client(s).signOutDevice({ spk, address: addressOf(b, s), getCode })
    },
    /** This device's key on the service (its spk) — what its index entry carries so another device can sign it out there. null: none. */
    async deviceSpk(b) {
      const s = b && b._s; if (!s || !s.v2 || !s.v2.dk) return null
      try { const rec = await ensureKeyRecord(keysOf(s.v2.dk)); return (rec && rec.spk) || null } catch { return null }
    },
    async forgetDevice(b) {
      keyEpoch++
      // A vault wipe forgets every locally held account, even when erase/status already dropped the active backup state.
      if (typeof keyStore.clear === 'function') { await keyStore.clear(); return }
      const dk = b && b._s && b._s.v2 && b._s.v2.dk
      if (dk && typeof keyStore.del === 'function') await keyStore.del('devkey:v1|' + dk)
    },
    securityKeyActions(b) {
      const state = onService(b), service = client(state)
      const action = (method) => (...args) => {
        if (b._s !== state) throw fail('account_changed', 'the account changed during security-key management')
        return service[method](...args)
      }
      return Object.fromEntries(['security', 'turnOnAdvanced', 'turnOffAdvanced', 'addKey', 'removeKey'].map((method) => [method, action(method)]))
    },
    async signOutOthers(b, { getCode }) {
      const s = onService(b)
      const r = await client(s).signOutOthers({ address: addressOf(b, s), getCode })
      try { if (typeof afterSignOut === 'function') afterSignOut(addressOf(b, s)) } catch { /* best effort: the next request renews */ }
      return r
    },
    /** docs/device-gate-design.md: this ACTIVE device's ten-minute room pass for its session key (roomPass.js) → { pass, sig, exp } —
     *  in this vault's tenant's scope (x-acct-tenant). A signed-out device is refused (`revoked`), and onRevoked runs the status check. */
    async roomPass(b, email, sessionPub) {
      const s = onService(b)
      return client(s).roomPass(email, sessionPub)
    },
    async enrolCloudDevice(b, { spk, getCode } = {}) {
      const s = onService(b)
      if (typeof getCode !== 'function') throw fail('no_screen', 'registering the cloud device needs an emailed code')
      const current = () => { if (b._s !== s) throw fail('account_changed', 'the account changed during device registration') }
      await busyWhile(() => client(s).enrolDevice({ newSpk: spk, label: 'Cloud device', address: addressOf(b, s), getCode: async () => { current(); const code = await getCode(); current(); return code } }))
      current()
      return { base }
    },
    /** § 8.2 — a new recovery code (shown by `showCode` before it is activated); the old code stops working and every other
     *  device is signed out. The account's identity (its rooms, index, usage) is unchanged. */
    async newRecoveryCode(b, { getCode, showCode }) {
      const s = onService(b)
      await busyWhile(() => client(s, { changed: () => { if (b._s === s) b._changed() }, current: () => b._s === s }).newRecoveryCode({ address: addressOf(b, s), getCode, showCode }))
      if (b._s === s) b._changed()
      return { ok: true }
    },
    /** Release checklist 1.11 — the account is deleted on the service (every device signed out, the address freed, the backup
     *  gone); this client then holds no account. */
    async deleteAccount(b, { getCode, keep = false }) {
      const s = onService(b)
      await busyWhile(() => client(s, { changed: () => { if (b._s === s) b._changed() } }).eraseAccount({ address: addressOf(b, s), getCode }))
      // keep: the full erase (sdkErase.js) still needs the backup's master for the rooms after this step — it marks the state
      // erased (no write re-creates it) and drops it at its end; anyone else drops it now
      if (b._s === s) { clearTimeout(b._timer); b._timer = null; if (keep) { s.erased = true; b._changed() } else b._drop() }
      return { deleted: true }
    },
    /** § 8.8 — this device's push address changed (on, off, a subscription loaded or renewed): registered with the service again
     *  now, not at the next daily check (Codex sweep 2026-11-16 #2). → 'registered' | 'removed' | 'same' | 'unknown' | 'off' */
    async syncPush(b) {
      const s = b._s
      if (!s || !s.v2 || !s.v2.svc || halfMade(s) || busy || b._isEnabling()) return 'off'
      return client(s).syncPush()
    },
    /** § 8.5 — at launch, on return to the foreground (at most daily), at once for an unfinished new code or a refusal as signed
     *  out. A device signed out elsewhere: `onSignedOut()` (the vault forgets the account here). → the service's state, or null */
    async status(b, { force = false, onSignedOut } = {}) {
      const s = b._s
      if (!s || !s.v2 || !s.v2.svc || s.v2.resetDraft || busy || b._isEnabling()) return null
      if (!statusDue({ now: Date.now(), last: s.v2.checked, pending: !!s.v2.pending || halfMade(s), moving: !!s.v2.emailMove, force })) return null
      let wiped = false
      const a = client(s, { canApplyStatus: () => b._s === s && !busy && !s.erased, changed: () => { if (b._s === s) b._changed() }, wipe: async () => { wiped = true } })
      const r = await a.checkStatus()
      if (b._s !== s) return r
      if (wiped || (r && r.state === 'revoked')) { clearTimeout(b._timer); b._timer = null; b._drop(); if (onSignedOut) await onSignedOut(s); return r }
      if (r && r.state !== 'unknown') { s.v2.checked = Date.now(); b._changed() }
      // § 8.8, as our vault's status check: this device's push address registered, the signed-out devices' taken off every Space
      // (each a no-op without push — pushDeps; sync sweep 11-16 #14)
      if (r && r.state === 'active') { a.syncPush().catch(() => {}); a.prunePush().catch(() => {}) }
      return r
    },
  }
  const onService = (b) => { const s = b._s; if (!s || !s.v2 || !s.v2.svc || halfMade(s)) throw fail('not_on_service', 'this account is not on the account service (an account on the old backup store has no such call)'); return s }
  const addressOf = (b, s) => (s.v2.svc && s.v2.svc.address) || s.email || b._email()
  return svc
}
