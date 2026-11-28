// spaceEmailGate.js — "Sign in with Google" for EMAIL-gated async Spaces (the CLIENT half of the gate).
//
// The server half is agent/spaceOidc.mjs (verifyEmailTurn): it checks a Google ID token per turn, requires the token's
// `nonce` to equal spkNonce(the member's signing key), and checks the email against the Space's sealed allow-list. This
// module obtains that token. The nonce binds the Google identity to THIS device's signing key — the async stand-in for
// Kibitz binding the OIDC token to the live DTLS cert — so a leaked token can't be replayed onto another key.
//
// Reads gate WRITES only: anyone with the room key (mk, in the link) can READ; only allow-listed Google accounts can
// POST. The token is cached per-nonce until shortly before it expires, then a fresh one is fetched. The client id is
// PUBLIC (baked at deploy from ~/.witbitz-google-client-id). Zero deps: pure Google Identity Services.

import { makeEmailPost, emailStart, emailVerify, emailRefresh, jwtPayload } from './emailSignIn.js' // the email-code protocol, shared with the SDK (docs/sdk-convergence.md phase 5)
import { deviceOwner } from './accountOwner.js' // whose Spaces this device holds (one email per device, below)
import { spkNonce } from './entrySig.js' // a token is bound to its key's nonce: the orphan-token sweep
import { banner } from './notice.js' // the one place a refused address is SHOWN (refuseOther, below)

const GIS_SRC = 'https://accounts.google.com/gsi/client'
let _gisReady = null
function loadGis() {
  if (_gisReady) return _gisReady
  _gisReady = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.id) return resolve()
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.defer = true
    s.onload = () => (window.google && window.google.accounts && window.google.accounts.id ? resolve() : reject(new Error('gis_unavailable')))
    s.onerror = () => reject(new Error('gis_load_failed'))
    document.head.appendChild(s)
  })
  return _gisReady
}

// Read a JWT's payload WITHOUT verifying it — the SERVER verifies (signature + claims); we only read `email`/`exp` here
// for the UI label and the local expiry cache. Never trust these bytes for anything security-relevant.
// jwtPayload: emailSignIn.js

const _cache = new Map() // nonce → { idToken, email, exp(ms) } — mirrored to localStorage below so a reload / PWA reopen
const FRESH_MS = 5 * 60 * 1000 // re-prompt when a cached token is within 5 min of expiry

// PERSIST the verified token across reloads/reopens (keyed by the device-key nonce) so entering a Space you've already
// verified doesn't re-prompt while the token is still valid. Device-local + device-bound (unusable without the matching
// signing key, also in localStorage) — same trust surface as the stored keypair. Expired entries are pruned on read.
const TOK_KEY = (n) => 'space:tok:' + n
function tokDel(n) { _cache.delete(n); try { localStorage.removeItem(TOK_KEY(n)) } catch { /* */ } }
function tokGet(n) {
  let v = _cache.get(n)
  if (!v) { try { const s = localStorage.getItem(TOK_KEY(n)); if (s) { v = JSON.parse(s); _cache.set(n, v) } } catch { /* */ } }
  if (v && (!v.exp || v.exp <= Date.now())) { tokDel(n); return null } // drop expired
  if (v && otherDeviceEmail(v.email)) { tokDel(n); return null } // a token for ANOTHER address answers no one (sync sweep 11-09 #6: the Google callback cached it before its refusal, and the retry posted as it)
  return v || null
}
// EXPIRED TOKENS GO (the owner's phone, 2026-10-15: its storage was FULL — 6,930 keys — so every write failed silently and the
// sign-in "did not survive"). One token per signing key was kept for ever. An expired one can never be used again: it is
// dropped at start and again when a save is refused for space, and the save is retried once.
// The APP's mode (Settings → Appearance sets html's color-scheme to one word), else the phone's — the Google button matches the card.
function appIsDark () {
  const cs = typeof getComputedStyle === 'function' ? String(getComputedStyle(document.documentElement).colorScheme || '').trim() : ''
  if (cs === 'dark' || cs === 'light') return cs === 'dark'
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function pruneExpiredTokens(now = Date.now()) {
  let n = 0
  try {
    const dead = []
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k || k.indexOf('space:tok:') !== 0) continue; let v = null; try { v = JSON.parse(localStorage.getItem(k) || 'null') } catch { v = null } if (!v || !(Number(v.exp) > now)) dead.push(k) }
    for (const k of dead) { try { localStorage.removeItem(k); n++ } catch { /* */ } }
  } catch { /* */ }
  return n
}
function tokSet(n, v) {
  _cache.set(n, v)
  try { localStorage.setItem(TOK_KEY(n), JSON.stringify(v)) } catch { try { if (pruneExpiredTokens()) localStorage.setItem(TOK_KEY(n), JSON.stringify(v)) } catch { /* still full / private mode */ } }
}
// TOKENS FOR KEYS THAT ARE GONE GO TOO (the owner's phone, 2026-10-15: 5,497 live tokens = 9 MB beside 38 signing keys —
// each was minted for a key since replaced, and lived its 30 days). A token is only ever used for the key it is bound to
// (its nonce = spkNonce of that key): keep the ones for this device's signing keys and its saved session's key, and the
// newest few (a key held elsewhere: the Code page, a vault handoff); drop the rest.
export async function pruneOrphanTokens({ keepNewest = 40 } = {}) {
  try {
    const live = new Set()
    const pubs = []
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('space:sign:') === 0) { try { const kp = JSON.parse(localStorage.getItem(k) || 'null'); if (kp && kp.pub) pubs.push(kp.pub) } catch { /* */ } } }
    try { const a = anchorGet(); if (a && a.kp && a.kp.pub) pubs.push(a.kp.pub) } catch { /* */ }
    for (const p of pubs) { try { live.add(await spkNonce(p)) } catch { /* */ } }
    const toks = []
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k || k.indexOf('space:tok:') !== 0) continue; let v = null; try { v = JSON.parse(localStorage.getItem(k) || 'null') } catch { v = null } toks.push({ k, n: k.slice(10), exp: Number(v && v.exp) || 0 }) }
    const newest = new Set(toks.filter((t) => !live.has(t.n)).sort((a, b) => b.exp - a.exp).slice(0, keepNewest).map((t) => t.k))
    let n = 0
    for (const t of toks) if (!live.has(t.n) && !newest.has(t.k)) { try { localStorage.removeItem(t.k); _cache.delete(t.n); n++ } catch { /* */ } }
    return n
  } catch { return 0 }
}
try { setTimeout(() => { pruneExpiredTokens(); pruneOrphanTokens().then((n) => { if (n) signinLog('cleared ' + n + ' sign-in tokens for keys this device no longer has') }).catch(() => {}) }, 4000) } catch { /* no window */ }

/** Clear a cached token (e.g. after the server rejected it) so the next call re-prompts. */
export function clearGoogleToken(nonce) { if (nonce) tokDel(nonce) }

/** Non-prompting: the cached token for `nonce` if still comfortably valid, else null. For the poll loop + read ops,
 *  which must gate on a token but must NOT pop a sign-in card on their own (only a user action prompts). */
export function cachedGoogleToken(nonce) {
  const hit = tokGet(nonce)
  return hit && hit.exp - Date.now() > FRESH_MS ? { idToken: hit.idToken, email: hit.email } : null
}

/** Obtain a Google ID token whose `nonce` claim is bound to the member's signing key (pass `nonce = spkNonce(spk)`).
 *  Reuses a cached, unexpired token for the same nonce; otherwise shows a Google sign-in card (+ One Tap, best-effort)
 *  and resolves on sign-in. Rejects `cancelled` if the user dismisses, or `email_gate_unconfigured` if no client id.
 *  Returns `{ idToken, email }`. */
