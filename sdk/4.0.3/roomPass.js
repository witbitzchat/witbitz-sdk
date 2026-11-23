// roomPass.js — the APP'S HALF of the room pass (docs/device-gate-design.md § 4 A1–A2, revised in § 10). A device on the new
// account service holds a session key K (ECDSA P-256, NON-EXTRACTABLE, one a day), gets a ten-minute pass for it from the account
// service (POST /v2/account/room_pass, signed by the device key) and renews it in the background before it ends; every request
// to a verified Space that carries the sign-in also carries `pass` and `psig` — K's signature over { op, room, ts, nonce, the
// pass's hash, the sign-in key's nonce } (agent/roomPass.mjs verifies it). A refusal `revoked` means this device was signed out:
// `onRevoked` runs the status check, which removes the account (acctV2Check.js).
//
// Pure and injectable — each app wires it (roomPassWiring; the hosted vault's acctV2VaultWiring; a builder's vault-core) only behind
// its switch (ROOM_PASS_APP, below); nothing here runs unless asked.
//   makeRoomPass({ ask(email, sessionPub) → { pass, sig, exp } (throws { code }), store?: { get(k), set(k, v) } (IndexedDB:
//                  a CryptoKey survives structured clone, its private half never leaves the browser), now?, onRevoked? })
export const PASS_PURPOSE = 'witbitz-room-pass'
export const REQ_PURPOSE = 'witbitz-room-req'
export const KEY_LIFE_MS = 86_400_000 // the owner, 2026-11-16: "one a day, across Spaces"
export const RENEW_BEFORE_S = 120 // a pass with less than this left is renewed before it is used
export const MAX_TS_SHIFT_MS = 86_400_000 // a caller's request time further than this from the clock here is not believed (= mkseal MAX_CLOCK_OFFSET_MS)
const STORE_KEY = 'roompass:k1'
const enc = new TextEncoder()
const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const unb64uText = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))) }
const subtle = () => globalThis.crypto.subtle
const canon = (o) => { if (o === null || typeof o !== 'object') return JSON.stringify(o); if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']'; return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}' }
/** = agent/spaceOidc.mjs spkNonce: base64url(SHA-256(canonical JWK)). */
export async function spkNonce (spk) { return b64u(new Uint8Array(await subtle().digest('SHA-256', enc.encode(canon(spk))))) }
const sha256hex = async (s) => [...new Uint8Array(await subtle().digest('SHA-256', enc.encode(String(s))))].map((b) => b.toString(16).padStart(2, '0')).join('')
const randNonce = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(12)))
/** = agent/roomPass.mjs psigBytes. */
export const psigBytes = ({ op, room, ts, nonce, ph, sk }) => enc.encode(REQ_PURPOSE + '\n' + JSON.stringify({ v: 1, op: String(op), room: String(room), ts, nonce: String(nonce), ph, sk }))
/** The pass's own fields (unverified here: the server is the judge) → { email, exp, sessionPub } | null. */
export const passFields = (pass) => { try { const p = JSON.parse(unb64uText(pass.p)); return p && typeof p === 'object' ? p : null } catch { return null } }

/** The sign-in a request body carries (top level, or the turn's message) → { email, spk } | null. */
export function signInOf (body) {
  const m = body && body.message && typeof body.message === 'object' ? body.message : null
  const tok = (body && typeof body.idToken === 'string' && body.idToken) || (m && typeof m.idToken === 'string' && m.idToken) || ''
  const spk = (body && body.idToken && body.spk) || (m && m.idToken && m.spk) || null
  if (!tok || !spk) return null
  try { const p = JSON.parse(unb64uText(tok.split('.')[1])); const email = typeof p.email === 'string' ? p.email.trim().toLowerCase() : ''; return email.includes('@') ? { email, spk } : null } catch { return null }
}

