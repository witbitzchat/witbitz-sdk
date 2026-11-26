// accountScope.js — which app a sign-in speaks for, and the ACCOUNT it may act on (2026-10-05 review, F1).
//
// THE HOLE. The SDK signs a builder's users in against Witbitz's own issuer from any website (CORS *), and every issuer
// minted the same audience — so a token a builder's page obtained was accepted as the user's FIRST-PARTY Witbitz account:
// erase it, mint billing tokens on it, revoke its connections, release its @username. A builder is supposed to be blind.
//
// THE RULE (one module, imported by the page and the Space Lambda, so both derive the same account):
//   • a token is FIRST-PARTY when its issuer is one of Witbitz's own and it carries no `app` claim. The sign-in endpoints
//     add `app: <origin>` when the request came from any other website (spaces/functions/api/email/_email.js appClaim).
//   • anything else speaks for an APP: the `app` claim, or — a tenant's own issuer — the issuer itself.
//   • an app's account is the user's email with a tag in the DOMAIN: dana@x.com → dana@x.com.app-<12 hex>. It still has
//     the shape every account check expects (the Sentinel's ACCOUNT regex), and nobody can sign in AS it: no mail is
//     delivered to a domain whose last label is not a real TLD. (A `+tag` in the local part would be a real, registrable
//     mailbox on a domain without plus-addressing.)
// Room admission is untouched: a gate asks "is this email allowed", and both kinds of token prove the email.

export const FIRST_PARTY_ISSUERS = Object.freeze([
  'https://witbitz-spaces.pages.dev', // the Spaces app's own email sign-in
  'https://app.witbitz.chat', // the tenant app (auth broker)
  'https://spaces.witbitz.chat', // its vault
  'https://witbitz-vault-prod.pages.dev',
  'https://witbitz-spaces-vaulted.pages.dev',
  'https://accounts.google.com', // Google sign-in under Witbitz's own OAuth client
  'accounts.google.com',
])
const FIRST = new Set(FIRST_PARTY_ISSUERS)

/** The payload of a JWT (no verification — call this on a token a verifier already accepted). null when malformed. */
export function tokenClaims(idToken) {
  try {
    const p = String(idToken || '').split('.')[1]
    if (!p) return null
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/')
    const json = typeof atob === 'function' ? new TextDecoder().decode(Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0))) : Buffer.from(p, 'base64url').toString('utf8')
    const o = JSON.parse(json)
    return o && typeof o === 'object' ? o : null
  } catch { return null }
}

