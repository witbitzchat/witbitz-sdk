// acctV2App.js — the app's side of account recovery v2 (docs/account-recovery-protocol.md): it joins the client library
// (acctV2Client.js) to what this device already holds — its non-extractable device key (devices.js), the backup's master and
// the escrowed recovery code (backup.js), the account key (store.js) — and gives the screens four actions: move this
// account from today's service (§ 12.2), the launch / foreground status check that removes a signed-out device's account
// (§ 8.5), sign out every other device (§ 8.3), and the state the screens read.
//
// OFF unless a v2 service address is set (`base`): v2 runs on staging only until its release gates. Dependencies are
// injected (makeAcctV2), so the whole flow is tested against the service code in-process (spaces/test/acctV2App.test.mjs).
import { accountClient } from './acctV2Client.js'
import { possessionKey, backupWriteKey, gateValues, webCryptoSigner, webCryptoSignerFromSpk } from './acctV2Keys.js'
import { rawToDer, b64u, hexOf } from './acctV2Wire.js'
import { transcriptForLegacy, transcriptForJoin, transcriptForSilent, transcriptForJoinAsk } from './acctV2Legacy.js'

export const STATE_KEY = 'space:acctv2' // { acct, base, at, address? } — an account id, the service's address and the account's email; no key
export const RESET_KEY = 'space:acctv2:reset' // § 11.5: the email move THIS device started — { reset, address, ready_at, expires, base }
export const MOVE_KEY = 'space:acctv2:move' // § 11.5, 3a: a move of THIS account's address under way, as the status answer said — { reset, ready_at, expires, objected, base }

/** deps: { base, fetch?, storage (getItem/setItem/removeItem), deviceKey() → { priv, pub } (WebCrypto pair), vault() →
 *  { master (base64), code? }, codeBytesOf(code) → Uint8Array, backupIdOf(master) → hex, wrapperIdOf(codeBytes) → hex,
 *  acctKey() → { priv (JWK), pub } | null, deviceKeys() → [spk of the account's other devices], wipe(),
 *  prepareRotation(headOf) → { newCode, newMaster, backupId, wrapperId, backupBlob, wrapperBlob } (sealed under the NEW
 *  secrets, merged with the current head), prepareSetup() → the same for an account's FIRST code (nothing to merge),
 *  adoptRotation(prep), openWrapper(codeBytes, sealed) → master | null, openBackup(master, sealed) → payload | null,
 *  applyRestored({ master, payload, code }) → rooms added (the restore's last step: apply, keep the master and code) — keep the new master and code, keys — the security-key
 *  adapter (acctV2WebAuthn.js browserKeys; a simulated key in tests) } */
const sha256Hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))))].map((b) => b.toString(16).padStart(2, '0')).join('')