export async function googleIdToken({ clientId, nonce, copy = null, fresh = false, googleOwn = false }) { // googleOwn: Google's OWN token, never the broker's session (the account service checks Google's signature — acct/googleProof.mjs) // fresh: never a kept token (account recovery v2 wants a sign-in made now) // copy: { title, sub } — the card's words for another use (account recovery v2's Google in place of a code)
  const hit = fresh ? null : tokGet(nonce)
  if (hit && hit.exp - Date.now() > FRESH_MS) return { idToken: hit.idToken, email: hit.email }
  // ★ THE HOSTED APP'S VAULT (forceBroker): Google runs ONLY on the auth origin — Google does not know the vault's address, and
  //   an in-page sign-in there ends in Google's "Access blocked: origin_mismatch" (the owner's iPhone, 2026-11-15, the new account
  //   service's "Continue with Google" on spaces.witbitz.chat). The same token, for the same nonce, through the broker.
  if (forceBroker()) {
    let why = ''
    const t = await brokerGoogleToken({ nonce, onEnd: (w) => { why = w } })
    if (why === 'cancelled') throw new Error('cancelled') // the waiting card's Cancel is a decision, not a failure
    if (!t || !t.idToken) throw new Error('Google sign-in did not finish')
    if (googleOwn) { if (!t.google) throw new Error('Google sign-in did not finish'); return { idToken: t.google, email: t.email } } // an older broker hands no Google token: the card says to use the code
    return t
  }
  if (!clientId || clientId.indexOf('__') === 0) throw new Error('email_gate_unconfigured')
  await loadGis()

  return new Promise((resolve, reject) => {
    const dark = appIsDark()
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px'
    overlay.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
    const card = document.createElement('div')
    card.style.cssText = 'background:var(--bg,#fff);color:var(--fg,#111);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;max-width:340px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35)'
    const h = document.createElement('div'); h.textContent = (copy && copy.title) || 'Sign in to post'; h.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:6px'
    const sub = document.createElement('div'); sub.textContent = (copy && copy.sub) || 'Only the people this Space names can read or post here. Sign in with an allowed account.' // reading needs the sign-in too (the email gate covers reads) — the old line said anyone could read (owner, 2026-10-15)
    sub.style.cssText = 'font-size:13px;color:var(--muted,#888);margin-bottom:16px;line-height:1.4'
    const btnHost = document.createElement('div'); btnHost.style.cssText = 'display:flex;justify-content:center;min-height:44px'
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'
    cancel.style.cssText = 'margin-top:14px;background:none;border:none;color:var(--muted,#888);font-size:13px;cursor:pointer'
    card.appendChild(h); card.appendChild(sub); card.appendChild(btnHost); card.appendChild(cancel)
    overlay.appendChild(card); document.body.appendChild(overlay)

    let done = false
    const close = () => { try { document.body.removeChild(overlay) } catch { /* already gone */ } }
    const finish = (fn) => { if (done) return; done = true; try { window.google.accounts.id.cancel() } catch { /* */ } close(); fn() }
    cancel.onclick = () => finish(() => reject(new Error('cancelled')))
    overlay.onclick = (e) => { if (e.target === overlay) finish(() => reject(new Error('cancelled'))) }

    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        nonce, // Google echoes this verbatim into the token's `nonce` claim; the server requires it == spkNonce(spk)
        callback: (resp) => {
          const p = jwtPayload(resp && resp.credential)
          const email = String(p.email || '').toLowerCase()
          tokSet(nonce, { idToken: resp.credential, email, exp: (Number(p.exp) || 0) * 1000 })
          finish(() => resolve({ idToken: resp.credential, email }))
        },
      })
      window.google.accounts.id.renderButton(btnHost, { theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'pill' })
      try { if (!forceBroker()) window.google.accounts.id.prompt() } catch { /* One Tap is best-effort; the button is the real path */ } // vault surfaces (forceBroker): NO in-page One-Tap — the bottom FedCM sheet duplicated the card's button and surfaced the browser's session unasked
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error('gis_init_failed')))
    }
  })
}

const EMAIL_API = '' // SAME-ORIGIN: our own /api/email/* on the Spaces Pages project (Witbitz-branded sender). '' → relative