/** null = the user's own Witbitz account; else the app (an origin, or a tenant issuer) the token speaks for. */
export function tokenApp(claims) {
  if (!claims || typeof claims !== 'object') return 'unknown'
  const iss = String(claims.iss || '').replace(/\/$/, '')
  if (!FIRST.has(iss)) return iss || 'unknown'
  if (claims.app !== undefined && claims.app !== null) return String(claims.app) || 'unknown'
  return null
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
async function sha256Hex(s) {
  const data = new TextEncoder().encode(s)
  if (globalThis.crypto && globalThis.crypto.subtle) return hex(await globalThis.crypto.subtle.digest('SHA-256', data))
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(data).digest('hex')
}

/** The account a token may act on: the email itself for a first-party token, the app-tagged account otherwise. */
export async function scopedAccount(email, claims) {
  const e = String(email || '').trim().toLowerCase()
  const app = tokenApp(claims)
  if (!app) return e
  return `${e}.app-${(await sha256Hex('witbitz-app-scope\n' + app)).slice(0, 12)}`
}

// ── THE VAULTED APP IS ITS OWN APP AT THE SENTINEL (the owner, 2026-10-23: "All access to data of the same user to a different
// app should be gated by the server"; "Regular keeps all, vaulted starts empty"). Rooms were already split by tenant
// origin (10-18), but what the Sentinel keeps PER PERSON — connections, the Siri inbox, outside agents — was filed under the
// plain email by both first-party apps, so each saw and could revoke the other's: a connection made in the vaulted app
// showed in the regular app as "connected on another device". The vaulted app's requests now act on its own account (the
// same tag scheme as any app), the regular app keeps the plain email. Decided by the ORIGIN the request comes from — the
// browser sets it and a page cannot change it; the Lambda reads it from the request, the page from its own location — so
// both derive the same account (the Sentinel refuses a sealed record whose account is not the verified one).
// ONLY the Sentinel's per-person data: @usernames, the directory and room admission keep the plain email in both apps.
export const VAULTED_APP_ORIGINS = Object.freeze([
  'https://app.witbitz.chat', // the vaulted app's frame
  'https://spaces.witbitz.chat', // its vault
  'https://witbitz-vault-prod.pages.dev',
  'https://witbitz-spaces-vaulted.pages.dev',
])
export const VAULTED_APP = 'https://app.witbitz.chat' // one scope for the whole vaulted product
const VAULTED = new Set(VAULTED_APP_ORIGINS)
/** The account a request may act on at the Sentinel: an app's token → its app account (scopedAccount); a first-party token →
 *  the vaulted app's own account when the request comes from the vaulted app's origins, the plain email otherwise. */
export async function sentinelAccount(email, claims, { origin = '' } = {}) {
  if (tokenApp(claims)) return scopedAccount(email, claims)
  const e = String(email || '').trim().toLowerCase()
  if (!VAULTED.has(String(origin || '').replace(/\/$/, ''))) return e
  return `${e}.app-${(await sha256Hex('witbitz-app-scope\n' + VAULTED_APP)).slice(0, 12)}`
}
// ── WHICH FIRST-PARTY APP A TOKEN NAMES (docs/standing-sentinel.md § Related; the owner, 2026-11-07: "Do it"). The Origin rule
// above holds in a browser; a PROGRAM holding the person's token can send either origin and reach the other app's records.
// The token already says which app minted it: the vaulted app signs in on its own issuers (the vault's email code mints as its
// Pages project, the auth broker's Google handoff as the vault's origin — complete.js), the regular app on its own
// (witbitz-spaces.pages.dev) or with Google's own token. Stage 1 compares the two answers and counts the mismatches; the
// Lambda decides by the token only behind SENTINEL_APP_BY_TOKEN, and the Sentinel image follows.
const REGULAR_ISSUERS = new Set(['https://witbitz-spaces.pages.dev', 'https://accounts.google.com', 'accounts.google.com'])
/** A first-party token → 'vaulted' | 'regular' (the app that minted it); an app's token, or a first-party issuer that names
 *  neither, → null. */
export function firstPartyAppOf(claims) {
  if (!claims || typeof claims !== 'object' || tokenApp(claims)) return null
  const iss = String(claims.iss || '').replace(/\/$/, '')
  if (VAULTED.has(iss)) return 'vaulted'
  if (REGULAR_ISSUERS.has(iss)) return 'regular'
  return null
}
/** The app a request's Origin names: 'vaulted' for the vaulted app's origins, 'regular' otherwise. */
export const originAppOf = (origin) => (VAULTED.has(String(origin || '').replace(/\/$/, '')) ? 'vaulted' : 'regular')

/** The page's side: this page's account at the Sentinel for a sign-in token ({ email, idToken }). */
export const myAccountFor = (tok) => sentinelAccount(tok && tok.email, tokenClaims(tok && tok.idToken), { origin: (typeof location !== 'undefined' && location.origin) || '' })
/** The person's email in an account at the Sentinel: an app account (`dana@x.com.app-<12 hex>`) without its app tag. For
 *  showing it, and for "is this person a member" (a Space's members are emails, never app accounts). */
export const accountEmail = (acct) => String(acct || '').replace(/\.app-[0-9a-f]{12}$/, '')