export const REVOKED_RETRY_MS = 5 * 60_000 // after `revoked`, ask the account service again this much later (see makeRoomPass)
// WHY A REQUEST WENT WITHOUT A PASS (the owner, 2026-11-22: "yes" to fixing the bursts the Lambda's cutoff refuses — docs/TODO.md § "Lock a
// signed-out device out of rooms"). Our own apps sent requests without one in short bursts at launch (the hosted vault answered "none"
// without asking the service: its account was not there yet), and once for 10 minutes (Windows, 11-17: the service refused, and every
// refused request asked again — 365 asks in 13 minutes). So: after a refusal that says a pass is required, the renewal WAITS a little for
// this device's account (ACCOUNT_WAIT_MS); after the service refuses or does not answer, it is not asked again at once (backoff); and
// each "none" says why, once in a while, in the device's trail (`note`).
export const ACCOUNT_WAIT_MS = 8_000 // a Space said a pass is required: how long to wait for this device's account (the app may still be starting)
export const NO_ACCOUNT_QUIET_MS = 60_000 // …and not wait again for this long once a wait found none (a device with no account would wait on every request)
export const REFUSED_BACKOFF_MS = 60_000 // the account service refused a pass: asked again after this, not on every refused request
export const FAILED_BACKOFF_MS = 10_000 // the account service did not answer (the network, a 5xx): asked again after this
export const NOTE_EVERY_MS = 30_000 // the same trail line at most this often

/** `get` (sync or async) until it gives something, or `ms` has passed → it | null. Never throws. */
export async function waitFor (get, { ms = ACCOUNT_WAIT_MS, step = 200, now = () => Date.now(), sleep = (t) => new Promise((r) => setTimeout(r, t)) } = {}) {
  const until = now() + ms
  for (;;) {
    let v = null
    try { v = await get() } catch { v = null }
    if (v) return v
    if (now() >= until) return null
    await sleep(step)
  }
}
/** A trail writer that says the same line at most once per `ms`. `note` absent → says nothing. */
export function makeNoter (note, { ms = NOTE_EVERY_MS, now = () => Date.now() } = {}) {
  const last = new Map()
  return (line) => {
    if (typeof note !== 'function') return
    const t = now()
    if (t - (last.get(line) || 0) < ms) return
    last.set(line, t)
    try { note(String(line)) } catch { /* a trail line is never worth an error */ }
  }
}
const askWhy = (err) => String((err && (err.code || (err.status ? 'http_' + err.status : err.message))) || 'no answer').slice(0, 60)
const refusedByService = (err) => !!err && (err.code === 'no_pass' || (Number(err.status) >= 400 && Number(err.status) < 500))