// ── CENTRAL AUTH BROKER (witbitz-auth.pages.dev) — the ONE Google-registered origin for the whole ecosystem. ─────────
// Two jobs for a tenant/branded origin: (a) GOOGLE sign-in without registering the origin with Google — the ceremony
// runs on the broker in a popup, the session comes back device-bound over a polled one-time handoff; (b) EMAIL-CODE
// sign-in without any email secrets on the origin — when the local /api/email/* is unconfigured, the same calls fall
// back to the broker's /api/relay/* (allowlisted per-origin CORS; the session is minted AS this origin either way).
const AUTH_BROKER = 'https://auth.witbitz.chat' // stamped at deploy (deploy.sh / build-vault.sh); placeholder ⇒ no broker
const brokerUrl = () => (AUTH_BROKER && AUTH_BROKER.indexOf('__') !== 0 ? AUTH_BROKER.replace(/\/$/, '') : '')
// TENANT-VAULT POLICY (2026-09-01): on VAULT surfaces every Google sign-in runs on the CENTRAL AUTH ORIGIN — one
// registered ceremony origin, and no in-page One-Tap that could surface whatever Google session the browser happens
// to hold (the wrong-account trap). Stamped '1' by build-vault.sh; the main app keeps its in-page GIS ('0').
const AUTH_FORCE_BROKER = '0'
const forceBroker = () => AUTH_FORCE_BROKER === '1' && !!brokerUrl()
export const authViaBroker = forceBroker // public predicate: this surface routes ALL Google through the central auth origin (recoveryGate's factor overlay branches on it)
// POST an email-ceremony call: LOCAL first; if the local origin has no email stack (unconfigured / no such function —
// an HTML fallback that fails to parse), transparently retry via the broker relay. Returns the parsed JSON or null.
const emailPost = (apiBase, path, body) => makeEmailPost(apiBase, { broker: brokerUrl() })(path, body) // emailSignIn.js — the protocol shared with the SDK (docs/sdk-convergence.md phase 5)
// GOOGLE via the broker: open the ceremony popup, poll for the device-bound session. Resolves { idToken, email } | null.
const E2E_AT_LOAD = (() => { try { return new URLSearchParams(location.search).get('e2etest') === '1' } catch { return false } })() // captured at MODULE INIT — the vault replaceState-strips its query before any click, so a click-time read misses the flag
// How long the page waits for the ceremony (the owner's Android app, 2026-11-08: "Chrome opens, then stuck"). The ceremony runs in
// ANOTHER app there (the system browser): the person signs in, then switches back — often after the old 3 minutes, when the wait had
// already ended and the finished sign-in sat unused until the broker dropped it (5 min after it finished). A return to this page ends
// the current pause at once (wakeOnReturn), so coming back finds the answer without a wait.
export const BROKER_WAIT_MS = 10 * 60 * 1000
const BROKER_POLL_MS = 1500
// One poll may take this long: a request in flight when iPhone paused the app under Safari can come back never — the wait must not
// hang on it past the person's return (the next round asks again).
export const BROKER_POLL_TIMEOUT_MS = 12000
// A sign-in window OUTSIDE the app seen closed: a few more rounds, not one — the broker closes its own page right after it parks the
// sign-in, and the first request after iPhone resumes the app often fails ("the network connection was lost"). The closing ends the
// wait only after this long AND two more polls.
export const BROKER_CLOSED_GRACE_MS = 8000
// A window OUTSIDE the app (the shells' browser, iPhone's Safari sheet) that reads closed this soon after it opened was never ours
// to watch: its "closed" says nothing about the sign-in. The wait goes on to the deadline; the waiting card's Cancel ends it.
const OUTSIDE_CLOSED_UNTRUSTED_MS = 5000
// THE NATIVE SHELLS (windows/attested-client, android/attested-client) name themselves in the user agent ("WitbitzApp/<platform>")
// and put their hardware-key bridge on the page (a cloud device's bridge is not a shell). In the Windows
// shell window.open answers null by design: every new window opens in the default browser (main_windows.go keepNavigationOnBundle).
export const inNativeShell = () => {
  try {
    if (/\bWitbitzApp\//.test((typeof navigator !== 'undefined' && navigator.userAgent) || '')) return true
    const b = globalThis.WitbitzAttest
    return !!(b && typeof b.platform === 'function' && /^(windows|android)$/.test(String(b.platform())))
  } catch { return false }
}
// iPhone's installed web app: window.open shows a Safari sheet OVER the app, and iPhone pauses the app under it (codeBrowse.js).
const iosStandalone = () => { try { return typeof navigator !== 'undefined' && navigator.standalone === true } catch { return false } }
// A pause that ends early when the person comes back to the page (visible again, shown again, focused) or the wait is cancelled.
const wakeOnReturn = (ms, ctl = null) => new Promise((resolve) => {
  let t = null
  const onVis = () => { try { if (document.visibilityState === 'visible') done() } catch { /* */ } }
  const evs = [['visibilitychange', onVis, () => document], ['pageshow', () => done(), () => window], ['focus', () => done(), () => window]]
  const done = () => {
    clearTimeout(t)
    for (const [ev, f, at] of evs) { try { at().removeEventListener(ev, f) } catch { /* no document/window */ } }
    if (ctl) ctl.wake = null
    resolve()
  }
  t = setTimeout(done, ms)
  for (const [ev, f, at] of evs) { try { at().addEventListener(ev, f) } catch { /* no document/window: the timer alone */ } }
  if (ctl) ctl.wake = done
})
const withTimeout = (p, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms)
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
})
// The card shown while the sign-in runs OUTSIDE this page (a shell's browser, iPhone's Safari sheet): what to do, and a way out —
// without it the app showed nothing at all for up to 10 minutes. Best effort: no document, no card.
function brokerWaitCard ({ shell, onCancel }) {
  try {
    const wrap = document.createElement('div')
    wrap.id = 'brokerWait'
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px'
    const card = document.createElement('div')
    card.style.cssText = 'background:var(--bg,#fff);color:var(--fg,#111);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;max-width:340px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35)'
    const h = document.createElement('div'); h.textContent = 'Waiting for Google…'; h.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:6px'
    const sub = document.createElement('div')
    sub.textContent = shell ? 'Google’s sign-in opened in your browser. Finish it there, then come back to this app.' : 'Finish signing in on the Google page, then come back here.'
    sub.style.cssText = 'font-size:13px;color:var(--muted,#888);line-height:1.4'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.id = 'brokerWaitCancel'; cancel.textContent = 'Cancel'
    cancel.style.cssText = 'margin-top:14px;background:none;border:none;color:var(--muted,#888);font-size:14px;cursor:pointer'
    cancel.onclick = () => onCancel()
    card.append(h, sub, cancel); wrap.append(card); document.body.append(wrap)
    return { close: () => { try { wrap.remove() } catch { /* gone */ } } }
  } catch { return { close () {} } }
}
// GOOGLE'S OWN SHEET IN THE ANDROID APP (android/attested-client GoogleSignIn.kt; docs/TODO.md, the Android app (1a)): no browser, so
// nothing is lost when Android stops the app while Chrome is in front. The app answers Google's ID token for THIS nonce (audience =
// the web client id); the broker turns it into our session exactly as its own page does (/api/handoff/complete, then the poll).
// → { idToken, email, google } | { cancelled: true } | null (not offered, or it failed: the browser path follows).
const NATIVE_GOOGLE_WAIT_MS = 5 * 60 * 1000
const signInSheet = () => { try { const b = globalThis.WitbitzSignIn; return b && typeof b.open === 'function' && typeof b.close === 'function' ? b : null } catch { return null } }
const nativeGoogleBridge = () => { try { const b = globalThis.WitbitzAttest; return b && typeof b.googleSignInStart === 'function' && typeof b.googleSignInResult === 'function' ? b : null } catch { return null } }
export async function nativeGoogleToken ({ nonce, broker, bridge = nativeGoogleBridge(), clientId = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  if (!bridge || !broker) return null
  try {
    const cid = clientId || (await import('./config.js')).GOOGLE_CLIENT_ID
    if (!cid || String(cid).indexOf('__') === 0) return null
    const id = String(bridge.googleSignInStart(cid, nonce) || '')
    if (!id) return null
    let ans = '', until = now() + NATIVE_GOOGLE_WAIT_MS
    while (!ans && now() < until) { await sleep(300); ans = String(bridge.googleSignInResult(id) || '') }
    if (!ans) { signinLog('Google (app): no answer from the sheet — the browser instead'); return null }
    const r = JSON.parse(ans)
    if (r.code === 'cancelled') { signinLog('Google (app): cancelled'); return { cancelled: true } }
    if (!r.idToken) { signinLog('Google (app): ' + (r.code || 'failed') + ' (' + String(r.error || '').slice(0, 80) + ') — the browser instead'); return null }
    const sid = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('')
    const post = (path, body) => withTimeout(fetch(broker + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()), BROKER_POLL_TIMEOUT_MS)
    const c = await post('/api/handoff/complete', { sid, origin: location.origin, nonce, googleIdToken: r.idToken })
    if (!c || !c.ok) { signinLog('Google (app): the broker refused the token (' + ((c && c.reason) || 'no answer') + ') — the browser instead'); return null }
    const p = await post('/api/handoff/poll', { sid })
    if (!p || !p.jwt) { signinLog('Google (app): the broker did not hand the session back — the browser instead'); return null }
    tokSet(nonce, { idToken: p.jwt, email: p.email, exp: (Number(jwtPayload(p.jwt).exp) || 0) * 1000 })
    signinLog('Google (app): signed in with the app\'s own sheet')
    return { idToken: p.jwt, email: p.email, ...(typeof p.google === 'string' ? { google: p.google } : {}) }
  } catch (e) { signinLog('Google (app): ' + String((e && e.message) || e).slice(0, 80) + ' — the browser instead'); return null }
}

// A SIGN-IN THAT OUTLIVES THE APP (the owner, 2026-11-23: "lets close this gap anyway"). Where Google's sign-in opens in the browser
// OUTSIDE the app — the Android app on a phone without Google Play services, the Windows app, iPhone's home-screen app — the system
// may close the app while the person is in the browser; the sign-in then finished at the broker and was never collected. The wait
// is kept in stored data (the broker's sid, the nonce, the sign-in key the token is bound to, when it started), its heartbeat
// refreshed on every round; a restart within BROKER_WAIT_MS of the start picks it up (resumePendingGoogle) and finishes the
// sign-in — this device's session, as the card would have made it. A heartbeat newer than PENDING_ALIVE_MS = the page that
// started it is still waiting: it is left alone (two pollers would race for the one answer).
const PENDING_KEY = 'space:google-pending'
export const PENDING_ALIVE_MS = 6000
let _signInKey = null // { nonce, kp } of the sign-in ensureIdentity is prompting for
const pendingRead = () => { try { const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); return p && typeof p === 'object' && typeof p.sid === 'string' ? p : null } catch { return null } }
const pendingWrite = (p) => { try { if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY) } catch { /* private mode: nothing kept */ } }
/** → true when the resumed wait finished the sign-in (the device's session is set); false when there was nothing to resume, it was
 *  left to its live page, it ended, or it was refused. Polls until the original deadline. */
