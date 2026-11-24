// emailSignIn.js — signing in with an emailed code, one protocol for the vault, the Spaces app and the SDK
// (docs/sdk-convergence.md, phase 5). Each side keeps its own SCREENS (the vault's sheet, the app's overlay, a builder's
// form); the wire and its rules live here:
//   start   — mail a code, bound to this device's signing key through `nonce` → { ticket }
//   verify  — the code → an RS256 token for the verified email (the server accepts it like a Google token)
//   refresh — the same session onto a NEW key, without a new code: the OLD key signs the new nonce (proof it is the
//             device that verified). The app has always renewed this way; the SDK now can too (wb.refreshSession()).
// `post` is a function (path, body) → parsed JSON | null. makeEmailPost tries the local origin first and, when it has no
// email stack, the auth broker's relay — the vault's behaviour.
import { signAssertion } from './entrySig.js'

const RELAY_MAP = { '/api/email/start': '/api/relay/start', '/api/email/verify': '/api/relay/verify', '/api/email/refresh': '/api/relay/refresh', '/api/email/adopt': '/api/relay/adopt' }
export function makeEmailPost (base, { broker = '', fetchImpl = (...a) => fetch(...a) } = {}) {
  const call = async (url, body) => { try { return await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()) } catch { return null } }
  return async (path, body) => {
    const local = await call(String(base || '').replace(/\/$/, '') + path, body)
    if (local && local.configured !== false) return local
    const rp = RELAY_MAP[path]
    if (!broker || !rp) return local
    return (await call(String(broker).replace(/\/$/, '') + rp, body)) || local
  }
}

export function jwtPayload (jwt) {
  try { const b = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(b)))) } catch { return {} }
}

// Friendly copy for the backend's machine reasons (never a provider's raw body).
export function startError (reason) {
  if (reason === 'invalid email') return 'Enter a valid email address.'
  if (reason === 'too many requests') return 'Too many requests — wait a minute and try again.'
  if (reason === 'invalid room') return 'Something went wrong — reopen the Space and try again.'
  if (typeof reason === 'string' && reason.includes('capacity')) return reason
  return 'Couldn’t send the code — try again.'
}
export function verifyError (reason) {
  if (reason === 'mismatch') return 'That code didn’t match — check it and try again.'
  if (reason === 'expired') return 'That code expired — go back and request a new one.'
  if (reason === 'too many attempts' || reason === 'locked') return 'Too many tries — request a new code.'
  return 'Couldn’t verify that code — try again.'
}
const fail = (code, reason, message) => Object.assign(new Error(message), { code, reason: reason || '' })
export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''))

/** → { ticket }. Throws { code: 'not_configured' | 'start_failed', reason, message (friendly) }. */
export async function emailStart (post, { email, room = '', nonce, tenant = '' }) {
  // `tenant` (the SDK's): lets the mail carry the app's name when this page is on an origin that tenant declared
  const r = await post('/api/email/start', { email: String(email).trim().toLowerCase(), room: String(room || '').slice(0, 200), nonce, ...(tenant ? { tenant: String(tenant).slice(0, 64) } : {}) })
  if (r && r.configured === false) throw fail('not_configured', '', 'Email codes aren’t available right now.')
  if (!r || !r.ok || !r.ticket) throw fail('start_failed', r && r.reason, startError(r && r.reason))
  return { ticket: r.ticket }
}
/** → { jwt, email, exp (ms) }. Throws { code: 'verify_failed', reason, message (friendly) }. */
export async function emailVerify (post, { ticket, code }) {
  const r = await post('/api/email/verify', { ticket, code: String(code).trim() })
  if (!r || !r.ok || !r.jwt) throw fail('verify_failed', r && r.reason, verifyError(r && r.reason))
  const p = jwtPayload(r.jwt)
  return { jwt: r.jwt, email: String(p.email || '').toLowerCase(), exp: (Number(p.exp) || 0) * 1000 }
}
/** The session onto a new key. `kpOld` = { priv, pub } the token is bound to; `newNonce` = the new key's nonce.
 *  → { jwt, email, exp } | null (the caller falls back to a new code). */
export async function emailRefresh (post, { token, kpOld, newNonce, tenant }) { // tenant: a builder's app — its scope rides the renewed token when the registry holds this origin as the tenant's proven one (docs/device-gate-design.md § 12.1)
  try {
    const ts = Date.now()
    const sig = await signAssertion(kpOld.priv, { act: 'email-refresh', to: String(newNonce), ts })
    const r = await post('/api/email/refresh', { token, spkOld: kpOld.pub, newNonce, ts, sig, ...(tenant ? { tenant: String(tenant).slice(0, 64) } : {}) })
    if (!r || !r.ok || !r.jwt) return null
    const p = jwtPayload(r.jwt)
    return { jwt: r.jwt, email: String(p.email || '').toLowerCase(), exp: (Number(p.exp) || 0) * 1000 }
  } catch { return null }
}