export function makeRoomPass ({ ask, store = null, now = () => Date.now(), onRevoked = null, note = null } = {}) {
  const say = makeNoter(note, { now })
  let backoffUntil = 0, backoffWhy = '' // the service refused or did not answer: not asked again before this
  let keyP = null // → { priv, pub (JWK), at }
  const passes = new Map() // email → { pass: { p, s }, exp } | { p: Promise }
  let revokedAt = 0 // when the account service last said `revoked` (0: never)
  // ★ NOT FOR THE SESSION (2026-11-16): a `revoked` answer stopped every later ask until a reload — and the account service once
  //   answered it to devices that were NOT signed out (a migrated account's provisional devices, fixed 43806abe5), so they stayed
  //   refused by the cutoff until relaunched. Now the ask goes again after REVOKED_RETRY_MS. A device really signed out is wiped
  //   by the status check onRevoked starts, so its maker is gone long before; one ask every few minutes is all it costs.
  const revoked = () => revokedAt > 0 && now() - revokedAt < REVOKED_RETRY_MS

  async function freshKey () {
    const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) // the private half: non-extractable
    const j = await subtle().exportKey('jwk', kp.publicKey)
    const k = { priv: kp.privateKey, pub: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, at: now() }
    if (store) { try { await store.set(STORE_KEY, k) } catch { /* memory only: a new key at the next start */ } }
    return k // a pass names the key it was made for (kx): one made for an older key is never used with this one
  }
  async function sessionKey () {
    if (keyP) { const k = await keyP.catch(() => null); if (k && now() - k.at < KEY_LIFE_MS) return k; keyP = null }
    keyP = (async () => {
      if (store) { try { const k = await store.get(STORE_KEY); if (k && typeof CryptoKey !== 'undefined' && k.priv instanceof CryptoKey && k.pub && now() - k.at < KEY_LIFE_MS) return k } catch { /* a new one */ } } // a CryptoKey a sealing store turned into {} is no key
      return freshKey()
    })()
    return keyP
  }
  /** The pass for this address and the CURRENT session key → { p, s } (renewed when under RENEW_BEFORE_S left). Concurrent asks share
   *  one request (even the first one, while the key is being made). Throws { code } — `revoked` after onRevoked. */
  async function passFor (email, { force = false } = {}) {
    if (revoked()) throw Object.assign(new Error('revoked'), { code: 'revoked' })
    const e = String(email || '').trim().toLowerCase()
    const k = await sessionKey()
    if (revoked()) throw Object.assign(new Error('revoked'), { code: 'revoked' })
    const kx = k.pub.x
    const hit = passes.get(e)
    if (!force && hit && hit.pass && hit.kx === kx && hit.exp - RENEW_BEFORE_S > now() / 1000) return hit.pass
    if (hit && hit.p && hit.pk === kx) return hit.p // already asked for this key
    if (now() < backoffUntil) throw Object.assign(new Error('backoff'), { code: 'backoff', why: backoffWhy }) // the service refused or did not answer a moment ago
    const p = (async () => {
      let r
      try {
        r = await ask(e, k.pub)
        if (!r || typeof r.pass !== 'string' || typeof r.sig !== 'string') throw Object.assign(new Error('no_pass'), { code: 'no_pass' })
      } catch (err) {
        if (err && err.code === 'revoked') { revokedAt = now(); passes.clear(); try { const x = onRevoked && onRevoked(); if (x && typeof x.catch === 'function') x.catch(() => {}) } catch { /* the status check runs at the next launch too */ } } // not awaited: the status check may wait on the very request asking (a vault's worker drops the account's rooms)
        else {
          const refused = refusedByService(err), wait = refused ? REFUSED_BACKOFF_MS : FAILED_BACKOFF_MS
          backoffUntil = now() + wait; backoffWhy = askWhy(err)
          say(`room pass: the account service ${refused ? 'refused a pass' : 'did not answer'} (${backoffWhy}) — asked again in ${Math.round(wait / 1000)} s`)
        }
        throw err
      }
      backoffUntil = 0
      const pass = { p: r.pass, s: r.sig }
      passes.set(e, { pass, exp: Number(r.exp) || 0, kx })
      return pass
    })()
    passes.set(e, { ...(hit && hit.pass ? { pass: hit.pass, exp: hit.exp, kx: hit.kx } : {}), p, pk: kx }) // a renewal keeps the pass it replaces until the new one is here
    try { return await p } catch (err) { const h = passes.get(e); if (h && h.p === p) { if (h.pass && h.exp > now() / 1000) passes.set(e, { pass: h.pass, exp: h.exp, kx: h.kx }); else passes.delete(e) } throw err }
  }
  /** psig for one request. */
  // `at`: the request's time as the CALLER knows it — spaceClient's sealNow(), this device's clock corrected by the server's (mkseal.js;
  // sync sweep 2026-11-16 #8: a device whose clock was off by more than 2 minutes had every request that carried a pass refused).
  // Asked from another realm (a key worker), so taken from the ask; more than a day from this clock = not believed, this clock signs.
  async function sign ({ op, room, spk, pass, key = null, at }) {
    const k = key || await sessionKey()
    const t = Number(at)
    const ts = Number.isFinite(t) && t > 0 && Math.abs(t - now()) <= MAX_TS_SHIFT_MS ? Math.round(t) : now(), nonce = randNonce()
    const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, psigBytes({ op, room, ts, nonce, ph: await sha256hex(pass.p), sk: await spkNonce(spk) })))
    return { ts, nonce, sig: b64u(sig) }
  }
  /** The fields to add to a request body that carries a sign-in → { pass, psig } | {} (no sign-in, or no pass to be had: the
   *  request goes as before and the server decides — with the cutoff on it refuses, and the next request asks again). */
  async function fieldsFor (body, { ts } = {}) {
    const si = signInOf(body)
    if (!si || !body) return {}
    return fieldsForSignIn({ op: body.op, room: body.room, email: si.email, spk: si.spk, ts })
  }
  /** The same, from its parts (the key worker asks the page with these: l1.js ROOM_PASS_AUTH). */
  async function fieldsForSignIn ({ op, room, email, spk, ts }) {
    if (typeof op !== 'string' || !op || typeof room !== 'string' || !room || !email || !spk) return {}
    try {
      const pass = await passFor(email)
      const key = await sessionKey() // the key that pass was made for (passFor took it a moment ago)
      if (!passFields(pass) || !passFields(pass).sessionPub || passFields(pass).sessionPub.x !== key.pub.x) { say('room pass: none this once (the day\'s session key changed)'); return {} } // the day's key changed in between: none this once
      return { pass, psig: await sign({ op, room, spk, pass, key, at: ts }) }
    } catch (err) { say(`room pass: none for this request (${err && err.code === 'backoff' ? 'waiting after: ' + err.why : askWhy(err)})`); return {} }
  }
  /** Renew in the background while in use (the app calls it from its timer) — and at once after a sign-out of the others. */
  async function renew (email) { try { await passFor(email, { force: true }) } catch { /* the next request asks again */ } }
  return { passFor, sign, fieldsFor, fieldsForSignIn, renew, sessionKey, revoked, forget: () => { passes.clear(); keyP = null } }
}