export async function resumePendingGoogle ({ poll = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const p = pendingRead()
  if (!p) return false
  if (!(now() - Number(p.started) < BROKER_WAIT_MS) || !p.broker || !p.nonce) { pendingWrite(null); return false }
  // its page may still be waiting (a heartbeat newer than PENDING_ALIVE_MS): wait for it to finish or go quiet — never two pollers
  while (now() - Number((pendingRead() || {}).beat || 0) < PENDING_ALIVE_MS) {
    await sleep(PENDING_ALIVE_MS / 2)
    const cur = pendingRead(); if (!cur || cur.sid !== p.sid) return false // its page finished (or a newer sign-in took over)
  }
  signinLog('Google: picking up the sign-in that was waiting when the app closed (' + Math.round((now() - Number(p.started)) / 1000) + ' s ago)')
  const ask = poll || (() => withTimeout(fetch(p.broker + '/api/handoff/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: p.sid }) }).then((x) => x.json()), BROKER_POLL_TIMEOUT_MS))
  while (now() - Number(p.started) < BROKER_WAIT_MS) {
    const cur = pendingRead(); if (!cur || cur.sid !== p.sid) return false // a newer sign-in took over, or it was cleared
    pendingWrite({ ...cur, beat: now() })
    const r = await ask()
    if (r && r.jwt) {
      pendingWrite(null)
      tokSet(p.nonce, { idToken: r.jwt, email: r.email, exp: (Number(jwtPayload(r.jwt).exp) || 0) * 1000 })
      const iss = String(jwtPayload(r.jwt).iss || '')
      const set = p.kp && isOurEmailIss(iss) ? anchorSet({ method: 'email', token: r.jwt, kp: p.kp, email: r.email, exp: Date.now() + 30 * 24 * 3600 * 1000 }) : false
      signinLog('Google: the sign-in from before the restart finished — ' + (set ? 'signed in as ' + r.email : 'kept for its Space (no session key)'))
      return !!set
    }
    if (r && r.ok === false) { pendingWrite(null); signinLog('Google: the resumed sign-in was refused (' + (r.reason || 'no reason') + ')'); return false }
    await sleep(BROKER_POLL_MS)
  }
  pendingWrite(null)
  signinLog('Google: the resumed sign-in never finished (timed out)')
  return false
}
// at every start of a page that signs in (the app, the vault), once it has settled; nothing to do in most launches
try { if (typeof window !== 'undefined' && pendingRead()) setTimeout(() => { resumePendingGoogle().catch(() => {}) }, 1200) } catch { /* no window */ }

/** GOOGLE via the broker. → { idToken, email } | null. `onEnd(why)` hears why a wait ended without one: 'blocked' | 'cancelled' |
 *  'closed' | 'refused' | 'timeout'. In the Android app Google's own sheet comes first (nativeGoogleToken, above). */
export async function brokerGoogleToken({ nonce, broker = brokerUrl(), onEnd = null, watchPopup = true }) {
  if (!broker) return null
  const native = await nativeGoogleToken({ nonce, broker })
  if (native && native.cancelled) { if (onEnd) onEnd('cancelled'); return null }
  if (native) return native
  const sid = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('')
  const e2e = E2E_AT_LOAD
  const url = broker + '/?sid=' + sid + '&origin=' + encodeURIComponent(location.origin) + '&nonce=' + encodeURIComponent(nonce) + (e2e ? '&e2e=1' : '')
  let w = null
  // DESKTOP: open the broker ceremony as a compact CENTERED popup WINDOW that returns focus to the app when it closes
  // (the poll below auto-closes it on success), NOT a full browser tab — a featureless _blank from an installed PWA
  // escapes to the browser's tab strip. MOBILE keeps the EXACT current path ('_blank', no features → a tab, the only
  // option there), so iOS/Android are byte-identical. The handoff is POLLED, so the window kind never affects correctness.
  let target = '_blank', feat = ''
  try {
    if (window.matchMedia && window.matchMedia('(min-width: 700px) and (pointer: fine)').matches) {
      const width = 480, height = 680
      const bx = (window.screenX != null ? window.screenX : window.screenLeft) || 0
      const by = (window.screenY != null ? window.screenY : window.screenTop) || 0
      const bw = window.outerWidth || (window.screen && window.screen.width) || width
      const bh = window.outerHeight || (window.screen && window.screen.height) || height
      const left = Math.max(0, Math.round(bx + (bw - width) / 2))
      const top = Math.max(0, Math.round(by + (bh - height) / 2))
      target = 'witbitzGoogle'; feat = 'popup=yes,width=' + width + ',height=' + height + ',left=' + left + ',top=' + top // named → reuse one window instead of stacking on re-click
    }
  } catch { /* matchMedia/screen probing is best-effort → fall back to the plain tab */ }
  const shell = inNativeShell()
  // THE iPHONE APP: Apple's sign-in sheet over the app (SignInSheet.swift), not Safari — the app keeps running under it, nothing is
  // lost, and no switching back by hand. The poll below collects the sign-in as always; the sheet is closed once it has.
  const sheet = signInSheet(), ctlEarly = { cancelled: false, failed: false, wake: null }
  let inSheet = false
  if (sheet) {
    try {
      Promise.resolve(sheet.open(url)).then((r) => { if (r === 'cancelled') { ctlEarly.cancelled = true; if (ctlEarly.wake) ctlEarly.wake() } }, (e) => { signinLog('Google: the sign-in sheet failed — ' + String((e && e.message) || e).slice(0, 80)); ctlEarly.failed = true; if (ctlEarly.wake) ctlEarly.wake() }) // ⛔ 10·V#2 (pass 10): a sheet that never opened ended the wait at once — it held "Waiting for Google…" for 10 minutes
      inSheet = true; signinLog('Google: the sign-in opened in the app\'s sheet — waiting for it')
    } catch { /* no sheet after all: the browser path below */ }
  }
  if (!inSheet) { try { w = window.open(url, target, feat) } catch { /* popup blocked → the user can retry */ } }
  // ★ THE WINDOWS APP (the owner, 2026-11-16, a new installer): its shell opens every new window in the default browser and answers
  //   window.open with null, so "blocked" ended a sign-in that was in fact open in Edge — "Google sign-in didn't work here". In a
  //   shell a null window means "opened outside": the wait goes on, as the Android app's always did (its window.open answers).
  if (!inSheet && !w && !shell) { signinLog('Google: the sign-in page could not be opened (popup blocked)'); if (onEnd) onEnd('blocked'); return null }
  if (!inSheet && !w) signinLog('Google: the sign-in page opened in the browser, outside the app — waiting for it')
  const outside = !inSheet && (shell || iosStandalone())
  const ctl = inSheet ? ctlEarly : { wake: null, cancelled: false }
  const card = outside ? brokerWaitCard({ shell, onCancel: () => { ctl.cancelled = true; if (ctl.wake) ctl.wake() } }) : null
  const started = Date.now(), deadline = started + BROKER_WAIT_MS
  // OUTSIDE THE APP the system may close it mid-wait: keep the wait (resumePendingGoogle). A popup or an in-app sheet keeps the page alive.
  const key = _signInKey && _signInKey.nonce === nonce ? _signInKey.kp : null
  const keep = outside ? () => pendingWrite({ sid, nonce, broker, kp: key, started, beat: Date.now() }) : () => {}
  const forget = () => { const cur = pendingRead(); if (cur && cur.sid === sid) pendingWrite(null) }
  keep()
  const closeSheet = () => { if (inSheet) { try { sheet.close() } catch { /* already gone */ } } }
  const ended = (why, code) => { forget(); closeSheet(); if (card) card.close(); signinLog('Google: the wait for the sign-in page ended — ' + why + ' after ' + Math.round((Date.now() - started) / 1000) + ' s'); if (onEnd) onEnd(code); return null }
  const poll = () => withTimeout(fetch(broker + '/api/handoff/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid }) }).then((x) => x.json()), BROKER_POLL_TIMEOUT_MS)
  let closedAt = 0, pollsSinceClosed = 0, watchClosed = !!w && watchPopup
  while (Date.now() < deadline) {
    await wakeOnReturn(BROKER_POLL_MS, ctl)
    if (ctl.cancelled) return ended('cancelled', 'cancelled')
    if (ctl.failed) return ended('the sign-in sheet did not open', 'blocked')
    keep()
    const r = await poll()
    if (ctl.cancelled) return ended('cancelled', 'cancelled')
    if (r && r.jwt) {
      forget()
      try { if (w && w !== window) w.close() } catch { /* the sheet may already be closed */ }
      closeSheet()
      if (card) card.close()
      const p = jwtPayload(r.jwt)
      tokSet(nonce, { idToken: r.jwt, email: r.email, exp: (Number(p.exp) || 0) * 1000 })
      return { idToken: r.jwt, email: r.email, ...(typeof r.google === 'string' ? { google: r.google } : {}) }
    }
    if (r && r.ok === false) return ended('refused (' + (r.reason || 'no reason') + ')', 'refused') // origin refused / broker error — stop polling
    if (closedAt) pollsSinceClosed++
    else if (watchClosed) {
      let closed = false
      try { closed = w.closed === true } catch { /* cross-origin close probe */ }
      if (closed && outside && Date.now() - started < OUTSIDE_CLOSED_UNTRUSTED_MS) { watchClosed = false; signinLog('Google: the sign-in window reads closed at once — waiting on the sign-in itself') }
      else if (closed) closedAt = Date.now()
    }
    if (closedAt && pollsSinceClosed >= (outside ? 2 : 1) && Date.now() - closedAt >= (outside ? BROKER_CLOSED_GRACE_MS : 3000)) return ended('the sign-in window was closed', 'closed') // a desktop popup: the browser was never paused, 3 s as before
  }
  return ended('no answer (timed out)', 'timeout')
}

// Friendly copy for the backend's machine reasons: startError / verifyError in emailSignIn.js

// ── Email-code: OUR OWN OIDC provider (reused from the Kibitz call). A tiny two-step overlay — enter email → enter the
// 6-digit code we mail — that exchanges the code for an RS256 token carrying the verified email + this device's `nonce`.
// The server accepts it EXACTLY like a Google token (a second trusted issuer), so ANY email works, not just Google
// accounts. Caches into the SAME per-nonce store as the Google path → cachedGoogleToken()/the poll loop pick it up
// unchanged. Returns { idToken, email }; rejects `cancelled` if dismissed.
// NOT ABOUT A SPACE (no `room`: a restore's "Verify to restore", an account sign-in): the Space-gate sentence ("…on this Space’s
// list. Anyone with the link can still read.") made no sense there — the iPhone shell's first restore in the simulator, 2026-11-17.
export const EMAIL_SUB_NO_SPACE = 'We’ll send a 6-digit code to this email to check it’s yours.'
export async function emailCodeToken({ nonce, room, apiBase = EMAIL_API, copy }) {
  const hit = tokGet(nonce)
  if (hit && hit.exp - Date.now() > FRESH_MS) return { idToken: hit.idToken, email: hit.email }

  const FIELD = 'box-sizing:border-box;width:100%;padding:12px 13px;border:1px solid var(--line,#ddd);border-radius:11px;background:var(--field,#f4f4f4);color:inherit;font:inherit;font-size:16px;margin:0' // box-sizing INLINE: this dialog also renders in the VAULT document, which has no global border-box reset (the app's `* { box-sizing }` masked the width:100%+padding overflow)
  const PRIMARY = 'box-sizing:border-box;width:100%;border:0;border-radius:13px;padding:13px;background:var(--btn,#111);color:var(--btn-fg,#fff);font:inherit;font-weight:600;font-size:15px;cursor:pointer;margin-top:12px'
  const LINK = 'display:block;margin:12px auto 0;background:none;border:0;color:var(--muted,#888);font-size:13px;cursor:pointer'

  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px'
    overlay.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
    const card = document.createElement('div')
    card.style.cssText = 'background:var(--bg,#fff);color:var(--fg,#111);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;max-width:340px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.35)'
    overlay.appendChild(card); document.body.appendChild(overlay)
    let done = false
    const close = () => { try { document.body.removeChild(overlay) } catch { /* gone */ } }
    const finish = (fn) => { if (done) return; done = true; close(); fn() }
    overlay.onclick = (e) => { if (e.target === overlay) finish(() => reject(new Error('cancelled'))) }

    const stepEmail = () => {
      card.innerHTML =
        '<div style="font-weight:600;font-size:16px;margin-bottom:6px">' + ((copy && copy.title) || 'Email me a code') + '</div>' +
        '<div style="font-size:13px;color:var(--muted,#888);margin-bottom:16px;line-height:1.4">' + ((copy && copy.sub) || (room ? 'We’ll send a 6-digit code to check you’re on this Space’s list. Anyone with the link can still read.' : EMAIL_SUB_NO_SPACE)) + '</div>'
      const inp = document.createElement('input'); inp.type = 'email'; inp.inputMode = 'email'; inp.autocomplete = 'email'; inp.placeholder = 'you@example.com'; inp.style.cssText = FIELD
      inp.setAttribute('data-1p-ignore', ''); inp.setAttribute('data-lpignore', 'true'); inp.setAttribute('data-bwignore', '') // don't let a password manager save this passwordless email step as a (duplicate) login
      try { const known = anchorGet(); if (known && known.email) { inp.value = known.email; inp.select() } } catch { /* */ } // already signed in → pre-fill your own address so opening a verified room is one tap, not a retype (still editable)
      const err = document.createElement('div'); err.style.cssText = 'color:#e5484d;font-size:12.5px;margin-top:8px'
      const send = document.createElement('button'); send.textContent = 'Send code'; send.style.cssText = PRIMARY
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.cssText = LINK
      card.appendChild(inp); card.appendChild(err); card.appendChild(send); card.appendChild(cancel)
      inp.focus()
      cancel.onclick = () => finish(() => reject(new Error('cancelled')))
      const submit = async () => {
        const email = String(inp.value || '').trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return }
        { const d = otherDeviceEmail(email); if (d) { err.textContent = refuseOther(d, email, null).message; return } } // one email per device: no code is sent — the banner above the card carries the way out where a screen has one (sync sweep 11-09 #12)
        send.disabled = true; send.textContent = 'Sending…'; err.textContent = ''
        try {
          const { ticket } = await emailStart((path, body) => emailPost(apiBase, path, body), { email, room, nonce })
          stepCode(email, ticket)
        } catch (e) { err.textContent = (e && e.code && e.message) || 'Network error — try again.'; send.disabled = false; send.textContent = 'Send code' }
      }
      send.onclick = submit
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }
    }

    const stepCode = (email, ticket) => {
      card.innerHTML =
        '<div style="font-weight:600;font-size:16px;margin-bottom:6px">Enter the code</div>' +
        '<div style="font-size:13px;color:var(--muted,#888);margin-bottom:16px;line-height:1.4">We emailed a 6-digit code to <b></b>. It expires in 10 minutes.</div>'
      card.querySelector('b').textContent = email
      const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'one-time-code'; inp.maxLength = 6; inp.placeholder = '123456'; inp.style.cssText = FIELD + ';letter-spacing:5px;text-align:center'
      inp.setAttribute('data-1p-ignore', ''); inp.setAttribute('data-lpignore', 'true'); inp.setAttribute('data-bwignore', '') // it's a one-time code, not a login to save
      const err = document.createElement('div'); err.style.cssText = 'color:#e5484d;font-size:12.5px;margin-top:8px'
      const verify = document.createElement('button'); verify.textContent = 'Verify'; verify.style.cssText = PRIMARY
      const back = document.createElement('button'); back.textContent = 'Use a different email'; back.style.cssText = LINK
      card.appendChild(inp); card.appendChild(err); card.appendChild(verify); card.appendChild(back)
      inp.focus()
      back.onclick = () => stepEmail()
      const submit = async () => {
        const code = String(inp.value || '').trim()
        if (!/^\d{4,8}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return }
        verify.disabled = true; verify.textContent = 'Verifying…'; err.textContent = ''
        try {
          const v = await emailVerify((path, body) => emailPost(apiBase, path, body), { ticket, code })
          tokSet(nonce, { idToken: v.jwt, email, exp: v.exp })
          finish(() => resolve({ idToken: v.jwt, email }))
        } catch (e) { err.textContent = (e && e.code && e.message) || 'Network error — try again.'; verify.disabled = false; verify.textContent = 'Verify' }
      }
      verify.onclick = submit
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }
    }

    stepEmail()
  })
}

/** The Space identity prompt: offers "Sign in with Google" (when a client id is baked) AND "Email me a code", and
 *  resolves { idToken, email } from whichever the member completes — so someone WITHOUT a Google account can still be
 *  admitted. Both cache per-nonce (→ cachedGoogleToken picks either up). Rejects `cancelled` if dismissed. */
export async function promptIdentity({ clientId, nonce, room, apiBase = EMAIL_API, titleText, subText }) {
  const hit = tokGet(nonce)
  if (hit && hit.exp - Date.now() > FRESH_MS) return { idToken: hit.idToken, email: hit.email }
  const hasGoogle = !forceBroker() && !!clientId && clientId.indexOf('__') !== 0 // vault surfaces (forceBroker): Google runs ONLY on the auth origin — no in-page GIS
  if (hasGoogle) { try { await loadGis() } catch { /* Google unavailable → email-code only */ } }
  const googleUp = hasGoogle && window.google && window.google.accounts && window.google.accounts.id

  return new Promise((resolve, reject) => {
    const dark = appIsDark()
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px'
    overlay.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
    const card = document.createElement('div')
    card.style.cssText = 'background:var(--bg,#fff);color:var(--fg,#111);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;max-width:340px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35)'
    const h = document.createElement('div'); h.textContent = titleText || 'Sign in to this Space'; h.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:6px'
    const sub = document.createElement('div'); sub.textContent = subText || 'Only the people this Space names can read or post here. Sign in with your email to continue.' // reading needs the sign-in too — the old line said anyone with the link could read (owner, 2026-10-15)
    sub.style.cssText = 'font-size:13px;color:var(--muted,#888);margin-bottom:16px;line-height:1.4'
    card.appendChild(h); card.appendChild(sub)
    const brokered = !googleUp && !!brokerUrl() // no in-page GIS on this origin, but the CENTRAL broker can run the ceremony — Google works with ZERO Google-console registration for this origin
    const googleAny = googleUp || brokered
    const btnHost = document.createElement('div'); btnHost.style.cssText = 'display:flex;justify-content:center'
    if (googleAny) { btnHost.style.minHeight = '44px'; card.appendChild(btnHost) }
    const emailBtn = document.createElement('button'); emailBtn.textContent = googleAny ? '✉️  Email me a code instead' : '✉️  Email me a code'
    emailBtn.style.cssText = googleAny
      ? 'margin-top:14px;width:100%;background:none;border:1px solid var(--line,#ddd);color:var(--fg,#111);border-radius:22px;padding:10px 16px;font:inherit;font-size:14px;font-weight:600;cursor:pointer'
      : 'margin-top:2px;width:100%;background:var(--btn,#111);border:0;color:var(--btn-fg,#fff);border-radius:22px;padding:12px 16px;font:inherit;font-size:15px;font-weight:600;cursor:pointer'
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.cssText = 'display:block;margin:14px auto 0;background:none;border:none;color:var(--muted,#888);font-size:13px;cursor:pointer'
    card.appendChild(emailBtn); card.appendChild(cancel)
    overlay.appendChild(card); document.body.appendChild(overlay)

    let done = false
    const close = () => { try { document.body.removeChild(overlay) } catch { /* gone */ } }
    const finish = (fn) => { if (done) return; done = true; try { if (googleUp) window.google.accounts.id.cancel() } catch { /* */ } close(); fn() }
    cancel.onclick = () => finish(() => reject(new Error('cancelled')))
    overlay.onclick = (e) => { if (e.target === overlay) finish(() => reject(new Error('cancelled'))) }
    emailBtn.onclick = () => finish(() => emailCodeToken({ nonce, room, apiBase }).then(resolve, reject))

    if (googleUp) {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          nonce, // Google echoes this into the token's `nonce`; the server requires it == spkNonce(spk)
          callback: (resp) => {
            const p = jwtPayload(resp && resp.credential)
            const email = String(p.email || '').toLowerCase()
            tokSet(nonce, { idToken: resp.credential, email, exp: (Number(p.exp) || 0) * 1000 })
            finish(() => resolve({ idToken: resp.credential, email }))
          },
        })
        window.google.accounts.id.renderButton(btnHost, { theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'pill' })
        try { window.google.accounts.id.prompt() } catch { /* One Tap best-effort */ }
      } catch { /* Google init failed → the email-code button still works */ }
    } else if (brokered) {
      // The BROKER Google button: the ceremony runs on the central Google-registered origin in a popup/sheet; the
      // session comes back device-bound via the polled handoff. Styled to read as the primary option, like the GIS pill.
      const gb = document.createElement('button'); gb.id = 'egBrokerGoogle'
      gb.textContent = 'Continue with Google'
      gb.style.cssText = 'width:100%;background:var(--btn,#111);border:0;color:var(--btn-fg,#fff);border-radius:22px;padding:12px 16px;font:inherit;font-size:15px;font-weight:600;cursor:pointer'
      btnHost.appendChild(gb)
      gb.onclick = async () => {
        gb.disabled = true; gb.textContent = 'Waiting for Google…'
        const t = await brokerGoogleToken({ nonce }).catch(() => null)
        if (t) { finish(() => resolve(t)); return }
        gb.disabled = false; gb.textContent = 'Continue with Google' // popup blocked / cancelled / timed out — let them retry or use email
      }
    }
  })
}

