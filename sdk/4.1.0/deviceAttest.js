// deviceAttest.js — THE DEVICE HALF of the attested client (docs/the-attested-client.md § The wire). A native shell
// (android/attested-client) exposes ONE small bridge, `window.WitbitzAttest`, and this module turns it into what a turn
// needs: a fresh room challenge + a platform assertion bound to it and to the member's signing key.
//
//   bridge.platform() → 'android' | 'ios' | 'macos' | 'windows' | 'clouddevice' (the cloud device's enclave, cloud-device/attestBridge.mjs)   bridge.keyId() → the enrolled hardware key's id, or ''
//   ('macos': the Mac app's App Attest, macOS 27+ — the iPhone's shapes, its own platform name)
//   bridge.activate(credential, secret) → JSON { secret }   (Windows only: enrolment's second step, docs/windows-attestation.md)
//   bridge.enroll(bound) → JSON { keyId, chain }     (Android: a NEW Keystore key attested to `bound`; its X.509 chain)
//   bridge.sign(bound)   → base64 signature          (ECDSA by that key over the UTF-8 bytes of `bound`)
//
// `bound` = bindHash(spk, chal) — the SAME value agent/attestation.mjs recomputes (canon JSON, SHA-256, base64url), so the
// hardware signature covers exactly what the server checks. Enrollment happens ONCE per device key (op 'attest-enroll',
// clientAttestVerifiers.mjs) and is remembered; a server answer of `device_not_enrolled` forgets it, so the next send
// enrolls a fresh key. Without a bridge, or before the first poll has brought a challenge, a turn goes out unattested —
// the server decides whether the room requires more (rooms without `requireAttestation` never notice this module).
//
// This is NOT the client-release attestation (`clientAttestation` on reads, spaceClient.setAttestProvider): that one says
// "this page is a known build"; this one says "this signing key lives in this genuine device's hardware".
const BRIDGE = 'WitbitzAttest'
const RETRY_MS = 10 * 60_000 // after a failed enrollment, do not try again on every send
// A "NO" TO THE ADMINISTRATOR PROMPT (or the device's own refusal) holds for a DAY against every automatic proof (state machines
// pass 9, X#5): it lapsed with RETRY_MS, and the next automatic read of an attested Windows room put the prompt up again every ten
// minutes. Not every surface that shows this refusal has a Retry — a refused read is a toast, the attested-backup pull and the key
// backup show nothing, an SDK app's are its builder's — so it is not final; the person's own Retry (retryNow({ person: true }))
// still asks at once.
const DECLINED_MS = 24 * 3600_000
const MEMO_KEY = 'attest:device'

/** The native bridge, when the page runs inside the attested shell; null in a browser. */
export function deviceBridge (w = globalThis) {
  const b = w && w[BRIDGE]
  return b && typeof b.sign === 'function' && typeof b.enroll === 'function' ? b : null
}

// canon + bindHash: byte-for-byte the agent's (agent/attestation.mjs) — held equal by spaces/test/deviceAttest.test.mjs.
function canon (o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']'
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
}
const b64url = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export async function bindHash (spk, challenge) {
  const bytes = new TextEncoder().encode(canon({ spk: spk || null, challenge: String(challenge || '') }))
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

// The latest server challenge per room, as the polls bring it (spaceClient poll/pollSealed answer `challenge`), WITH when it came:
// the server takes a challenge for 120 s, so one older than CHAL_FRESH_MS is not offered — a held send, or a continuation for a room
// no longer polled, would bind a stale one and be refused "challenge stale" (state machines E#3). The callers fetch a fresh one when
// challengeFor answers null (space.js: a pollSealed before the turn).
export const CHAL_FRESH_MS = 90_000
const challenges = new Map()
export function noteChallenge (room, r) { const c = r && r.challenge; if (room && typeof c === 'string' && c) challenges.set(room, { chal: c, at: Date.now() }) }
export const challengeFor = (room, t = Date.now()) => { const e = challenges.get(room); return e && t - e.at <= CHAL_FRESH_MS ? e.chal : null }
// A K_att step's challenge is the SENTINEL's, not a room's: the enrol op (spaceHandler attest-enroll) checks a ROOM challenge, so an
// enrolment started from one is refused, and its pause held every waiting caller (E#4). A device enrols from a Space or a backup.
const enrollableScope = (room) => enclaveOfScope(room) !== 'sentinel'

const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: (k) => { m.delete(k) } } }