// ── THE SWITCH AND THE ASKS, shared by the three places a pass is made (2026-11-16, the owner: "Hosted + SDK passes, then roll out"):
//    the regular app's page (roomPassWiring.js), the hosted app's VAULT (acctV2VaultWiring.js / vault-loader.js — the frame holds no
//    device key, so the vault makes its passes) and a builder's vault (vault-core.js). One switch for all three.
export const ROOM_PASS_APP = true // ⚑ THE APPS' SWITCH — ON since 2026-11-16 (owner: "Rollout 1-7"; docs/device-gate-design.md § 11 step 5): every app (regular, the hosted vault, a builder's vault) sends room passes
export const ROOM_PASS_TEST_KEY = 'space:roompass' // '1' on one device = on there, for a test
export const ROOM_PASS_AUTH = '#room-pass' // not a room id (those never start with '#'): a key worker's ask, ROOM_PASS_AUTH + ':' + JSON
export const isRoomPassAsk = (name) => typeof name === 'string' && name.startsWith(ROOM_PASS_AUTH + ':')
// A key worker asks its page (or vault) to renew a room's sign-in so it names its app (a Space answered `pass: app_unnamed`):
// SIGNIN_RENEW_AUTH + ':' + the room → { idToken, spk } | {}.
export const SIGNIN_RENEW_AUTH = '#signin-renew'
export const isSigninRenewAsk = (name) => typeof name === 'string' && name.startsWith(SIGNIN_RENEW_AUTH + ':')
export const signinRenewRoom = (name) => (isSigninRenewAsk(name) ? String(name).slice(SIGNIN_RENEW_AUTH.length + 1) : '')
/** On: the apps' switch, or the test switch '1' in any of `stores` (each { getItem } — a store that throws is unread). '0' in any of
 *  them turns passes OFF on this device whatever the apps' switch says — for a test, or a device to step back by hand. */
export function roomPassSwitchOn (...stores) {
  const vals = stores.map((s) => { try { return s && typeof s.getItem === 'function' ? s.getItem(ROOM_PASS_TEST_KEY) : null } catch { return null } })
  if (vals.includes('0')) return false
  return ROOM_PASS_APP || vals.includes('1')
}
/** A key worker's ask (ROOM_PASS_AUTH + ':' + JSON { op, room, email, spk } | { renew, email }), answered with `maker` (makeRoomPass, or
 *  null = off) → { pass, psig } | {}. Never throws. */