// ── ONE login covers ALL your Spaces ─────────────────────────────────────────────────────────────────────────────────
// Each Space has its own signing key, so it needs its own token. Rather than re-verify per Space, one verification sets
// a DEVICE SESSION anchor; every other Space's token is then minted SILENTLY: email-code → api/email/refresh (device-key
// assertion, no new code); Google → One-Tap auto-select. Per-room keys are preserved (the sealed ledger stays
// unlinkable); only the EMAIL is verified once (~monthly).
const ANCHOR_KEY = 'space:esession'
function anchorGet() {
  try { const a = JSON.parse(localStorage.getItem(ANCHOR_KEY) || 'null'); return a && (!a.exp || a.exp > Date.now()) ? a : null } catch { return null }
}
// ⛔ ONE EMAIL PER DEVICE (the owner, 2026-11-08: "C" — docs/state-machines.md D1). A device signs in as ONE address. A sign-in made for
//   one verified Space wrote whatever address it verified into this device-wide slot: the next Spaces renewed silently as that
//   address, Settings said "Signed in as" it, and the account guard (accountOwner.js) stopped every backup and index push because the
//   email no longer matched the device's owner. Now a different address is refused — at the email card before any code is sent,
//   for a Google sign-in, and here — with how to change it: sign out first. The device's email = the slot's, else its owner mark.
export function deviceEmail () {
  try { const a = JSON.parse(localStorage.getItem(ANCHOR_KEY) || 'null'); const e = a && typeof a.email === 'string' ? a.email.trim().toLowerCase() : ''; if (e) return e } catch { /* */ }
  try { return deviceOwner() || '' } catch { return '' }
}
/** The device's email when `email` is ANOTHER one (refused), else ''. */
export function otherDeviceEmail (email) { const d = deviceEmail(), e = String(email || '').trim().toLowerCase(); return d && e && d !== e ? d : '' }
// WHERE TO CHANGE IT (sync sweep 11-09 #6, #12): the regular app's row is "Log out", not "Sign out"; a screen with no Settings (the
// vault's first screens) registers its own way out — setOtherAccountAction({ label, onClick }) — and the words name that instead.
// `when` (optional): the action holds only while it says so (the vault: while no account is held).
let _otherAction = null
export function setOtherAccountAction (a) { _otherAction = a && a.label && typeof a.onClick === 'function' ? { label: String(a.label), onClick: a.onClick, when: typeof a.when === 'function' ? a.when : null } : null }
const otherAction = () => { try { return _otherAction && (!_otherAction.when || _otherAction.when()) ? _otherAction : null } catch { return null } }
export const otherEmailText = (d, e, how = (otherAction() || {}).label) => how
  ? `This device is signed in as ${d}. To use ${e}, tap “${how}” first — one email per device.`
  : `This device is signed in as ${d}. To use ${e}, log out first (Settings → Log out) — one email per device.`
