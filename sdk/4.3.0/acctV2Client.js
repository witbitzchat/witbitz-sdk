// acctV2Client.js — the client of account recovery v2 (/v2/account/*; docs/account-recovery-protocol.md). Requests are
// signed with the device's key where the protocol says so (§ 5.4); every proof is computed over the server's challenge
// (§ 5.2). The flows take the person's email code through a callback — the UI asks for it — and never hold it longer.
// Pure over an injected fetch: the same code runs in the app and in the tests, against the real service code in-process.
import { transcript, canonicalQuery, deviceRequestBytes, writeProofBytes, b64u, unb64u, hexOf, sha256 } from './acctV2Wire.js'
import { possessionKey, backupWriteKey, gateValues } from './acctV2Keys.js'

const enc = new TextEncoder()
const rand = (n) => crypto.getRandomValues(new Uint8Array(n))

/** § 11.1 — trim; split at the last '@'; domain lower-cased and IDNA to ASCII; local part lower-cased. */
// The same checks as the service's (control-plane/src/lib/acct/email.mjs): a disagreement would commit a recovery code to a
// form the service never computes, and email restore would fail later. The domain may not carry a port, path or other
// URL syntax (URL() would quietly drop them); it needs a dot; the local part no whitespace; at most 254 characters.
export function canonicalAddress(raw) {
  const s = String(raw || '').trim(), at = s.lastIndexOf('@')
  if (at < 1 || at === s.length - 1 || s.length > 254) return null
  const local = s.slice(0, at).toLowerCase(), rawDomain = s.slice(at + 1).toLowerCase()
  if (/\s/.test(local) || /[\s:/\\?#@[\]]/.test(rawDomain)) return null
  let domain
  try { domain = new URL('http://' + rawDomain).hostname } catch { return null }
  if (!domain || !domain.includes('.')) return null
  return local + '@' + domain
}
export async function emailCommit(gk, canonical) {
  const k = await crypto.subtle.importKey('raw', gk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hexOf(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(canonical))))
}

// headers: extra headers on every request — the hosted app's vault names its tenant (`x-acct-tenant`), so its accounts are its
// own (control-plane/src/lib/acct/appScope.mjs). They never replace the content type or a device signature's headers.
export function accountClient({ base, fetch: f = globalThis.fetch, now = () => Math.floor(Date.now() / 1000), timeoutMs = 20000, headers: extra = null }) {
  // ⛔ 10·A#2 / A#3 / Q#4 (pass 10): a commit whose ANSWER was lost (no HTTP status: the network, a timeout) is sent again — the
  //   same request; the service answers its claimant with what it already did (reset.mjs). Not repeated: the device gave up its
  //   key and the address stayed bound to an empty account (fresh / reset finish), or locked for two weeks (reset start).
  const again = async (call) => {
    for (let i = 0; ; i++) {
      try { return await call() } catch (e) { if ((e && e.status) || i >= 2) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))) }
    }
  }
  async function req(method, path, { body, query = {}, signer } = {}) {
    const raw = body ? enc.encode(JSON.stringify(body)) : new Uint8Array(0)
    const headers = { ...(extra || {}), 'content-type': 'application/json' }
    const qs = canonicalQuery(query)
    if (signer) {
      const ts = now(), nonce = b64u(rand(9))
      const sig = await signer.sign(await deviceRequestBytes({ method, path, query: qs, body: raw, ts, nonce }))
      Object.assign(headers, { 'x-dev-spk': signer.spk, 'x-dev-ts': String(ts), 'x-dev-nonce': nonce, 'x-dev-sig': b64u(sig) })
    }
    const r = await f(base + path + (qs ? '?' + qs : ''), { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(method === 'GET' ? {} : { body: raw }) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || !j.ok) throw Object.assign(new Error((j && j.reason) || 'http_' + r.status), { code: j && j.reason, status: r.status })
    return j
  }
  const T = (c, op, params) => transcript({ op, acct: c.acct, params, challenge: c.challenge, nonce: c.nonce, exp: c.exp, pv: c.pv, rg: c.rg, ev: c.ev, epoch: c.epoch })
  const sigOf = async (signer, bytes) => b64u(await signer.sign(bytes))
  // getCode({ action }) answers the code — or { google: idToken }, a Google sign-in for THIS action (its nonce, acct/googleProof.mjs)
  // in place of the code, which the service turns into the same verified ticket
  // FIRST A CHOICE (the owner, 2026-11-16: "It should first ask for a choice between sending the code and Google login. Currently
  // it automatically sends the code"): a getCode with `choose` asks before anything is mailed — { google: idToken } goes straight
  // to the Google route and no code is sent; anything else (the person chose the email) mails the code, then asks for it.
  const chooseFirst = async (getCode, action) => (typeof getCode.choose === 'function' ? getCode.choose({ action }) : null)
  async function emailProof(c, address, getCode, gk) {
    const pick = await chooseFirst(getCode, c.challenge)
    if (pick && pick.google) return (await req('POST', '/v2/account/email/google', { body: { purpose: 'authz', challenge: c.challenge, idToken: pick.google, ...(gk ? { gk: hexOf(gk) } : {}) } })).ticket
    // THE APP'S OWN SIGN-IN (the owner, 2026-11-23: a restore signed in twice): the sign-in this device just made, bound to this
    // challenge by its key (control-plane acct/signInProof.mjs) — the email proved once, and the device keeps the session
    // a service from before the route (404 not_found / 501) gets the emailed code instead — the device stays signed in either way
    if (pick && pick.signIn) {
      try { return (await req('POST', '/v2/account/email/signin', { body: { purpose: 'authz', challenge: c.challenge, idToken: pick.signIn.idToken, spk: pick.signIn.spk, sig: pick.signIn.sig, ...(gk ? { gk: hexOf(gk) } : {}) } })).ticket } catch (e) { if (!(e && (e.status === 404 || e.status === 501))) throw e }
    }
    const { ticket } = await req('POST', '/v2/account/email/start', { body: { purpose: 'authz', challenge: c.challenge, address, ...(gk ? { gk: hexOf(gk) } : {}) } })
    const code = await getCode({ action: c.challenge, chose: !!pick })
    if (code && typeof code === 'object' && code.google) return (await req('POST', '/v2/account/email/google', { body: { purpose: 'authz', challenge: c.challenge, idToken: code.google, ...(gk ? { gk: hexOf(gk) } : {}) } })).ticket
    const v = await req('POST', '/v2/account/email/verify', { body: { ticket, code } })
    if (!v.verified) throw Object.assign(new Error('email_code_wrong'), { code: 'email_code_wrong' })
    return ticket
  }
  /** § 10.3 — when the challenge needs a security key: an assertion over SHA-256(T) by one of the account's active keys
   *  (the challenge lists them), never by `except` (key_remove must be proved by ANOTHER key). */
  async function keyProof(c, Tb, keys, except = null) {
    if (!c.needs.includes('hwkey')) return {}
    if (!keys) throw Object.assign(new Error('need_security_key'), { code: 'need_security_key' })
    const allow = (c.keys || []).filter((k) => k.id !== except)
    if (!allow.length) throw Object.assign(new Error('no_other_key'), { code: 'no_other_key' })
    return { hwkey: await keys.get({ challenge: await sha256(Tb), allow }) }
  }
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  /** A new code's parameters (§ 8.2): every value derived HERE from the new code and master, before anything is sent. */
  async function codeParams({ device, address, newCode, newMaster, backupId, wrapperId }) {
    const { gid: new_gid, gk } = await gateValues(newCode)
    const canonical = canonicalAddress(address)
    if (!canonical) fail('bad_address')
    return {
      new_gid, new_possession_pub: (await possessionKey(newCode)).spk, new_commit_email: await emailCommit(gk, canonical),
      new_members: [backupId, wrapperId], new_write_pub: (await backupWriteKey(newMaster)).spk, initiator_spk: device.spk,
    }
  }
  /** Stage both objects, read each back and check it, show the code (`confirmSaved`), then the one activation. */
  async function stageAndActivate({ rid, device, backupId, wrapperId, backupBlob, wrapperBlob, confirmSaved }) {
    const staged = {}
    for (const [name, id, blob] of [['backup', backupId, backupBlob], ['wrapper', wrapperId, wrapperBlob]]) {
      const st = await req('POST', `/v2/account/rotation/${rid}/stage`, { body: { id, blob: b64u(blob) }, signer: device })
      const back = unb64u((await req('GET', `/v2/account/rotation/${rid}/staged`, { query: { ver: st.ver }, signer: device })).blob)
      if (hexOf(await sha256(back)) !== st.digest || hexOf(await sha256(blob)) !== st.digest) fail('staged_mismatch')
      staged[name] = { ver: st.ver, digest: st.digest }
    }
    await confirmSaved({ rid }) // the caller keeps the new code with this session id BEFORE the activation below is sent
    return req('POST', `/v2/account/rotation/${rid}/commit`, { body: { backup: staged.backup, wrapper: staged.wrapper, idem: b64u(rand(16)) }, signer: device })
  }

  return {
    req,
    /** § 8.5 — this device's status; an answer that does not name this key AND echo this request's nonce is refused. */
    async deviceStatus(device) {
      const nonce = b64u(rand(9))
      const r = await req('GET', '/v2/account/device', { query: { nonce }, signer: device })
      if (r.spk !== device.spk || r.nonce !== nonce) throw Object.assign(new Error('status_mismatch'), { code: 'status_mismatch' })
      return r
    },

    /** § 8.1 — restore onto `device` (a new key) with the recovery code and an email code. → { sid, blobs: { [id]: bytes } } */
    async restore({ codeBytes, address, getCode, device, label = 'New device', keys = null }) {
      const { gid, gk } = await gateValues(codeBytes)
      const poss = await possessionKey(codeBytes)
      const params = { gid, restore_spk: device.spk, label }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'restore_authorize', gid, params } })
      // `address` may be asked only now (a function): the challenge has just shown the code IS an account here — a code the
      // service does not know answers 404 no_account above, before anyone is asked for an email (the normal Restore tries
      // this service first; an old account's restore must not cost an email prompt)
      const addr = typeof address === 'function' ? await address({ action: c.challenge }) : address
      const ticket = await emailProof(c, addr, getCode, gk)
      const Tb = T(c, 'restore_authorize', params)
      const proofs = { possession: await sigOf(poss, Tb), email_authz: ticket, ...(await keyProof(c, Tb, keys)) }
      const { sid } = await req('POST', '/v2/account/restore_authorize', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
      const { versions } = await req('GET', `/v2/account/restore/${sid}/versions`, { signer: device })
      const blobs = {}
      for (const id of [...new Set(versions.map((v) => v.id))]) {
        const got = await req('GET', `/v2/account/restore/${sid}/blob`, { query: { id }, signer: device })
        const bytes = unb64u(got.blob)
        if (hexOf(await sha256(bytes)) !== got.digest) throw Object.assign(new Error('blob_corrupt'), { code: 'blob_corrupt' }) // the bytes are the version committed
        blobs[id] = bytes
      }
      // R5-01: `try_again` = the account record changed between the service's read and its write (the session still
      // holds) — finishing again is safe and idempotent; a few attempts, then the error stands
      const finish = async () => {
        for (let i = 0; ; i++) {
          try { return await req('POST', `/v2/account/restore/${sid}/finish`, { signer: device }) } catch (e) { if (!(e && e.code === 'try_again') || i >= 2) throw e }
        }
      }
      return { sid, acct: c.acct, blobs, versions, finish, address: addr }
    },

    /** PROVE THE EMAIL, CHANGE NOTHING (the owner, 2026-11-22: "Show recovery code" had no check on an account on this service):
     *  the email check — the emailed code or Google — run against a fresh challenge, and nothing committed. A verified ticket is
     *  the proof; it expires unused. The challenge is a sign-out's (the one op every registered device may ask), never sent on.
     *  For a guard on THIS device only (the code it shows is already stored here) — never an authorisation at the service. */
    async proveEmail({ acct, device, address, getCode }) {
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'signout_others', acct, params: { initiator_spk: device.spk } } })
      await emailProof(c, address, getCode)
      return true
    },
    /** § 8.3 — sign out every other device. */
    async signoutOthers({ acct, device, address, getCode, keys = null }) {
      const params = { initiator_spk: device.spk }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'signout_others', acct, params } })
      const ticket = await emailProof(c, address, getCode)
      const Tb = T(c, 'signout_others', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, email_authz: ticket, ...(await keyProof(c, Tb, keys)) }
      return req('POST', '/v2/account/signout_others', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
    },
    /** Sign out ONE other device (its key `targetSpk`) — proved as signing out all of them: this device + an email code (+ a
     *  security key in Advanced). Every other device stays signed in. → { signed_out: true } */
    async signoutDevice({ acct, device, targetSpk, address, getCode, keys = null }) {
      const params = { initiator_spk: device.spk, device_spk: String(targetSpk || '') }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'signout_device', acct, params } })
      const ticket = await emailProof(c, address, getCode)
      const Tb = T(c, 'signout_device', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, email_authz: ticket, ...(await keyProof(c, Tb, keys)) }
      return req('POST', '/v2/account/signout_device', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
    },
    /** § 8.6 Add a device — THIS active device registers the new one's key. Standard: + an email code; Advanced: + a
     *  security key (no email; the challenge says which). */
    async enrolDevice({ acct, device, newSpk, label = '', address, getCode, keys = null }) {
      const params = { new_spk: newSpk, label: String(label || '').slice(0, 64), approver_spk: device.spk }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'enrol_device', acct, params } })
      const Tb = T(c, 'enrol_device', params)
      const ticket = (c.needs || []).includes('email_authz') ? await emailProof(c, typeof address === 'function' ? await address() : address, getCode) : null
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, ...(ticket ? { email_authz: ticket } : {}), ...(await keyProof(c, Tb, keys)) }
      return req('POST', '/v2/account/enrol_device', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
    },
    /** Release checklist 1.11 — delete this account on the service (as a sign-out is proved: this device + an email code). */
    async eraseAccount({ acct, device, address, getCode, keys = null, keep = null }) {
      // ⛔ 10·Q#3 (pass 10): a request whose answer was lost past these retries (offline, the page killed) is KEPT (`keep`) and a
      //   later run sends that same request again — the service answers with what it did. A new one is refused: the erase itself
      //   signed this device out; the deletion could never be finished, and the device was soon wiped with the Spaces still there.
      let body = keep && keep.get ? keep.get(acct) : null
      const resumed = !!body
      if (!body) {
        const params = { initiator_spk: device.spk }
        const c = await req('POST', '/v2/account/challenge', { body: { op: 'account_erase', acct, params } })
        const ticket = await emailProof(c, address, getCode)
        const Tb = T(c, 'account_erase', params)
        const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, email_authz: ticket, ...(await keyProof(c, Tb, keys)) }
        body = { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }
        if (keep && keep.set) await keep.set(acct, body) // durably kept before it is sent
      }
      // a LOST answer (no HTTP status: the network) is asked again with the SAME request and idempotency key — the service
      // answers with what it did (idemLookup); a new challenge would be refused, the device being signed out by the erase
      // itself (review, 2026-11-15: the app then looked as if nothing was deleted)
      for (let i = 0; ; i++) {
        try { const r = await req('POST', '/v2/account/erase', { body, signer: device }); if (keep && keep.clear) keep.clear(); return r } catch (e) {
          if (e && e.status) { if (resumed && keep && keep.clear) keep.clear(); throw e } // refused: a kept request is not sent again
          if (i >= 2) throw e
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
        }
      }
    },

    /** § 8.4 — the committed head, for merging. */
    syncRead: async (device, id) => { const r = await req('GET', `/v2/account/backup/${id}/head`, { signer: device }); return { ...r, blob: unb64u(r.blob) } },

    /** § 8.4 — upload and commit a new version over `prev`. `master` makes the write key; rg/epoch from the device's view. */
    async writeBackup({ device, acct, id, blob, prev, master, rg, epoch }) {
      const wk = await backupWriteKey(master)
      const up = await req('POST', `/v2/account/backup/${id}/upload`, { body: { blob: b64u(blob) }, signer: device })
      const nonce = b64u(rand(9)), ts = now()
      const write_sig = b64u(wk.sign(writeProofBytes({ acct, id, ver: up.ver, digest: up.digest, prev, rg, epoch, nonce, ts })))
      return req('POST', `/v2/account/backup/${id}/commit`, { body: { ver: up.ver, prev, nonce, ts, write_sig }, signer: device })
    },

    /** § 8.2 — a new recovery code. The caller has made the new code and master and sealed both blobs under them
     *  (`backupBlob` under the new master, `wrapperBlob` under the new code); `confirmSaved` shows the code and resolves
     *  once the person has saved it. Every new value is derived HERE, before authorising. */
    async rotate({ acct, device, address, getCode, newCode, newMaster, backupId, wrapperId, backupBlob, wrapperBlob, confirmSaved, keys = null }) {
      const params = await codeParams({ device, address, newCode, newMaster, backupId, wrapperId })
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'rotation_authorize', acct, params } })
      const ticket = await emailProof(c, address, getCode)
      const Tr = T(c, 'rotation_authorize', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tr) }, email_authz: ticket, ...(await keyProof(c, Tr, keys)) }
      const { rid } = await req('POST', '/v2/account/rotation_authorize', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
      return stageAndActivate({ rid, device, backupId, wrapperId, backupBlob, wrapperBlob, confirmSaved })
    },

    // § 11.5 — THE EMAIL RESET: an address whose account's recovery code (and devices) are lost moves to a NEW account after a
    // week, announced to the old account. Proved by `claim` email codes only — never Google, never a device or key of the old
    // account. The CLAIMANT is this device: its key signs the start and the finish.
    async claimTicket({ reset, address, getCode }) {
      const { ticket } = await req('POST', '/v2/account/email/start', { body: { purpose: 'claim', reset, address } })
      const v = await req('POST', '/v2/account/email/verify', { body: { ticket, code: await getCode() } }) // no { action }: no Google here
      if (!v.verified) throw Object.assign(new Error('email_code_wrong'), { code: 'email_code_wrong' })
      return ticket
    },
    /** Start: the intent, a claim code, the start — the week begins. → { reset, ready_at, expires } */
    async resetBegin({ device, address, getCode }) {
      const { reset } = await req('POST', '/v2/account/reset/intent', { body: { address, dest: 'new' }, signer: device })
      const ticket = await this.claimTicket({ reset, address, getCode })
      const r = await again(() => req('POST', `/v2/account/reset/${reset}/start`, { body: { ticket }, signer: device }))
      return { reset, ready_at: r.ready_at, expires: r.expires }
    },
    /** Finish, once the week is over: a NEW claim code, the claimant's signature → { acct } (a fresh account, this device in it). */
    async resetFinish({ device, reset, address, getCode, label = 'This device' }) {
      const ticket = await this.claimTicket({ reset, address, getCode })
      return again(() => req('POST', `/v2/account/reset/${reset}/finish`, { body: { ticket, label }, signer: device }))
    },
    /** Cancel: a claim code bound to this reset — from any device; nothing else cancels. */
    async resetCancel({ reset, address, getCode }) {
      const ticket = await this.claimTicket({ reset, address, getCode })
      return req('POST', `/v2/account/reset/${reset}/cancel`, { body: { ticket } })
    },

    /** § 11.5, 3a — a device of the account whose address is being moved asks for more time, once (the wait becomes 30 days
     *  from the move's start; it never cancels). → { ready_at, expires } */
    resetObject({ device, reset }) { return req('POST', `/v2/account/reset/${reset}/object`, { signer: device }) },
    /** § 11.5, 3a — the mover's own view of its move (claimant-signed). → { state, ready_at?, expires? } */
    resetState({ device, reset }) { return req('GET', `/v2/account/reset/${reset}`, { signer: device }) },

    /** § 12.4 — a new account on this device for an address that has none (an email code proves it). → { acct } */
    async freshAccount({ device, address, getCode, label = 'This device' }) {
      const { attempt } = await req('POST', '/v2/account/fresh/intent', { signer: device })
      const pick = await chooseFirst(getCode, attempt) // Google or the emailed code, asked before anything is mailed
      if (pick && pick.google) {
        const { ticket } = await req('POST', '/v2/account/email/google', { body: { purpose: 'new_identity', attempt, idToken: pick.google, address } })
        return again(() => req('POST', `/v2/account/fresh/${attempt}/commit`, { body: { ticket, label }, signer: device }))
      }
      const { ticket: sent } = await req('POST', '/v2/account/email/start', { body: { purpose: 'new_identity', attempt, address } })
      const code = await getCode({ action: attempt, chose: !!pick })
      let ticket = sent
      if (code && typeof code === 'object' && code.google) ticket = (await req('POST', '/v2/account/email/google', { body: { purpose: 'new_identity', attempt, idToken: code.google, address } })).ticket // Google in place of the code
      else {
        const v = await req('POST', '/v2/account/email/verify', { body: { ticket, code } })
        if (!v.verified) throw Object.assign(new Error('email_code_wrong'), { code: 'email_code_wrong' })
      }
      return again(() => req('POST', `/v2/account/fresh/${attempt}/commit`, { body: { ticket, label }, signer: device }))
    },

    /** § 8.2a — the FIRST recovery code of an account that has none: the device alone authorises it. */
    async setupCode({ acct, device, address, newCode, newMaster, backupId, wrapperId, backupBlob, wrapperBlob, confirmSaved }) {
      const params = await codeParams({ device, address, newCode, newMaster, backupId, wrapperId })
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'setup_code', acct, params } })
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, T(c, 'setup_code', params)) } }
      const { rid } = await req('POST', '/v2/account/setup_code', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
      return stageAndActivate({ rid, device, backupId, wrapperId, backupBlob, wrapperBlob, confirmSaved })
    },

    /** R2-03 — this device's rotation session, by the service's clock: { state, live }. */
    /** R3-01: close this device's code-change session if it can no longer commit (a write that races the commit). */
    rotationClose: (device, rid) => req('POST', `/v2/account/rotation/${rid}/close`, { body: {}, signer: device }),
    /** § 8.8 (release checklist 1.6): this device's sealed push address ({} = none); the signed-out devices' to remove; one done. */
    devicePush: (device, body) => req('POST', '/v2/account/device/push', { body, signer: device }),
    signedOutPush: (device) => req('GET', '/v2/account/devices/signed_out', { signer: device }),
    markPushPruned: (device, target, hash) => req('POST', '/v2/account/devices/push_pruned', { body: { device: target, hash }, signer: device }),
    /** Which of `spks` are still this account's devices → { states: { <spk>: 'active' | 'provisional' | 'revoked' | 'not_ours' } }
     *  (a computer paired for Code, in the account's computers list: codeComputers.js signedOutIds). */
    listDevices: (device) => req('GET', '/v2/account/devices', { signer: device }), // the account's devices that count (Your devices)
    deviceStates: (device, spks) => req('POST', '/v2/account/devices/state', { body: { spks }, signer: device }),
    /** § 8.8: an active device's approval of the person's next AWS key (the mint requires it once a sign-out gated it). */
    awsStatement: (device, signPub) => req('POST', '/v2/account/aws_statement', { body: { signPub }, signer: device }),
    /** docs/device-gate-design.md: an active device's ten-minute room pass for its session key → { pass, sig, exp }. */
    roomPass: (device, email, sessionPub) => req('POST', '/v2/account/room_pass', { body: { email, sessionPub }, signer: device }),

    /** The account's mode and active keys (an active device only). */
    security: (device) => req('GET', '/v2/account/security', { signer: device }),

    /** § 10.1 / § 10.4 — turn Advanced on (`advanced_on`: every slot the service asks for, two keys) or add a key
     *  (`key_add`: one slot, and an existing key proves it at authorise AND at finish). `onStep({ step, slot, of })` tells
     *  the screen which key to touch: 'register' a new key, 'confirm' a new key (it proves it works), 'existing' an old one.
     *  The finishing transcript is built HERE from what this device knows — never signed as the server hands it. */
    async enrolKeys({ acct, device, address, getCode, keys, purpose = 'advanced_on', onStep = () => {} }) {
      if (!keys) fail('need_security_key')
      const params = { purpose, initiator_spk: device.spk }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'enrol_authorize', acct, params, ctx: { purpose } } })
      const ticket = await emailProof(c, address, getCode)
      const Ta = T(c, 'enrol_authorize', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Ta) }, email_authz: ticket, ...(await keyProof(c, Ta, keys)) }
      const { eid, slots } = await req('POST', '/v2/account/enrol_authorize', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
      const made = []
      for (const [i, slot] of slots.entries()) {
        onStep({ step: 'register', slot, index: i, of: slots.length })
        const o = await req('POST', `/v2/account/enrol/${eid}/options`, { body: { slot }, signer: device })
        const att = await keys.create(o.publicKey)
        const r = await req('POST', `/v2/account/enrol/${eid}/register`, { body: { slot, attestation: att }, signer: device })
        made.push({ id: r.credId, transports: att.transports || [] })
      }
      const f = await req('POST', `/v2/account/enrol/${eid}/finish_challenge`, { signer: device })
      const creds = made.map((m) => m.id).sort()
      if (JSON.stringify(f.creds) !== JSON.stringify(creds)) fail('keys_mismatch') // the service must name exactly the keys this device registered
      const Tf = transcript({ op: purpose, acct: c.acct, params: { session: eid, creds }, challenge: eid, nonce: f.nonce, exp: f.exp, pv: c.pv, rg: c.rg, ev: c.ev, epoch: c.epoch })
      const ch = await sha256(Tf)
      const assertions = []
      for (const [i, m] of made.entries()) {
        onStep({ step: 'confirm', index: i, of: made.length })
        assertions.push(await keys.get({ challenge: ch, allow: [m] }))
      }
      if (purpose === 'key_add') {
        onStep({ step: 'existing' })
        assertions.push(await keys.get({ challenge: ch, allow: (f.active || []).filter((k) => !creds.includes(k.id)) }))
      }
      return req('POST', `/v2/account/enrol/${eid}/finish`, { body: { device_sig: await sigOf(device, Tf), assertions, idem: b64u(rand(16)) }, signer: device })
    },

    /** § 10.4 — remove a key, proved by another one. */
    async removeKey({ acct, device, address, getCode, keys, credId }) {
      const params = { cred_id: credId }
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'key_remove', acct, params } })
      const ticket = await emailProof(c, address, getCode)
      const Tb = T(c, 'key_remove', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, email_authz: ticket, ...(await keyProof(c, Tb, keys, credId)) }
      return req('POST', '/v2/account/key_remove', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
    },

    /** Turn Advanced off (every key retired). */
    async advancedOff({ acct, device, address, getCode, keys }) {
      const params = {}
      const c = await req('POST', '/v2/account/challenge', { body: { op: 'advanced_off', acct, params } })
      const ticket = await emailProof(c, address, getCode)
      const Tb = T(c, 'advanced_off', params)
      const proofs = { device: { spk: device.spk, sig: await sigOf(device, Tb) }, email_authz: ticket, ...(await keyProof(c, Tb, keys)) }
      return req('POST', '/v2/account/advanced_off', { body: { challenge: c.challenge, params, proofs, idem: b64u(rand(16)) }, signer: device })
    },
  }
}