export function makeAcctV2(deps) {
  const client = deps.base ? accountClient({ base: deps.base, fetch: deps.fetch, headers: deps.headers }) : null // deps.headers: the vault's tenant (acctV2VaultWiring.js)
  const state = () => { try { return JSON.parse(deps.storage.getItem(STATE_KEY) || 'null') } catch { return null } }
  const setState = (s) => { try { deps.storage.setItem(STATE_KEY, JSON.stringify(s)) } catch { /* private mode */ } }
  // the stored public bytes (`spk`) when the device has them — what the app registers everywhere; else the public CryptoKey
  const signer = async () => {
    const k = await deps.deviceKey()
    if (!k || !k.priv || !(k.spk || k.pub)) throw Object.assign(new Error('no_device_key'), { code: 'no_device_key' })
    return k.spk ? webCryptoSignerFromSpk(k.priv, k.spk) : webCryptoSigner(k.priv, k.pub)
  }
  /** 1.10 (the owner's iPhone, 2026-11-15): before this device STARTS or RESTORES an account, its key must not be another
   *  account's — an account deleted in the app leaves the key registered on the service (the browser keeps it), and the
   *  service then refuses (`key_registered`). The service knows the key (any state but `unknown`) while this device keeps
   *  no account on the new service → a new device key (deps.newDeviceKey), then on. Offline / no answer: as before. */
  const freshKeyIfTaken = async () => {
    if (state() || !deps.newDeviceKey) return
    let r = null
    try { r = await client.deviceStatus(await signer()) } catch { return }
    if (r && r.state && r.state !== 'unknown') await deps.newDeviceKey()
  }
  // this device's name on the service ("Chrome on Windows") — the app's own label (devices.js), else a neutral one
  const myLabel = () => { try { return String((deps.label && deps.label()) || 'This device').slice(0, 64) } catch { return 'This device' } }
  /** R2-03: show the new code, then keep it as pending with its session id, and refuse to go on (no activation is sent)
   *  unless it reads back from disk — `holdPending` answers whether it is durable. */
  async function keepPending(prep, { rid } = {}, showCode) {
    await showCode(prep.newCode)
    const kept = deps.holdPending ? await deps.holdPending({ ...prep, rid }) : false
    if (kept !== true) throw Object.assign(new Error('pending_not_kept'), { code: 'pending_not_kept' })
  }
  const need = () => { if (!client) throw Object.assign(new Error('v2_off'), { code: 'v2_off' }) }
  /** Keep (or, for none, forget) the move a status answer named. → what is kept, or null */
  const keepMove = (m) => {
    const ok = m && typeof m.reset === 'string' && Number.isFinite(m.ready_at) && Number.isFinite(m.expires)
    try {
      if (!ok) { deps.storage.removeItem(MOVE_KEY); return null }
      const rec = { reset: m.reset, ready_at: m.ready_at, expires: m.expires, objected: !!m.objected, base: deps.base }
      deps.storage.setItem(MOVE_KEY, JSON.stringify(rec))
      return rec
    } catch { return ok ? { reset: m.reset, ready_at: m.ready_at, expires: m.expires, objected: !!m.objected } : null }
  }

  async function accountSigner() {
    const a = deps.acctKey()
    if (!a || !a.priv) return null
    const key = await crypto.subtle.importKey('jwk', a.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    return { sign: async (bytes) => rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes))) }
  }

  /** The silent join (legacySilent.mjs): the account key, the possession key from THIS device's code and the device key. */
  async function joinMoved({ gid, codeBytes, device, acctSig, label }) {
    const ts = Math.floor(Date.now() / 1000)
    const ask = b64u(await acctSig.sign(transcriptForJoinAsk({ gid, deviceSpk: device.spk, ts })))
    const it = await client.req('POST', '/v2/account/legacy/join', { body: { gid, ts, account_sig: ask }, signer: device })
    const poss = await possessionKey(codeBytes)
    const params = { device_spk: device.spk, label }
    const T = transcriptForJoin(it, it.attempt, params)
    const sigs = { account: b64u(await acctSig.sign(T)), possession: b64u(poss.sign(T)), device: b64u(await device.sign(T)) }
    const r = await client.req('POST', `/v2/account/legacy/join/${it.attempt}/commit`, { body: { params, sigs }, signer: device })
    setState({ acct: r.acct, base: deps.base, at: Date.now(), trust: r.legacy_trust, silent: 'joined' })
    return { acct: r.acct, legacy_trust: r.legacy_trust, joined: true }
  }

  return {
    enabled: () => !!client,
    state,

    /** § 12.2 — move this account. `typedCode` only when this device has no escrowed copy of the recovery code. */
    async migrate({ address, getCode, typedCode = null, label = myLabel() }) {
      need()
      const v = deps.vault()
      if (!v || !v.master) throw Object.assign(new Error('no_backup'), { code: 'no_backup' })
      const code = typedCode || v.code
      if (!code) throw Object.assign(new Error('need_code'), { code: 'need_code' })
      const codeBytes = deps.codeBytesOf(code)
      const master = Uint8Array.from(atob(v.master), (c) => c.charCodeAt(0))
      const { gid, gk } = await gateValues(codeBytes)
      const device = await signer()
      const it = await client.req('POST', '/v2/account/legacy/intent', { body: { gid }, signer: device })
      const { ticket } = await client.req('POST', '/v2/account/email/start', { body: { purpose: 'legacy', attempt: it.attempt, address, gk: hexOf(gk) } })
      const v2 = await client.req('POST', '/v2/account/email/verify', { body: { ticket, code: await getCode() } })
      if (!v2.verified) throw Object.assign(new Error('email_code_wrong'), { code: 'email_code_wrong' })
      await client.req('POST', `/v2/account/legacy/${it.attempt}/authorize`, { body: { ticket }, signer: device })
      const poss = await possessionKey(codeBytes), wk = await backupWriteKey(master)
      const params = { backup_id: await deps.backupIdOf(master), wrapper_id: await deps.wrapperIdOf(codeBytes), possession_pub: poss.spk, write_pub: wk.spk,
        device_spk: device.spk, label, devices: (deps.deviceKeys() || []).filter((k) => k && k !== device.spk) }
      const T = transcriptForLegacy({ acct: it.acct, nonce: it.nonce, exp: it.exp }, it.attempt, params)
      const acctSig = it.account_key ? await accountSigner() : null
      if (it.account_key && !acctSig) throw Object.assign(new Error('no_account_key'), { code: 'no_account_key' })
      const sigs = { possession: b64u(poss.sign(T)), device: b64u(await device.sign(T)), ...(acctSig ? { account: b64u(await acctSig.sign(T)) } : {}) }
      const r = await client.req('POST', `/v2/account/legacy/${it.attempt}/commit`, { body: { params, sigs }, signer: device })
      setState({ acct: r.acct, base: deps.base, at: Date.now(), trust: r.legacy_trust })
      return r
    },

    /** THE SILENT MOVE (control-plane legacySilent.mjs; docs/account-recovery-silent-migration.md draft 2 — the owner, 2026-11-18:
     *  "Fully silent. No hold."): no question asked. This device's escrowed recovery code (gid, gk, the possession key) and its
     *  account key are the evidence, the address it signed in with must be the one the old backup was set up with. An account
     *  another device already moved this way: this device JOINS it. Throws with `.code` for everything that needs the person
     *  (need_code, no_account_key, email_needed, address_mismatch) or must stop (possession_mismatch, join_closed, …).
     *  → { acct, legacy_trust, moved: true } | { acct, legacy_trust, joined: true } */
    async silentMove({ address, label = myLabel() }) {
      need()
      const fail = (code) => { throw Object.assign(new Error(code), { code }) }
      const v = deps.vault()
      if (!v || !v.master) fail('no_backup')
      if (!v.code) fail('need_code') // a device that keeps no copy of the code: the Settings button (the person types it)
      if (!address) fail('no_address')
      const codeBytes = deps.codeBytesOf(v.code)
      const master = Uint8Array.from(atob(v.master), (c) => c.charCodeAt(0))
      const { gid, gk } = await gateValues(codeBytes)
      const device = await signer()
      // the service first: an old backup without an account key needs the email code whatever this device holds (such a device —
      // from before account keys — usually holds none: asking for the key first stopped it as no_account_key, never offered the email)
      let it
      try { it = await client.req('POST', '/v2/account/legacy/intent', { body: { gid }, signer: device }) } catch (e) {
        if (e && e.code === 'already_migrated') { const acctSig = await accountSigner(); if (!acctSig) fail('no_account_key'); return joinMoved({ gid, codeBytes, device, acctSig, label }) }
        throw e
      }
      if (!it.account_key) fail('email_needed') // an old backup without an account key moves only with the email code
      const acctSig = await accountSigner()
      if (!acctSig) fail('no_account_key')
      const authz = b64u(await acctSig.sign(transcriptForSilent({ acct: it.acct, nonce: it.nonce, exp: it.exp }, it.attempt, device.spk)))
      await client.req('POST', `/v2/account/legacy/${it.attempt}/silent`, { body: { address, gk: hexOf(gk), account_sig: authz }, signer: device })
      const poss = await possessionKey(codeBytes), wk = await backupWriteKey(master)
      const params = { backup_id: await deps.backupIdOf(master), wrapper_id: await deps.wrapperIdOf(codeBytes), possession_pub: poss.spk, write_pub: wk.spk,
        device_spk: device.spk, label, devices: (deps.deviceKeys() || []).filter((k) => k && k !== device.spk) }
      const T = transcriptForLegacy({ acct: it.acct, nonce: it.nonce, exp: it.exp }, it.attempt, params)
      const sigs = { possession: b64u(poss.sign(T)), device: b64u(await device.sign(T)), account: b64u(await acctSig.sign(T)) }
      const r = await client.req('POST', `/v2/account/legacy/${it.attempt}/commit`, { body: { params, sigs }, signer: device })
      setState({ acct: r.acct, base: deps.base, at: Date.now(), trust: r.legacy_trust, silent: 'moved' })
      return { acct: r.acct, legacy_trust: r.legacy_trust, moved: true }
    },

    /** § 12.4 + § 8.2a — start an account on the new service from this device: the address proved by an email code, then
     *  the first recovery code (shown until saved) and the first backup. The account is kept as soon as it exists, so a
     *  failure after that resumes at the code step (state.setup = 'pending') instead of making another account. */
    async startFresh({ address, getCode, showCode, label = myLabel() }) {
      need()
      await freshKeyIfTaken()
      const device = await signer()
      let s = state()
      if (s && s.setup !== 'pending') throw Object.assign(new Error('already_migrated'), { code: 'already_migrated' })
      if (!s) {
        const r = await client.freshAccount({ device, address, getCode, label })
        s = { acct: r.acct, base: deps.base, at: Date.now(), trust: null, setup: 'pending', address }
        setState(s)
      }
      const prep = await deps.prepareSetup()
      const r = await client.setupCode({ acct: s.acct, device, address, newCode: deps.codeBytesOf(prep.newCode), newMaster: prep.newMaster,
        backupId: prep.backupId, wrapperId: prep.wrapperId, backupBlob: prep.backupBlob, wrapperBlob: prep.wrapperBlob,
        confirmSaved: (at) => keepPending(prep, at, showCode) })
      deps.adoptRotation(prep)
      setState({ acct: s.acct, base: deps.base, at: Date.now(), trust: null, address })
      return { acct: s.acct, ...r }
    },

    // ── § 11.5 THE EMAIL RESET, from this device (the claimant) ──────────────────────────────────────────────────────────
    /** The move this device started, if any: { reset, address, ready_at, expires } (seconds), kept on this device only. */
    pendingReset() { try { const r = JSON.parse(deps.storage.getItem(RESET_KEY) || 'null'); return r && r.reset && (!r.base || r.base === deps.base) ? r : null } catch { return null } }, // only a move started on THIS service
    /** Start moving `address` to a new account: a claim code; the week begins. A device already in an account cannot. */
    async resetBegin({ address, getCode }) {
      need()
      if (state()) throw Object.assign(new Error('already_migrated'), { code: 'already_migrated' })
      await freshKeyIfTaken()
      const r = await client.resetBegin({ device: await signer(), address, getCode })
      const rec = { reset: r.reset, address, ready_at: r.ready_at, expires: r.expires, base: deps.base }
      deps.storage.setItem(RESET_KEY, JSON.stringify(rec))
      return rec
    },
    /** After the week: a new claim code → a FRESH account with this device in it, then its first recovery code (as startFresh). */
    async resetFinish({ getCode, showCode, label = myLabel() }) {
      need()
      const p = this.pendingReset()
      if (!p) throw Object.assign(new Error('no_reset'), { code: 'no_reset' })
      const s0 = state()
      // a device that meanwhile holds ANOTHER account cannot finish here (security review, 2026-11-15): the move stays, so it
      // can still be cancelled; only the retry of THIS move's own setup (its account made, its first code not yet) goes on
      if (s0 && !(s0.setup === 'pending' && s0.address === p.address)) throw Object.assign(new Error('already_migrated'), { code: 'already_migrated' })
      if (!s0) {
        const r = await client.resetFinish({ device: await signer(), reset: p.reset, address: p.address, getCode, label })
        setState({ acct: r.acct, base: deps.base, at: Date.now(), trust: null, setup: 'pending', address: p.address })
      }
      deps.storage.removeItem(RESET_KEY)
      return this.startFresh({ address: p.address, getCode, showCode, label }) // the account exists (setup pending): only its first code
    },
    /** Cancel the move (a claim code): the address stays with its account. */
    async resetCancel({ getCode }) {
      need()
      const p = this.pendingReset()
      if (!p) throw Object.assign(new Error('no_reset'), { code: 'no_reset' })
      await client.resetCancel({ reset: p.reset, address: p.address, getCode })
      deps.storage.removeItem(RESET_KEY)
      return { cancelled: true }
    },
    /** A move that can no longer finish (cancelled, superseded, expired): forget it here. */
    forgetReset() { deps.storage.removeItem(RESET_KEY) },

    /** § 8.1 — bring an account on the new service to THIS device: the recovery code, an email code, and a security key when
     *  the account is Advanced. Both objects are opened here BEFORE the device is registered (a wrong code or a damaged copy
     *  registers nothing); then the restore finishes, and only then is the backup applied and the account kept. */
    async restoreHere({ address, getCode, typedCode, label = myLabel() }) {
      need()
      if (state()) throw Object.assign(new Error('already_migrated'), { code: 'already_migrated' })
      let codeBytes
      try { codeBytes = deps.codeBytesOf(typedCode) } catch { throw Object.assign(new Error('bad_code'), { code: 'bad_code' }) }
      await freshKeyIfTaken()
      const device = await signer()
      const r = await client.restore({ codeBytes, address, getCode, device, label, keys: deps.keys || null })
      const dec = new TextDecoder()
      const wrapper = r.blobs[await deps.wrapperIdOf(codeBytes)]
      const master = wrapper ? await deps.openWrapper(codeBytes, dec.decode(wrapper)) : null
      if (!master) throw Object.assign(new Error('wrapper_unopened'), { code: 'wrapper_unopened' })
      const backup = r.blobs[await deps.backupIdOf(master)]
      const payload = backup ? await deps.openBackup(master, dec.decode(backup)) : null
      if (!payload) throw Object.assign(new Error('backup_unopened'), { code: 'backup_unopened' })
      await r.finish()
      setState({ acct: r.acct, base: deps.base, at: Date.now(), trust: null, address: r.address }) // the address asked (it may be a function)
      const rooms = await deps.applyRestored({ master, payload, code: typedCode })
      return { acct: r.acct, rooms, address: r.address }
    },

    /** § 8.6 Add a device, on the APPROVING device: register the new device's key with the service (this device + an email
     *  code; Advanced: + a security key). The account's keys may go to it only after this. → { acct, base, address } — what
     *  the new device needs to join (adoptLinked). */
    async enrolDevice({ newSpk, label, address, getCode, onStep }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      await client.enrolDevice({ acct: s.acct, device: await signer(), newSpk, label, address, getCode, keys: deps.keys || null, onStep })
      return { acct: s.acct, base: deps.base, address: s.address || (typeof address === 'string' ? address : null) }
    },

    /** § 8.6 on the NEW device, once the approving device registered it and sent the account's keys over the link: this
     *  device is the account's now — its backup is read through the service with this device's own key (a device-signed
     *  read), then applied as a restore applies it. Nothing is kept if any step fails. → { acct, rooms } */
    async adoptLinked({ acct, address, master: masterB64, code }) {
      need()
      if (state()) throw Object.assign(new Error('already_migrated'), { code: 'already_migrated' })
      const master = Uint8Array.from(atob(masterB64), (ch) => ch.charCodeAt(0))
      setState({ acct, base: deps.base, at: Date.now(), trust: null, address: address || null })
      try {
        const id = await deps.backupIdOf(master)
        const r = await client.syncRead(await signer(), id)
        const blob = r.blob && r.blob.length ? new TextDecoder().decode(r.blob) : null
        const payload = blob ? await deps.openBackup(master, blob) : null
        if (!payload) throw Object.assign(new Error('backup_unopened'), { code: 'backup_unopened' })
        const rooms = await deps.applyRestored({ master, payload, code })
        return { acct, rooms }
      } catch (e) { deps.storage.removeItem(STATE_KEY); throw e }
    },

    /** F-01 / R2-03 / R3-01 (implementation review): a new code (rotation or the first one) is kept as `vault.pending`,
     *  with its session id, and read back from disk BEFORE its activation is sent; an activation can land with its answer
     *  lost. At launch and on foreground the SERVICE decides, never this device's clock:
     *   1. the pending backup id is this account's current head → the activation committed → adopt (the code was shown);
     *   2. else CLOSE the session (a write: it races any commit still on its way, and only one of them can win):
     *      still live by the service's clock → wait; the commit won → adopt once the head says so;
     *   3. closed (now or earlier) or gone — no commit of it can ever land → read the head once more (a commit that
     *      landed before the close), and only if it is still not current → drop.
     *  A read of the session's time is never enough to drop (R3-01: a commit past its checks can land after it).
     *  Anything unknown (offline, an error, a revoked device, no session id) → change nothing.
     *  → 'none' | 'adopted' | 'dropped' | 'waiting' | 'unknown' */
    async reconcilePending() {
      const s = state(), v = deps.vault && deps.vault()
      if (!client || !s || !v || !v.pending || !v.pending.master) return 'none'
      const master = Uint8Array.from(atob(v.pending.master), (c) => c.charCodeAt(0))
      let id, device
      try { id = await deps.backupIdOf(master); device = await signer() } catch { return 'unknown' }
      const current = async () => {
        try { await client.syncRead(device, id); return true } catch (e) { return e && (e.code === 'not_a_member' || e.code === 'not_current') ? false : null }
      }
      const adopt = () => {
        deps.adoptRotation({ newMaster: master, newCode: v.pending.code })
        if (s.setup === 'pending') setState({ ...s, setup: undefined, at: Date.now() })
        return 'adopted'
      }
      const c1 = await current()
      if (c1 === true) return adopt()
      if (c1 === null) return 'unknown'
      if (!v.pending.rid) return 'waiting' // kept by an older build: no session to ask — keep it
      let st
      try { st = await client.rotationClose(device, v.pending.rid) } catch { return 'unknown' }
      if (st.live) return 'waiting'
      if (st.state !== 'closed' && st.state !== 'gone' && st.state !== 'committed') return 'unknown' // an answer this build does not know
      const c2 = await current()
      if (st.state === 'committed') return c2 === true ? adopt() : 'waiting' // the commit won: adopt through the head, never drop
      if (c2 === true) return adopt()
      if (c2 === null) return 'unknown'
      deps.dropPending && deps.dropPending()
      return 'dropped'
    },

    /** § 8.5 — at launch and on foreground. Removes this account ONLY on an authenticated answer naming this key and the
     *  nonce this request sent (the client checks the HTTP status; this checks the body); anything else changes nothing. */
    async checkStatus() {
      const s = state()
      if (!client || !s) return { state: 'off' }
      let r
      try { r = await client.deviceStatus(await signer()) } catch { return { state: 'unknown' } } // offline, an error, a mismatch: nothing changes
      if (r.state === 'revoked') { await deps.wipe(); deps.storage.removeItem(STATE_KEY); deps.storage.removeItem(MOVE_KEY); return { state: 'revoked' } }
      let pending = 'none'
      if (r.state === 'active') { try { pending = await this.reconcilePending() } catch { pending = 'unknown' } }
      // § 11.5, 3a: a move of this account's address — kept, so the warning shows at once at the next launch and the check
      // runs at every launch until it ends; an active answer without one ends it (cancelled, finished, expired)
      const move = r.state === 'active' ? keepMove(r.move) : this.knownMove()
      return { state: r.state || 'unknown', pending, ...(move ? { move } : {}) }
    },

    /** The move of this account's email address under way, as the last status answer said (and not past its end) — or null. */
    knownMove() {
      try {
        const m = JSON.parse(deps.storage.getItem(MOVE_KEY) || 'null')
        if (!m || !m.reset || !state() || (m.base && m.base !== deps.base) || !(m.expires * 1000 > Date.now())) return null
        return m
      } catch { return null }
    },
    /** Ask for more time on that move (once): it then waits 30 days from its start. Never cancels. → the kept move */
    async objectMove() {
      need()
      const m = this.knownMove()
      if (!m) throw Object.assign(new Error('no_reset'), { code: 'no_reset' })
      try {
        const r = await client.resetObject({ device: await signer(), reset: m.reset })
        return keepMove({ ...m, ready_at: r.ready_at, expires: r.expires, objected: true })
      } catch (e) { if (e && (e.code === 'reset_ended' || e.code === 'no_reset')) deps.storage.removeItem(MOVE_KEY); throw e }
    },
    /** Cancel that move with a claim code sent to `address` (the mailbox decides — a device alone cannot). */
    async cancelMove({ address, getCode }) {
      need()
      const m = this.knownMove()
      if (!m) throw Object.assign(new Error('no_reset'), { code: 'no_reset' })
      try { await client.resetCancel({ reset: m.reset, address, getCode }) } catch (e) { if (e && (e.code === 'reset_ended' || e.code === 'no_reset')) deps.storage.removeItem(MOVE_KEY); throw e }
      deps.storage.removeItem(MOVE_KEY)
      return { cancelled: true }
    },
    /** The mover: the dates of the move this device started, as the service has them now (a device of the old account may
     *  have asked for more time). → the kept move, or null when it ended (forgotten here). */
    async refreshReset() {
      need()
      const p = this.pendingReset()
      if (!p) return null
      const r = await client.resetState({ device: await signer(), reset: p.reset })
      if (r.state !== 'waiting') { if (r.state !== 'done') deps.storage.removeItem(RESET_KEY); return null }
      const rec = { ...p, ready_at: r.ready_at, expires: r.expires }
      deps.storage.setItem(RESET_KEY, JSON.stringify(rec))
      return rec
    },

    /** § 8.4 — the committed head of this account's backup: { blob (the sealed string) | null, ver, rg, epoch }. */
    async readBackup(id) {
      need()
      const r = await client.syncRead(await signer(), id)
      return { blob: r.blob && r.blob.length ? new TextDecoder().decode(r.blob) : null, ver: r.ver, rg: r.rg, epoch: r.epoch }
    },

    /** § 8.4 — a new version over `head` (as readBackup returned it). → 'ok' | 'conflict' */
    async writeBackup(id, sealed, head) {
      need()
      const s = state(), v = deps.vault()
      const master = Uint8Array.from(atob(v.master), (c) => c.charCodeAt(0))
      try {
        await client.writeBackup({ device: await signer(), acct: s.acct, id, blob: new TextEncoder().encode(sealed), prev: head.ver, master, rg: head.rg, epoch: head.epoch })
        return 'ok'
      } catch (e) { if (e && e.code === 'conflict') return 'conflict'; throw e }
    },

    /** § 8.2 — a new recovery code: every new value made here, the new backup merged with the current head, the code shown
     *  (`showCode(code)` resolves once the person has saved it), then one activation. Every other device is signed out. */
    async newRecoveryCode({ address, getCode, showCode }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      const prep = await deps.prepareRotation((id) => this.readBackup(id))
      const r = await client.rotate({
        acct: s.acct, device: await signer(), address, getCode,
        newCode: deps.codeBytesOf(prep.newCode), newMaster: prep.newMaster, backupId: prep.backupId, wrapperId: prep.wrapperId,
        backupBlob: prep.backupBlob, wrapperBlob: prep.wrapperBlob, keys: deps.keys || null,
        confirmSaved: (at) => keepPending(prep, at, showCode), // kept (and read back) before the activation is sent
      })
      deps.adoptRotation(prep)
      return r
    },

    /** § 8.3 — sign out every other device of this account. */
    /** Release checklist 1.11 — DELETE this account on the new service (the app's "Delete my account"): this device and an
     *  email code prove it, the service signs out every device, frees the address and deletes the backup. This device keeps
     *  no account afterwards (the app wipes the rest). */
    async eraseAccount({ address, getCode }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      const r = await client.eraseAccount({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys || null })
      try { deps.storage.removeItem(STATE_KEY) } catch { /* */ }
      return r
    },

    /** The email check for a guard on this device ("Show recovery code"): Google or the emailed code; nothing changes. */
    async proveEmail({ address, getCode }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      return client.proveEmail({ acct: s.acct, device: await signer(), address, getCode })
    },
    async signOutOthers({ address, getCode }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      const r = await client.signoutOthers({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys || null })
      this.prunePush().catch(() => {}) // § 8.8: their notifications leave every Space now (and again at each launch until done)
      try { if (typeof deps.afterSignOut === 'function') deps.afterSignOut() } catch { /* best effort */ } // the room pass: renew at once (docs/device-gate-design.md)
      return r
    },

    /** Sign out ONE other device of the account (Your devices: a computer paired for Code, …). Its notifications leave every
     *  Space as after any sign-out (§ 8.8). */
    async signOutDevice({ spk, address, getCode }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      const r = await client.signoutDevice({ acct: s.acct, device: await signer(), targetSpk: spk, address, getCode, keys: deps.keys || null })
      this.prunePush().catch(() => {})
      return r
    },
    /** The account's devices that count, as the service knows them → [{ spk, label, state, via, at, me }] (newest first), or
     *  null when this device has no account on the new service. Throws on anything else (offline, an error). */
    async devices() {
      if (!client || !state()) return null
      const r = await client.listDevices(await signer())
      return Array.isArray(r && r.devices) ? r.devices : []
    },

    /** § 8.8 (release checklist 1.6): this ACTIVE device's approval of ITS OWN AWS key (a handle on the person's budget)
     *  → { statement, sig } */
    async awsStatement(signPub) {
      need()
      const r = await client.awsStatement(await signer(), signPub)
      return { statement: r.statement, sig: r.sig }
    },

    /** docs/device-gate-design.md: this ACTIVE device's ten-minute room pass for its session key (roomPass.js) → { pass, sig, exp }.
     *  A signed-out device is refused (`revoked`), and the bridge's fetch runs the status check at once. */
    async roomPass(email, sessionPub) {
      need()
      const r = await client.roomPass(await signer(), email, sessionPub)
      return { pass: r.pass, sig: r.sig, exp: r.exp }
    },


    /** § 8.8: register THIS device's push address with the service — sealed under the account key (deps.sealPush), with its
     *  hash — when it changed (or none any more). → 'registered' | 'removed' | 'same' | 'off' */
    async syncPush() {
      if (!client || !state() || !deps.pushEndpoint || !deps.sealPush) return 'off'
      const endpoint = await deps.pushEndpoint()
      // NOT KNOWN YET is not "none" (Codex sweep 2026-11-16 #2: a builders' vault whose subscription was still loading sent an empty
      // record, and another device could no longer find this one's address to revoke it) — nothing is sent; the change resyncs it
      if (endpoint === undefined) return 'unknown'
      const k = STATE_KEY + ':push', mark = endpoint ? await sha256Hex(endpoint) : 'none'
      // the seal's key is part of the mark: after a new recovery code (a new master) the address is sealed again
      const seal = deps.sealId ? await deps.sealId() : ''
      let prev = null
      try { prev = deps.storage.getItem(k) } catch { /* */ }
      if (prev === state().acct + '|' + mark + '|' + seal) return 'same'
      await client.devicePush(await signer(), endpoint ? { sealed: await deps.sealPush(endpoint), hash: mark } : {})
      try { deps.storage.setItem(k, state().acct + '|' + mark + '|' + seal) } catch { /* */ }
      return endpoint ? 'registered' : 'removed'
    },

    /** § 8.8: the signed-out devices' push addresses leave every Space this device holds (deps.withdrawPush), then each is
     *  marked done with its hash. A Space that could not be reached leaves it to the next run. → { pruned, left } */
    async prunePush() {
      if (!client || !state() || !deps.openPush || !deps.withdrawPush) return { pruned: 0, left: 0 }
      const dev = await signer()
      const { devices = [] } = await client.signedOutPush(dev)
      let n = 0, left = devices.length
      for (const d of devices) {
        let endpoint = null
        try { endpoint = await deps.openPush(d.sealed) } catch { /* sealed under another master (before a new code): nothing to do here */ }
        if (!endpoint) continue
        if (!(await deps.withdrawPush([endpoint]))) continue
        await client.markPushPruned(dev, d.device, await sha256Hex(endpoint))
        n++; left--
      }
      return { pruned: n, left }
    },

    /** The computers paired for Code (codeComputers.js pruneSignedOutComputers): which of the listed device keys are still this
     *  account's devices → { base, states } — `base` the service that answered (an entry registered on another is never judged by
     *  it) — or null when this device has no account on the new service. Throws on anything else (offline, an error): unknown. */
    async deviceStates(spks) {
      if (!client || !state()) return null
      const r = await client.deviceStates(await signer(), spks)
      return { base: deps.base, states: r && r.states && typeof r.states === 'object' ? r.states : {} }
    },

    /** § 10 — the account's mode and its active keys, for Settings. */
    async security() {
      need()
      if (!state()) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      return client.security(await signer())
    },

    /** § 10.1 — turn Advanced Backup on: register and confirm every key the service asks for. */
    async turnOnAdvanced({ address, getCode, onStep }) {
      need()
      const s = state()
      if (!s) throw Object.assign(new Error('not_migrated'), { code: 'not_migrated' })
      return client.enrolKeys({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys, purpose: 'advanced_on', onStep })
    },

    /** § 10.4 — add a key (an existing key confirms it). */
    async addKey({ address, getCode, onStep }) {
      need()
      const s = state()
      return client.enrolKeys({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys, purpose: 'key_add', onStep })
    },

    /** § 10.4 — remove a key; another key proves it. */
    async removeKey({ address, getCode, credId }) {
      need()
      const s = state()
      return client.removeKey({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys, credId })
    },

    /** Turn Advanced Backup off: every key retired. */
    async turnOffAdvanced({ address, getCode }) {
      need()
      const s = state()
      return client.advancedOff({ acct: s.acct, device: await signer(), address, getCode, keys: deps.keys })
    },
  }
}