// ⛔ A REFUSED ADDRESS, ONE WAY (sync sweep 11-09 #6). Its token was cached under this key's nonce BEFORE the refusal (the Google
//   callback keeps what it gets — tokGet now drops such a token), and every caller swallowed the refusal (Settings, restore,
//   @username, the vault's Create), so the person saw nothing, or "Sign-in didn't work". Now Google stops picking that account by
//   itself, and the reason is shown HERE, once, for every caller.
function refuseOther (d, email, nonce) {
  if (nonce) tokDel(nonce)
  try { window.google.accounts.id.disableAutoSelect() } catch { /* no Google on this page */ }
  const e = new Error(otherEmailText(d, email)); e.code = 'other_account'
  try { signinLog('refused ' + email + ' — this device is signed in as ' + d) } catch { /* */ }
  try { banner(e.message, { id: 'other-account', kind: 'error', action: otherAction() }) } catch { /* no page to show it on */ }
  return e
}
/** → true when the device's sign-in now holds `a`; false when it was refused (another address) or could not be written. */
function anchorSet(a) {
  if (a && a.email && otherDeviceEmail(a.email)) return false // never another address over the device's (the cards below refuse first; this is the last word)
  try { localStorage.setItem(ANCHOR_KEY, JSON.stringify(a)) } catch { return false /* private mode */ } try { if (a && a.token && typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('wb-identity')) } catch { /* */ } return true } // a new sign-in: its hints are fetched in the background (identityPrefetch.js)