export async function answerRoomPassAsk (maker, name) {
  try {
    if (!maker || !isRoomPassAsk(name)) return {}
    const q = JSON.parse(String(name).slice(ROOM_PASS_AUTH.length + 1))
    if (!q || typeof q !== 'object') return {}
    if (q.renew) { await maker.renew(String(q.email || '')); return {} }
    return await maker.fieldsForSignIn({ op: q.op, room: q.room, email: String(q.email || ''), spk: q.spk, ...(Number.isFinite(q.ts) ? { ts: q.ts } : {}) })
  } catch { return {} }
}
/**
 * One account's passes, made where its device key is: `on()` the switch; `account()` → { id (the account on the service), ask(email,
 * sessionPub) → { pass, sig, exp }, onRevoked?() } | null (no account on the new service here). A new account (another id) gets a new
 * session key and no pass of the one before; a signed-out one stops asking (makeRoomPass).
 * → { maker() → makeRoomPass | null, client (spaceClient's `roomPass`), answer(name) (a key worker's ask), renewNow(email) }
 */
export function makeRoomPassHolder ({ on, account, note = null, now = () => Date.now(), sleep } = {}) {
  let cur = null // { id, m }
  const say = makeNoter(note, { now })
  const maker = () => {
    try {
      if (!on()) return null
      const a = account()
      if (!a || !a.id || typeof a.ask !== 'function') return null
      if (!cur || cur.id !== a.id) cur = { id: a.id, m: makeRoomPass({ ask: a.ask, onRevoked: a.onRevoked || null, note, now }) }
      return cur.m
    } catch { return null }
  }
  const whenAccount = makeAccountWait(maker, { on, say, now, sleep })
  const none = () => { try { if (on()) say('room pass: none — this device has no account on the new account service (yet)') } catch { /* */ } return {} }
  return {
    maker,
    client: {
      fieldsFor: async (body, o) => { if (!signInOf(body)) return {}; const m = maker(); return m ? m.fieldsFor(body, o) : none() }, // o: { ts } — the request's time (sign)
      renew: async (body) => { const si = signInOf(body); const m = si ? await whenAccount() : null; if (m) await m.renew(si.email) }, // a Space said a pass is required: wait a little for the account
    },
    answer: async (name) => { if (isRenewAsk(name)) return answerRoomPassAsk(await whenAccount(), name); const m = maker(); return m ? answerRoomPassAsk(m, name) : (isRoomPassAsk(name) ? none() : {}) },
    renewNow: async (email) => { try { const m = maker(); if (m && email) await m.renew(email) } catch { /* the next request asks */ } },
  }
}
/** A key worker's ask that is a renewal ({ renew, email }) — the one sent after a Space answered that a pass is required. */
export const isRenewAsk = (name) => { try { return isRoomPassAsk(name) && !!JSON.parse(String(name).slice(ROOM_PASS_AUTH.length + 1)).renew } catch { return false } }
/** The account to renew with, waited for (ACCOUNT_WAIT_MS) when there is none yet — the app may still be starting — and not waited for
 *  again for NO_ACCOUNT_QUIET_MS once a wait found none. `maker` sync or async → it | null. */
export function makeAccountWait (maker, { on = () => true, say = () => {}, now = () => Date.now(), sleep, ms = ACCOUNT_WAIT_MS } = {}) {
  let quietUntil = 0
  return async () => {
    let m = null
    try { m = await maker() } catch { m = null }
    if (m) return m
    try { if (!on()) return null } catch { return null }
    if (now() < quietUntil) return null
    m = await waitFor(maker, { ms, now, ...(sleep ? { sleep } : {}) })
    if (!m) { quietUntil = now() + NO_ACCOUNT_QUIET_MS; say(`room pass: a Space required a pass, and this device has no account on the new account service to ask with (waited ${Math.round(ms / 1000)} s)`) }
    return m
  }
}