/** makeDeviceAttest({ bridge, client, storage, now, log }) → { attestFor({ room, spk }), noteAnswer(r), enrolledKeyId() }.
 *  `client.attestEnroll({ room, chal, spk, enroll })` is spaceClient's op 'attest-enroll'. */
// enclaveFor(room) → 'turn' | 'sentinel' | null: which ENCLAVE will check this proof — a Windows key is activated by each enclave itself
// (agent/winActivation.mjs; docs/windows-attestation.md § Enclaves), once, before its first proof there. Default: from the scope alone.
export const enclaveOfScope = (room) => (/^attkey:/.test(String(room)) ? 'sentinel' : /^confidential-[a-z-]*backup:/.test(String(room)) ? 'turn' : null)
// locks: navigator.locks — the room page and a warmed lane panel are two documents with one memo and one TPM key (E#1)
// sleep: the wait between step-2 retries (a test passes an instant one)
const isRefusal = (r) => !!r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 // the server SAID no; else the answer was lost
// build: this app build's id (space.js APP_BUILD) — AN ANDROID KEY IS MADE AGAIN AFTER AN UPDATE. Android writes the app's versionCode
// into a key's attestation when the key is MADE and never again, so a phone updated since kept proving the version it had then (the
// owner's phone, 2026-11-19: on 0.1.3, its key from version 2 — the device check said "version 2 is not an approved release").
// The memo names the build that made the key; another build enrols a new one (silent on Android). '' / the unstamped placeholder
// (dev, tests, the SDK) → never. enrolFrom(): → { room, spk } | null — a Space this page is in, for "Verify this device" to enrol from.
export const PI_EVERY_MS = 29 * 60_000 // a check every 29 minutes (the owner, 2026-11-22), under the server's 30-minute verdict (agent/playIntegrity.mjs VERDICT_MS)
const PI_BACKOFF_MIN_MS = 60_000, PI_BACKOFF_MAX_MS = 10 * 60_000
export function makeDeviceAttest ({ bridge: bridgeOpt = deviceBridge(), client, storage = null, now = () => Date.now(), log = () => {}, enclaveFor = enclaveOfScope, locks = undefined, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), build = '', enrolFrom = null, freshChallenge = null } = {}) { // freshChallenge(room) → a fresh challenge from that Space (a poll), for the verify step
  const BUILD = typeof build === 'string' && build && !/^__/.test(build) ? build : ''
  // ONE ENROLMENT / ACTIVATION PER DEVICE, across documents (E#1): each document's bridge knows only the key IT enrolled, and each
  // TPM Enroll replaces the one key — two documents enrolling in turn re-enrolled each other on every attested send (an
  // administrator prompt each). Held under a lock, the memo re-read once it is held: what another document did meanwhile counts.
  const withLock = (name, fn) => {
    const l = locks !== undefined ? locks : (globalThis.navigator && globalThis.navigator.locks)
    return l && typeof l.request === 'function' ? l.request(name, fn) : fn()
  }
  // `bridge` may be a FUNCTION, asked at each use (a native shell's bridge may appear after this was made).
  const getBridge = () => { try { return typeof bridgeOpt === 'function' ? bridgeOpt() : bridgeOpt } catch { return null } }
  const store = storage || (() => { try { return globalThis.localStorage || memoryStorage() } catch { return memoryStorage() } })()
  const readMemo = () => { try { return JSON.parse(store.getItem(MEMO_KEY) || 'null') || {} } catch { return {} } }
  const writeMemo = (m) => { try { store.setItem(MEMO_KEY, JSON.stringify(m)) } catch { /* private mode: enrollment is simply re-done next launch */ } }
  const platform = () => { try { return String(getBridge().platform ? getBridge().platform() : 'android') } catch { return 'android' } }
  /** An Android key another build of the app made (or one from before the memo named its build): its attestation names an older version. */
  const outdated = (m) => !!BUILD && platform() === 'android' && !!(m && m.keyId) && m.build !== BUILD
  let lastWhy = ''
  // Play Integrity's pace (integrityDueFor): when a token last went, Google's back-off, the server's ask, one ask at a time
  const pi = { lastAt: -Infinity, force: false, inflight: false, backoffUntil: 0, backoffMs: PI_BACKOFF_MIN_MS }

  /** Google Play's integrity token for a request bound to `bound` (requestHash = base64url SHA-256 of its UTF-8 bytes — the server's
   *  playIntegrity.requestHashOf), or '' (no such bridge, or Play said no — the reason goes to the log). */
  async function integrityFor (bound) {
    const b = getBridge()
    if (!b || typeof b.integrity !== 'function') return '' // (called as getBridge().integrity: spaces/test/androidShell.test.mjs pins every bridge call to the Kotlin)
    if (now() < pi.backoffUntil) return '' // Google said "too many requests": wait it out (below)
    try {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(bound))))
      const h = btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      let r = {}; try { r = JSON.parse(String((await getBridge().integrity(h)) || '{}')) } catch { r = {} }
      if (r && typeof r.token === 'string' && r.token) { pi.backoffMs = PI_BACKOFF_MIN_MS; return r.token }
      const err = String((r && r.error) || 'no answer')
      // -8 TOO_MANY_REQUESTS (the owner's phone, 2026-11-20 — it asked on every read): back off, doubling to 10 min, never hammer
      if (/^-8\b|TOO_MANY_REQUESTS|too many requests/i.test(err)) { pi.backoffUntil = now() + pi.backoffMs; log('attest: Play Integrity throttled — next try in ' + Math.round(pi.backoffMs / 1000) + ' s'); pi.backoffMs = Math.min(PI_BACKOFF_MAX_MS, pi.backoffMs * 2) }
      else log('attest: no Play Integrity token: ' + err.slice(0, 120))
    } catch (e) { log('attest: Play Integrity failed: ' + String((e && e.message) || e).slice(0, 120)) }
    return ''
  }
  // ONE TOKEN EVERY 29 MINUTES (owner, 2026-11-20: "B"; 2026-11-22: "A check every 29 minutes"; agent/playIntegrity.mjs checkIntegrityKept): the
  // server keeps a passing verdict for this key 30 minutes and a request without a token stands on it. So a token goes with the first attested request once
  // PI_EVERY_MS has passed since the last one (or at once when the server answered integrity_required), and only one is asked at a time.
  async function integrityDueFor (bound) {
    if (pi.inflight || (!pi.force && now() - pi.lastAt < PI_EVERY_MS)) return ''
    pi.inflight = true; const was = pi.lastAt; pi.lastAt = now()
    try { const t = await integrityFor(bound); if (t) pi.force = false; else pi.lastAt = was; return t } finally { pi.inflight = false }
  }

  // ── ONE ADMINISTRATOR PROMPT FOR EVERY ACTIVATION (2026-11-18, the owner: "Do it"; docs/windows-attestation.md § Enclaves). Each
  // activation is a TPM2_ActivateCredential, and Windows asks for administrator rights for each run: the Space server's (enrolment)
  // and each enclave's (turn, Sentinel) came at three different moments. A shell with `activateAll` (the Windows app since 2026-11-18)
  // answers every challenge that is due in ONE elevated run; an older shell keeps one prompt per activation.
  const ENCLAVES = ['turn', 'sentinel']
  const canBundle = () => { try { const b = getBridge(); return platform() === 'windows' && !!b && typeof b.activateAll === 'function' && !!client && typeof client.winAct === 'function' } catch { return false } }
  async function bridgeActivateAll (pairs) {
    let r
    try { r = JSON.parse(String((await getBridge().activateAll(pairs.map((p) => ({ credential: p.credential, secret: p.secret })))) || '{}')) } catch (e) { r = { error: 'bridge: ' + ((e && e.message) || e) } }
    if (!r || r.error || !Array.isArray(r.answers) || r.answers.length !== pairs.length) return { error: (r && r.error) || 'no answer' }
    return { answers: r.answers }
  }
  /** The enclaves due an activation of `keyId` (not done, and not declined in the last day — `also` is asked regardless). */
  const enclavesDue = (keyId, also = null) => {
    const m = readMemo()
    return ENCLAVES.filter((to) => (m.act || {})[to] !== keyId && (to === also || !((m.actDeclined || {})[to] && now() - m.actDeclined[to] < DECLINED_MS)))
  }
  /** Each enclave's challenge (in parallel) → { starts: [{ to, s }], why: { to: reason } } for those that gave none. */
  async function enclaveStarts (keyId, tos) {
    const why = {}
    const got = await Promise.all(tos.map(async (to) => {
      const s = await client.winAct({ to, step: 'start', keyId }).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
      if (s && s.status === 200 && s.activate && s.ticket) return { to, s }
      why[to] = String((s && (s.reason || s.error)) || 'no answer')
      log('attest: activation refused (start, ' + to + '): ' + why[to])
      return null
    }))
    return { starts: got.filter(Boolean), why }
  }
  /** Each enclave's finish with the TPM's answer → { to: reason } for those not activated; the memo records the rest. */
  async function enclaveFinishes (keyId, starts, answers) {
    const why = {}
    for (const [i, { to, s }] of starts.entries()) {
      const a = answers[i] || {}
      if (!a.secret) {
        why[to] = 'activation: ' + (a.error || 'no answer')
        const m = readMemo(); writeMemo({ ...m, actDeclined: { ...(m.actDeclined || {}), [to]: now() } })
        log('attest: activation refused (' + to + '): ' + why[to])
        continue
      }
      const f = await client.winAct({ to, step: 'finish', keyId, activation: a.secret, ticket: s.ticket }).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
      if (!f || f.status !== 200) { why[to] = String((f && (f.reason || f.error)) || 'no answer'); log('attest: activation refused (finish, ' + to + '): ' + why[to]); continue }
      const m = readMemo(); const ad = { ...(m.actDeclined || {}) }; delete ad[to]
      writeMemo({ ...m, actDeclined: ad, act: { ...(m.act || {}), [to]: keyId } })
      log('attest: activated with the ' + to + ' enclave')
    }
    return why
  }
  /** Activate `keyId` with every enclave in `tos` — one administrator prompt. → { to: reason } for those not activated. */
  async function activateMany (keyId, tos) {
    log('attest: activating (windows) with ' + tos.join(' + ') + ' — one administrator prompt')
    const { starts, why } = await enclaveStarts(keyId, tos)
    if (Object.values(why).some((w) => /windows_reenroll|device_not_enrolled/.test(w))) { const m = readMemo(); writeMemo({ platform: m.platform }); log('attest: the server asks this key to enrol again'); return why } // the next proof enrols afresh
    if (!starts.length) return why
    const all = await bridgeActivateAll(starts.map((x) => x.s.activate))
    if (all.error) {
      const m = readMemo(), ad = { ...(m.actDeclined || {}) }
      for (const { to } of starts) { ad[to] = now(); why[to] = 'activation: ' + all.error }
      writeMemo({ ...m, actDeclined: ad })
      log('attest: activation refused (' + starts.map((x) => x.to).join(' + ') + '): ' + all.error)
      return why
    }
    return { ...why, ...(await enclaveFinishes(keyId, starts, all.answers)) }
  }

  // ONE ENROLMENT AT A TIME (the Windows app, 2026-11-09: four enrolment requests at once — the first message and the key backup each
  // enrolled, and each bridge.enroll makes a NEW key, replacing the one the other was activating). A second caller waits for the
  // first and then signs with the key it enrolled; it never starts its own.
  let enrolling = null
  // `stale`: the key this caller judged wrong (null when the memo had none) — under the lock, a memo naming any OTHER key means
  // another document enrolled while this one waited, and that key is used.
  function enroll (room, chal, spk, bound, stale = null) {
    if (!enrolling) {
      enrolling = withLock('witbitz-attest-enroll', async () => {
        const m = readMemo()
        if (m.keyId && m.keyId !== stale) return m.keyId
        return enrollOnce(room, chal, spk, bound)
      }).finally(() => { enrolling = null })
    }
    return enrolling
  }
  async function enrollOnce (room, chal, spk, bound) {
    const memo = readMemo()
    let bundled = null // the enclaves' challenges answered in the enrolment's own administrator prompt
    if (memo.failedAt && now() - memo.failedAt < (memo.declined ? DECLINED_MS : RETRY_MS)) return null // a "No": a day (X#5)
    log('attest: enrolling (' + platform() + ') for ' + String(room).slice(0, 40))
    let res
    // await: a bridge may answer a Promise (the cloud device) or a string (a native shell)
    try { res = JSON.parse(String((await getBridge().enroll(bound)) || '{}')) } catch (e) { res = { error: 'bridge: ' + ((e && e.message) || e) } }
    if (!res || res.error || !res.keyId) { writeMemo({ ...memo, failedAt: now(), reason: (res && res.error) || 'no key' }); log('attest: enroll refused by the device: ' + ((res && res.error) || 'no key')); return null }
    const p = platform()
    const enrollBody = p === 'ios' || p === 'macos' ? { platform: p, keyId: res.keyId, app: res.app, attestation: res.attestation }
      : p === 'windows' ? { platform: 'windows', keyId: res.keyId, ekChain: res.ekChain, ak: res.ak, key: res.key }
          : p === 'clouddevice' ? { platform: 'clouddevice', keyId: res.keyId, publicKeyJwk: res.publicKeyJwk, doc: res.doc } // the cloud device: its enclave's document over this key (cloud-device/attestBridge.mjs)
          : { platform: 'android', keyId: res.keyId, chain: res.chain }
    // ONLY A REFUSAL PAUSES (E#2): a lost answer (no network, a 5xx, a timeout) is tried again on the next proof. A 10-minute pause
    // for a blip outlived every retry of the attested-backup pull, and the attested rooms stayed missing until a relaunch.
    const refused = (r, step = '') => {
      const why = (r && (r.reason || r.error)) || 'no answer'
      const pause = r && r.device ? true : isRefusal(r) // r.device: the device or the person said no (the bridge, the admin prompt)
      // `declined`: the DEVICE or the PERSON said no (the administrator prompt) — only the person's own Retry asks again; the
      // automatic retries (the attested-backup pull's, every 30 s) used to clear the pause and prompt — and make a TPM key — each time
      writeMemo(pause ? { ...memo, failedAt: now(), reason: why, ...(r && r.device ? { declined: true } : {}) } : { ...memo, reason: why })
      log('attest: enrollment ' + (pause ? 'refused' : 'not answered') + (step ? ' (' + step + ')' : '') + ': ' + why + (r && r.status ? ' · HTTP ' + r.status : ''))
      return null
    }
    const send = (enroll) => client.attestEnroll({ room, chal, spk, enroll }).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
    let r = await send(enrollBody)
    if (!r || r.status !== 200) return refused(r, 'step 1')
    // WINDOWS, STEP 2 (docs/windows-attestation.md): the server's challenge, encrypted to the TPM's endorsement key and bound to the
    // attestation key — the shell answers it with TPM2_ActivateCredential (Windows asks for administrator rights for this, once)
    if (p === 'windows' && r.activate) {
      let a
      if (canBundle()) { // the enclaves' challenges now too — the Space server's and theirs in ONE administrator prompt
        const { starts } = await enclaveStarts(res.keyId, enclavesDue(res.keyId))
        const all = await bridgeActivateAll([r.activate, ...starts.map((x) => x.s.activate)])
        a = all.error ? { error: all.error } : all.answers[0]
        if (!all.error && starts.length) bundled = { starts, answers: all.answers.slice(1) }
        log('attest: one administrator prompt for the Space server' + (starts.length ? ' and the ' + starts.map((x) => x.to).join(' + ') + ' enclave' + (starts.length > 1 ? 's' : '') : ''))
      } else {
        try { a = JSON.parse(String((await getBridge().activate(r.activate.credential, r.activate.secret)) || '{}')) } catch (e) { a = { error: 'bridge: ' + ((e && e.message) || e) } }
      }
      if (!a || a.error || !a.secret) return refused({ device: true, reason: 'activation: ' + ((a && a.error) || 'no answer') })
      log('attest: activation answered by the TPM — sending step 2')
      // A LOST STEP-2 ANSWER (E#5): the server may have stored the device before its answer was lost. Sent again (the activation
      // stays good while the enrolment is pending); "no enrolment waiting" after a lost answer means the first one went through.
      // Still unanswered: kept as enrolled, unconfirmed — the next proof's answer says (device_not_enrolled forgets it) — rather
      // than a new key and another administrator prompt.
      const body2 = { platform: 'windows', keyId: res.keyId, activation: a.secret }
      r = await send(body2)
      let lost = false
      for (let i = 0; i < 2 && !(r && r.status === 200) && !isRefusal(r); i++) { lost = true; await sleep(2000 * (i + 1)); r = await send(body2) }
      if (lost && r && r.status === 409 && /no enrolment waiting/.test(String(r.reason || ''))) r = { status: 200 }
      if (!(r && r.status === 200) && !isRefusal(r)) {
        writeMemo({ keyId: res.keyId, platform: p, at: now(), unconfirmed: true })
        log('attest: step 2 not answered — the key is kept; the next proof tells whether the server holds it')
        if (bundled) await enclaveFinishes(res.keyId, bundled.starts, bundled.answers) // kept only if the server holds the key
        return res.keyId
      }
      if (!r || r.status !== 200) return refused(r, 'step 2')
    }
    writeMemo({ keyId: res.keyId, platform: p, at: now(), ...(BUILD ? { build: BUILD } : {}) })
    // A NEW KEY HAS NO PLAY INTEGRITY VERDICT on the server (it keeps one per key): the next request carries a token, not the one
    // due in up to 29 minutes (the owner's phone, 2026-11-23: after the update to versionCode 10 every request of its new key read
    // "would refuse — integrity_required" for 26 minutes in shadow; switched on, they would have been refused)
    pi.force = true
    log('attest: device enrolled (' + p + ')')
    if (bundled) await enclaveFinishes(res.keyId, bundled.starts, bundled.answers) // the enclaves' answers from the same prompt
    return res.keyId
  }

  // A WINDOWS KEY BEFORE AN ENCLAVE: start (the enclave's TPM challenge + its sealed ticket) → the TPM answers (Windows asks for
  // administrator rights) → finish (the front keeps the record the enclave sealed). Once per enclave per key; one at a time.
  const activating = {}
  function activateFor (to, keyId) {
    if (canBundle()) { // every enclave due, in one prompt; a second caller (the other enclave) waits for the same run
      if (!activating.all) {
        activating.all = withLock('witbitz-attest-activate', async () => {
          const m = readMemo()
          if ((m.act || {})[to] === keyId) return {} // another document activated it meanwhile
          const no = (m.actDeclined || {})[to]
          if (no && now() - no < DECLINED_MS) return { [to]: 'activation declined — tap Retry to be asked again' }
          return activateMany(keyId, enclavesDue(keyId, to))
        }).finally(() => { activating.all = null })
      }
      return activating.all.then((why) => ((readMemo().act || {})[to] === keyId ? '' : String((why && why[to]) || 'not activated')))
    }
    if (!activating[to]) {
      activating[to] = withLock('witbitz-attest-activate', async () => {
        const m = readMemo()
        if ((m.act || {})[to] === keyId) return '' // another document activated it meanwhile
        // a "No" to the administrator prompt holds for the pause, as an enrolment's does (state machines pass 8, W#1)
        const no = (m.actDeclined || {})[to]
        if (no && now() - no < DECLINED_MS) return 'activation declined — tap Retry to be asked again' // a day, as an enrolment's "No" (pass 9, X#5)
        return activateOnce(to, keyId)
      })
        .finally(() => { activating[to] = null })
    }
    return activating[to]
  }
  async function activateOnce (to, keyId) {
    if (!client || typeof client.winAct !== 'function') return 'no activation here'
    log('attest: activating (windows) with the ' + to + ' enclave')
    const s = await client.winAct({ to, step: 'start', keyId }).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
    if (!s || s.status !== 200 || !s.activate || !s.ticket) {
      const why = String((s && (s.reason || s.error)) || 'no answer')
      if (/windows_reenroll|device_not_enrolled/.test(why)) { const m = readMemo(); writeMemo({ platform: m.platform }); log('attest: the server asks this key to enrol again') } // the next proof enrols afresh
      log('attest: activation refused (start, ' + to + '): ' + why)
      return why
    }
    let a
    try { a = JSON.parse(String((await getBridge().activate(s.activate.credential, s.activate.secret)) || '{}')) } catch (e) { a = { error: 'bridge: ' + ((e && e.message) || e) } }
    if (!a || a.error || !a.secret) {
      const why = 'activation: ' + ((a && a.error) || 'no answer')
      const m = readMemo(); writeMemo({ ...m, actDeclined: { ...(m.actDeclined || {}), [to]: now() } })
      log('attest: activation refused (' + to + '): ' + why)
      return why
    }
    const f = await client.winAct({ to, step: 'finish', keyId, activation: a.secret, ticket: s.ticket }).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
    if (!f || f.status !== 200) { const why = String((f && (f.reason || f.error)) || 'no answer'); log('attest: activation refused (finish, ' + to + '): ' + why); return why }
    const m = readMemo(); const { actDeclined: _d, ...kept } = m; writeMemo({ ...kept, act: { ...(m.act || {}), [to]: keyId } })
    log('attest: activated with the ' + to + ' enclave')
    return ''
  }

  return {
    enrolledKeyId: () => readMemo().keyId || null,
    /** The turn fields to add: { chal, attestation } — or null when this turn cannot be attested (no bridge, no challenge yet, enrollment refused). */
    /** Why the last attestFor made no proof — said under a refused post ("attestation: missing"; the first real test on a phone,
     *  2026-11-07, could not tell which). '' when it made one. */
    lastWhy: () => lastWhy,
    /** Forget a refused enrolment's pause (RETRY_MS keeps automatic sends from re-trying each time). `person`: the person tapped
     *  Retry — only that also forgets a "No" they gave the administrator prompt; an automatic retry leaves it standing. */
    retryNow: ({ person = false } = {}) => {
      const m = readMemo()
      if (m.declined && !person) return
      if (m.failedAt || m.actDeclined) { const { failedAt: _f, reason: _r, declined: _d, actDeclined: _a, ...rest } = m; writeMemo(person ? rest : { ...rest, ...(m.actDeclined ? { actDeclined: m.actDeclined } : {}) }) }
    },
    async attestFor ({ room, spk = null } = {}) {
      lastWhy = ''
      if (!getBridge() || !client) { lastWhy = 'no hardware bridge on this page'; return null }
      const chal = challengeFor(room)
      if (!chal) { lastWhy = 'no challenge from the Space yet'; return null }
      const bound = await bindHash(spk, chal)
      const memoKey = readMemo().keyId || null
      let keyId = memoKey
      let deviceKey = ''
      try { deviceKey = String(getBridge().keyId ? getBridge().keyId() : '') } catch { deviceKey = '' }
      // the device's key moved under us (Android: the Keystore's own key). NOT on Windows: its bridge answers the key enrolled in
      // THIS document, so after another document enrolled it names an older key — the shared memo is the device's truth (E#1);
      // a key the server does not hold comes back as device_not_enrolled and is forgotten (noteAnswer).
      const moved = platform() !== 'windows' && !!deviceKey && deviceKey !== keyId
      const old = !moved && outdated(readMemo()) // the app was updated since this key was made: a new key, attested as THIS version
      if (!keyId || moved) {
        if (!enrollableScope(room)) { lastWhy = 'this device is not enrolled yet — it enrols from a Space, not from the key step'; return null }
        keyId = await enroll(room, chal, spk, bound, memoKey) // first run, or the device's key moved under us
      } else if (old && enrollableScope(room)) {
        // …and if that enrolment does not go through (offline, refused), the key it has still stands at the server: this turn uses it
        const fresh = await enroll(room, chal, spk, bound, memoKey)
        if (fresh) keyId = fresh; else log('attest: the key from an older build is kept — a new one could not be enrolled now')
      }
      if (!keyId) { const m = readMemo(); lastWhy = 'enrolment refused: ' + String(m.reason || 'unknown').slice(0, 120); return null }
      const to = platform() === 'windows' ? (() => { try { return enclaveFor(room) } catch { return null } })() : null
      if (to && (readMemo().act || {})[to] !== keyId) { const why = await activateFor(to, keyId); if (why) { lastWhy = 'windows activation (' + to + '): ' + String(why).slice(0, 120); return null } }
      let sig
      try { sig = String((await getBridge().sign(bound)) || '') } catch (e) { lastWhy = 'signing failed: ' + String((e && e.message) || e).slice(0, 100); log('attest: sign failed: ' + ((e && e.message) || e)); return null }
      if (!sig) { lastWhy = 'the device gave no signature'; return null }
      const p = platform()
      // ANDROID'S VERSION PER REQUEST (docs/build-enclave.md § 5.1 step 5; agent/playIntegrity.mjs): Google Play's verdict for THIS
      // request — its requestHash is SHA-256 of the same `bound` the hardware key signed — carries the versionCode of the app actually
      // running; the server holds it to the build enclave's log. A shell without it (older APK) sends none; the server decides.
      if (p === 'clouddevice') return { chal, attestation: { platform: 'clouddevice', keyId, bound, sig } } // its enclave key's signature (clientAttestVerifiers.mjs clouddevice)
      const integrity = p === 'android' ? await integrityDueFor(bound) : ''
      return { chal, attestation: p === 'ios' || p === 'macos' ? { platform: p, keyId, bound, assertion: sig } : { platform: p === 'windows' ? 'windows' : 'android', keyId, bound, sig, ...(integrity ? { integrity } : {}) } }
    },
    /** "VERIFY THIS DEVICE" (docs/device-verify.md): sign a checker's nonce with the enrolled hardware key and send it. →
     *  { ok, key } where `key` is computed HERE from this device's own key id (the code the checker compares), or
     *  { ok: false, reason }. Never a verdict: a page cannot vouch for itself — the checker on the other device decides. */
    async verifyThisDevice (nonce) {
      const n = String(nonce || '').replace(/^witbitz-verify:/, '').trim()
      if (!/^[A-Za-z0-9_-]{22,64}$/.test(n)) return { ok: false, reason: 'that is not a verification code' }
      if (!getBridge() || !client || !client.deviceVerify) return { ok: false, reason: 'this is not the Witbitz app (no hardware key here)' }
      let keyId = readMemo().keyId || ''
      // ENROL HERE, from the Space this page is in (an enrolment needs a Space's fresh challenge, nothing of the Space itself) — so the
      // check names the version running and needs no attested Space first. The challenge is ASKED for when none is fresh (the owner,
      // 2026-11-23: "Not sent: device_not_enrolled" — a challenge came only before a turn that needed one, so after an app update the
      // phone signed with a key the server had never seen).
      const enrolHere = async (stale) => {
        if (typeof enrolFrom !== 'function') return null
        let from = null; try { from = enrolFrom() } catch { from = null }
        if (!from || !from.room || !enrollableScope(from.room)) return null
        let chal = challengeFor(from.room)
        if (!chal && typeof freshChallenge === 'function') { try { chal = (await freshChallenge(from.room)) || challengeFor(from.room) } catch { chal = null } }
        if (!chal) return null
        return enroll(from.room, chal, from.spk || null, await bindHash(from.spk || null, chal), stale).catch(() => null)
      }
      if (!keyId || outdated(readMemo())) { const k = await enrolHere(keyId || null); if (k) keyId = k }
      if (!keyId) { try { keyId = String(getBridge().keyId ? getBridge().keyId() : '') } catch { keyId = '' } }
      if (!keyId) return { ok: false, reason: 'this device has no enrolled key yet — open a Space, then try again' }
      let sig
      try { sig = String((await getBridge().sign('witbitz-device-verify/1:' + n)) || '') } catch (e) { return { ok: false, reason: 'the hardware key did not sign' } }
      if (!sig) return { ok: false, reason: 'the hardware key did not sign' }
      const p = platform()
      // Android: Google Play's verdict for THIS check too (the version actually running; agent/playIntegrity.mjs) — a turn sends one,
      // and a checker that holds the version to the log must get one here as well, or ANDROID_INTEGRITY=1 refuses every device check
      const integrity = p === 'android' ? await integrityFor('witbitz-device-verify/1:' + n) : ''
      const ask = (k, s) => client.deviceVerify(p === 'ios' || p === 'macos' ? { platform: p, keyId: k, nonce: n, assertion: s } : { platform: 'android', keyId: k, nonce: n, sig: s, ...(integrity ? { integrity } : {}) })
      let r = await ask(keyId, sig)
      // THE SERVER DOES NOT KNOW THIS KEY: enrol it now and ask once more, signed by the key just enrolled
      if (r && /device_not_enrolled/.test(String(r.error || r.reason || ''))) {
        const k = await enrolHere(keyId || null)
        if (k) {
          let s2 = ''; try { s2 = String((await getBridge().sign('witbitz-device-verify/1:' + n)) || '') } catch { s2 = '' }
          if (s2) { keyId = k; r = await ask(keyId, s2) }
        }
      }
      const own = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyId))), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8)
      if (!r || r.status && r.status !== 200 || r.ok === false) return { ok: false, reason: (r && (r.error || r.reason)) || 'the server did not take it', key: own }
      return { ok: true, key: own } // OUR code, from our own key id — not the server's echo
    },
    /** Read the server's answer to a turn: an unenrolled key is forgotten, so the next send enrolls again. */
    noteAnswer (r) {
      const reason = r && r.status === 403 ? String(r.reason || '') : ''
      if (/integrity_required/.test(reason)) { pi.force = true; log('attest: the server holds no fresh Play Integrity verdict — the next request carries a token') }
      if (/device_not_enrolled/.test(reason)) { const m = readMemo(); writeMemo({ platform: m.platform }); log('attest: the server does not know this key — will enroll again') }
      if (/windows_needs_activation/.test(reason)) { const m = readMemo(); const { act: _a, ...rest } = m; writeMemo(rest); log('attest: an enclave does not know this key\'s activation — will activate again') }
    },
  }
}