// Refresh an email-code session to a NEW key WITHOUT re-emailing: sign a fresh challenge with the OLD key (proof of the
// verifying device) and present the still-valid token. Returns { idToken, email } or null (→ caller falls back).
// WHY THE SIGN-IN CARD CAME BACK (the owner, 2026-10-15: "I keep getting this. It looks like the token doesn't survive"):
// the boot log (Settings → 5 taps on the build line) says, each time the card is about to show, what the silent path had.
let _refreshWhy = ''
// its OWN log ('space:signinlog', 30 lines), shown first in the crash-trail viewer — the shared boot log turns over in seconds
export function signinLog (m) { try { const k = 'space:signinlog', a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(new Date().toLocaleString() + '  ' + m); while (a.length > 30) a.shift(); localStorage.setItem(k, JSON.stringify(a)) } catch { /* */ } }
async function refreshEmailToken({ apiBase, token, kpOld, newNonce, throwOnRefusal }) { // emailSignIn.js — the SDK renews the same way
  _refreshWhy = ''
  const r = await emailRefresh(async (path, body) => { const out = await emailPost(apiBase, path, body); if (!out || !out.ok) _refreshWhy = String((out && (out.reason || out.error)) || 'no answer').slice(0, 60); return out }, { token, kpOld, newNonce, throwOnRefusal })
  if (!r) { if (!_refreshWhy) _refreshWhy = 'failed before asking'; return null }
  tokSet(newNonce, { idToken: r.jwt, email: r.email, exp: r.exp })
  return { idToken: r.jwt, email: r.email }
}

// Google One-Tap auto-select — re-issue a token for `nonce` WITHOUT a full sign-in card, for a returning signed-in user.
// Resolves { idToken, email } on a silent success, or null (not signed in / cooldown / dismissed) → caller prompts.
async function silentGoogleToken({ clientId, nonce }) {
  if (!clientId || clientId.indexOf('__') === 0) return null
  try { await loadGis() } catch { return null }
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      window.google.accounts.id.initialize({
        client_id: clientId, nonce, auto_select: true, cancel_on_tap_outside: false,
        callback: (resp) => {
          const p = jwtPayload(resp && resp.credential); const email = String(p.email || '').toLowerCase()
          tokSet(nonce, { idToken: resp.credential, email, exp: (Number(p.exp) || 0) * 1000 })
          fin({ idToken: resp.credential, email })
        },
      })
      window.google.accounts.id.prompt((n) => { try { if ((n.isNotDisplayed && n.isNotDisplayed()) || (n.isSkippedMoment && n.isSkippedMoment())) fin(null) } catch { /* */ } })
      setTimeout(() => fin(null), 3500) // no callback in time → give up silently
    } catch { fin(null) }
  })
}

// Exchange a freshly-verified GOOGLE token for OUR OWN 30-day refreshable session (POST /api/email/adopt). This is what
// gives Google the SAME "one login covers all Spaces" smoothness the email-code path has: afterwards, every other Space
// re-mints SILENTLY via /api/email/refresh (a device-key proof) instead of leaning on Google's 1-hour tokens + flaky
// One-Tap. Sets an EMAIL anchor + caches the token for `nonce`, and returns { idToken, email } — OUR token, bound to
// THIS key. Returns null on any failure → the caller keeps the Google token + a Google anchor (graceful, no regression).
async function adoptGoogleSession({ apiBase, googleIdToken, nonce, kp, email }) {
  try {
    const r = await emailPost(apiBase, '/api/email/adopt', { googleIdToken, nonce }) // an origin with no email stack (app.witbitz.chat) → the broker's /api/relay/adopt
    if (!r || !r.ok || !r.jwt) return null
    const p = jwtPayload(r.jwt); const em = String(p.email || email || '').toLowerCase()
    if (otherDeviceEmail(em)) return null // never a session for another address (its callers refuse first)
    tokSet(nonce, { idToken: r.jwt, email: em, exp: (Number(p.exp) || 0) * 1000 })
    anchorSet({ method: 'email', token: r.jwt, kp, email: em, exp: Date.now() + 30 * 24 * 3600 * 1000 })
    return { idToken: r.jwt, email: em }
  } catch { return null }
}

const OUR_EMAIL_ISS = 'https://witbitz-spaces.pages.dev' // our own email-code issuer (refreshable); Google/kibitz are not
// A vault reached by its CUSTOM domain mints under its Pages project's name (spaces.witbitz.chat → https://witbitz-vault-prod
// .pages.dev, measured 2026-10-03; a tenant vault → witbitz-vault-<tenant>.pages.dev): neither OUR_EMAIL_ISS nor
// location.origin, so the anchor was never kept and every sign-in-token action on the vault app asked for the code again.
// Bookkeeping, not trust — this only decides whether THIS device keeps its own token for silent refresh.
const VAULT_ISS = /^https:\/\/witbitz-vault-[a-z0-9][a-z0-9-]{0,40}\.pages\.dev$/
export const isOurEmailIss = (iss, origin = (typeof location !== 'undefined' ? location.origin : '')) => !!iss && (iss === OUR_EMAIL_ISS || iss === origin || VAULT_ISS.test(iss))

/** Get a token for THIS device key (nonce = spkNonce(kp.pub)) with the LEAST friction: cached → silent (refresh the
 *  email session, or Google One-Tap) → full prompt. Records/reuses a device session anchor so opening the NEXT Space
 *  doesn't re-verify. `kp` is this Space's signing keypair. Returns { idToken, email }; rejects `cancelled` if dismissed. */
export async function ensureIdentity({ clientId, nonce, kp, room, apiBase = EMAIL_API, silentOnly = false, promptCopy, forcePrompt = false, throwOnRefusal = false }) {
  // ★ forcePrompt ALSO skips the cached token (the owner, 2026-10-22: signed in to a verified Space with the wrong Gmail,
  //   then "Use another email" signed them in as that same Gmail again — the card was never shown: the cached token, then
  //   the saved session's silent renewal, answered first). A person asking for the card gets the card.
  if (forcePrompt) { clearGoogleToken(nonce); try { window.google.accounts.id.disableAutoSelect() } catch { /* no Google on this page */ } }
  const hit = tokGet(nonce)
  if (hit && hit.exp - Date.now() > FRESH_MS) return { idToken: hit.idToken, email: hit.email }

  // SILENT — one prior verification covers every Space. `forcePrompt` SKIPS both silent paths (anchor refresh + Google
  // auto-select): a CREATE-account flow must always SHOW the identity step (email in the flow) — silently reusing an
  // existing session would mint the wrong account (esp. a per-tenant account, which must be a deliberate act).
  const anchor = anchorGet()
  if (!forcePrompt && anchor && anchor.method === 'email' && anchor.token && anchor.kp) {
    const r = await refreshEmailToken({ apiBase, token: anchor.token, kpOld: anchor.kp, newNonce: nonce, throwOnRefusal })
    // SLIDING session: re-anchor on every successful refresh (fresh token + this Space's key + a new 30-day window), so
    // an active user — opening any Space within 30 days — never does a full login again; only 30 days IDLE lapses it.
    if (r) { anchorSet({ method: 'email', token: r.idToken, kp, email: r.email, exp: Date.now() + 30 * 24 * 3600 * 1000 }); return r }
  }
  // Google One-Tap is NOT a truly-silent path: `auto_select` can't complete without UI on iOS Safari (and when the
  // Google login was never adopted into our own refreshable session, it recurs). So a boot/background caller (silentOnly)
  // must SKIP it — otherwise "enroll silently on boot" pops the Google nudge on every launch. Only the email-refresh
  // above is genuinely silent (no Google contact); a Google-anchored device simply enrolls on its next real gated auth.
  if (!forcePrompt && !silentOnly && !forceBroker() && clientId && clientId.indexOf('__') !== 0) { // vault surfaces (forceBroker): no in-page One-Tap either — all Google runs on the auth origin
    const g = await silentGoogleToken({ clientId, nonce })
    { const d = g && otherDeviceEmail(g.email); if (d) throw refuseOther(d, g.email, nonce) } // One-Tap picked another address: refused like the card (sync sweep 11-09 #6 — it was adopted and its token returned)
    if (g) {
      const adopted = await adoptGoogleSession({ apiBase, googleIdToken: g.idToken, nonce, kp, email: g.email })
      if (adopted) return adopted // Google → our refreshable session; the NEXT Space slides silently via /refresh
      anchorSet({ method: 'google', email: g.email, exp: Date.now() + 30 * 24 * 3600 * 1000 }); return g // adopt unavailable → keep Google (no regression)
    }
  }

  try {
    const why = forcePrompt ? 'asked for' : !anchor ? 'no saved session on this device' : anchor.method !== 'email' ? 'the saved session is ' + anchor.method + ' (no silent renewal)'
      : !anchor.token ? 'the saved session has no token' : !anchor.kp ? 'the saved session has no key' : 'the renewal was refused: ' + (_refreshWhy || '?')
    signinLog((silentOnly ? 'quiet renewal failed' : 'sign-in card') + ' for ' + String(room || '').slice(-6) + ' — ' + why + (anchor && anchor.exp ? ' · session until ' + new Date(anchor.exp).toISOString().slice(0, 10) : '') + (anchor && anchor.email ? ' · ' + anchor.email : ''))
  } catch { /* */ }
  if (silentOnly) return null // boot/background: no full card AND (per above) no Google One-Tap — never phone Google to enroll
  _signInKey = { nonce, kp } // a browser sign-in outside the app keeps this key with its pending wait (rememberPending, below)

  // Full prompt — first login on this device, or the session lapsed. Record the anchor for next time.
  // With a Google client id → the choice card (Google + email). Email-ONLY (onboarding register, no clientId) → straight
  // to the email field, no intermediate "Email me a code" tap, with the caller's onboarding copy.
  const t = (clientId || brokerUrl())
    ? await promptIdentity({ clientId, nonce, room, apiBase, titleText: promptCopy && promptCopy.title, subText: promptCopy && promptCopy.sub }) // brokerUrl(): even with NO client id on this origin, the choice card offers Google via the central broker
    : await emailCodeToken({ nonce, room, apiBase, copy: promptCopy })
  { const d = otherDeviceEmail(t && t.email); if (d) throw refuseOther(d, t.email, nonce) } // a Google sign-in as another address: refused, nothing kept — not even its cached token
  try {
    const iss = String(jwtPayload(t.idToken).iss || '')
    // "Ours" = the refreshable email-code token. The legacy/default issuer is the main-app origin (OUR_EMAIL_ISS), but a
    // branded/vaulted deployment mints its OWN issuer = ITS origin (EMAIL_ISSUER env; how SPACE_OIDC_ISSUERS trusts it).
    // Only matching the hardcoded main origin silently DROPPED the anchor on such deployments — the account was created
    // but currentAnchor() stayed null, so the framed app's identityGet got nothing and Settings showed "Login".
    if (isOurEmailIss(iss)) {
      anchorSet({ method: 'email', token: t.idToken, kp, email: t.email, exp: Date.now() + 30 * 24 * 3600 * 1000 })
    } else if (iss.indexOf('accounts.google') >= 0) {
      // Adopt the Google login into OUR refreshable session so it, too, is one-login-covers-all. Fall back to a Google
      // anchor (today's behavior) if /adopt is unavailable — no regression.
      const adopted = await adoptGoogleSession({ apiBase, googleIdToken: t.idToken, nonce, kp, email: t.email })
      if (adopted) return adopted
      anchorSet({ method: 'google', email: t.email, exp: Date.now() + 30 * 24 * 3600 * 1000 })
    }
  } catch { /* anchor is best-effort */ }
  return t
}

/** RENEW THIS KEY'S SIGN-IN SO IT NAMES ITS APP (docs/device-gate-design.md § 12.1): a Space refused the token as naming no app
 *  (`pass: app_unnamed` — one minted before `asc`, or a raw Google token kept when /adopt was unavailable). Quietly, never a card:
 *  a raw Google token is adopted into our session now; ours is renewed through the saved session (/refresh adds `asc`). On
 *  nothing better, the token it had is kept. → { idToken, email } | null */
export async function renewIdentity({ clientId, nonce, kp, room, apiBase = EMAIL_API }) {
  const hit = tokGet(nonce)
  clearGoogleToken(nonce)
  let t = null
  try {
    if (hit && hit.idToken && String(jwtPayload(hit.idToken).iss || '').indexOf('accounts.google') >= 0) t = await adoptGoogleSession({ apiBase, googleIdToken: hit.idToken, nonce, kp, email: hit.email })
    if (!t) t = await ensureIdentity({ clientId, nonce, kp, room, apiBase, silentOnly: true, throwOnRefusal: true })
  } catch (err) { if (err?.status === 401 || err?.status === 403) throw err; t = null }
  if (!t && hit) tokSet(nonce, hit)
  return t || null
}

/** Sign out THIS device: drop every cached/persisted identity TOKEN + the device session anchor, and stop Google
 *  One-Tap auto-select (so it won't silently sign you back in). The signing keys, your name, and your Spaces list are
 *  the app's to clear (space.html) — this handles only the auth identity. After this, the next gated op re-verifies. */
export function signOut() {
  _cache.clear()
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && (k.indexOf('space:tok:') === 0 || k === ANCHOR_KEY)) localStorage.removeItem(k) } } catch { /* */ }
  try { if (window.google && window.google.accounts && window.google.accounts.id) window.google.accounts.id.disableAutoSelect() } catch { /* */ }
  try { localStorage.removeItem('space:myusers'); localStorage.removeItem('space:username') } catch { /* */ } // ownIdentity.js: another account must not inherit this one's side of the transcript
}

/** The current device identity from the session anchor, or null — so the UI can show "Signed in as …" and choose
 *  between Sign in / Sign out. A verified email/Google identity exists on this device iff this returns non-null. */
export function identity() { const a = anchorGet(); return a ? { email: a.email || '', method: a.method } : null }
// The FULL device anchor (token + device kp + email) — so a TOP-LEVEL sign-in (the vault) can hand the identity down to a
// framed app that can't run Google/FedCM/email-overlay itself. currentAnchor() reads it; adoptAnchor() records one received.
export function currentAnchor() { return anchorGet() }
export function adoptAnchor(a) {
  try {
    if (!(a && a.method && a.email)) return false
    if (a.token || a.method === 'google') return anchorSet(a) // full session (or Google) — adopt as-is; false when refused (another address — sync sweep 11-09 #13: "Linked" under another sign-in)
    // TOKEN-LESS email anchor: a VERIFIED ADDRESS recorded without a session (noteVerifiedEmail — e.g. a gate-factor
    // restore leg that couldn't mint the jwt). Adopt it for IDENTITY/display + prefill — without this, the vault knew
    // the email but the framed app rejected the handed-down anchor and Settings showed "Login" as if signed out.
    // Never DOWNGRADE: an existing token-ful anchor (silent refresh works) must not be replaced by a token-less one.
    if (a.method === 'email') { const cur = anchorGet(); if (cur && cur.token) return false; return anchorSet({ method: 'email', email: a.email, exp: a.exp || (Date.now() + 30 * 24 * 3600 * 1000) }) }
  } catch (e) { /* */ }
  return false
}

/** Record a verified email as this device's identity WITHOUT a fresh login round-trip. Used after the recovery EMAIL
 *  factor (code + email restore), which already proved control of this email via a mailed 6-digit code — so the user IS
 *  logged in and shouldn't be asked to "verify email" again. There's no idToken/kp here, so the first time an
 *  email-GATED Space needs a cryptographic proof, ensureIdentity() falls through to a normal (silent Google / email-code)
 *  verification and upgrades the anchor. For the UI + Sign-in/Sign-out state, this is the identity. */
export function noteVerifiedEmail(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return
  anchorSet({ method: 'email', email: e, exp: Date.now() + 30 * 24 * 3600 * 1000 })
}
