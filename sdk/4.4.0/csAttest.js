// csAttest.js — verify a GCP Confidential Space attestation JWT, isomorphic (browser + Node), zero-dep (WebCrypto).
//
// The BROWSER CLIENT uses this to verify the OHTTP RELAY before sending any oblivious request — so "the code that
// sees your IP is measured, and it doesn't log it" is a property you CHECK, not a promise. A Confidential Space token
// is a Google-signed JWT: Intel-TDX-rooted, secure-boot, debug-off, the running image digest bound to a published
// release, and (when requested) a client nonce echoed for liveness / connection binding.
//
// This is the deliberate browser TWIN of agent/gatewayAttest.mjs (which verifies TrustedRouter's gateway the same
// way). They are kept as two files because they deploy to two domains that share NO source: agent/ ships in the
// Lambda + enclave bundles (which copy only agent/), spaces/public/ ships to Cloudflare Pages. Same check, tested on
// both sides — merging them would break one bundle's module resolution (the controlplane-closure class of bug).
const subtle = (globalThis.crypto && globalThis.crypto.subtle)
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
const _dec = new TextDecoder()
function b64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='
  if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
  return new Uint8Array(Buffer.from(s, 'base64')) // Node fallback
}

let _jwks = null // { at, url, keys: Map(kid→CryptoKey) }
async function jwksKey(kid, jwksUrl, fetchImpl, now) {
  if (!_jwks || _jwks.url !== jwksUrl || now - _jwks.at > 3600_000 || !_jwks.keys.has(kid)) {
    const r = await fetchImpl(jwksUrl)
    if (!r || !r.ok) throw new Error('jwks_fetch_failed')
    const body = await r.json()
    const keys = new Map()
    for (const k of body.keys || []) {
      if (!k || !k.kid || k.kty !== 'RSA') continue
      try { keys.set(k.kid, await subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e }, RS256, false, ['verify'])) } catch { /* skip */ }
    }
    _jwks = { at: now, url: jwksUrl, keys }
  }
  return _jwks.keys.get(kid) || null
}
export function _resetCsCache() { _jwks = null; _pinned = null }

// PINNED JWKS: pass opts.jwks (a { keys:[…] } object baked into the client at deploy) to verify WITHOUT ever fetching
// Google — so the party being protected never reveals its IP to googleapis.com just to check a signature. The keys are
// Google's PUBLIC signing keys, so baking them leaks nothing; they rotate, so re-bake on deploy (a kid miss ⇒ verify
// fails closed rather than silently fetching). Same "pin the root, don't fetch it" discipline as the Nitro path.
let _pinned = null // { src, keys: Map(kid→CryptoKey) }
async function pinnedKey(kid, jwks) {
  if (!_pinned || _pinned.src !== jwks) {
    const keys = new Map()
    for (const k of (jwks && jwks.keys) || []) {
      if (!k || !k.kid || k.kty !== 'RSA') continue
      try { keys.set(k.kid, await subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e }, RS256, false, ['verify'])) } catch { /* skip */ }
    }
    _pinned = { src: jwks, keys }
  }
  return _pinned.keys.get(kid) || null
}

export const CS_DEFAULTS = {
  iss: 'https://confidentialcomputing.googleapis.com',
  jwksUrl: 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com',
  hwmodel: 'GCP_INTEL_TDX',
  swname: 'CONFIDENTIAL_SPACE',
}

/**
 * Verify a Confidential Space JWT string against expected identity.
 * @param token   the raw JWT
 * @param expect  { aud, subProject, digests?, nonce? } — aud + operator project are REQUIRED; digests pins the image,
 *                nonce (if given) must appear in eat_nonce (liveness / connection binding).
 * Returns { ok:true, imageDigest, imageReference, sub, exp } | { ok:false, error }. Never throws.
 */
export async function verifyCsToken(token, expect = {}, { fetchImpl = (typeof fetch !== 'undefined' ? fetch : null), now = Date.now(), ...cfg } = {}) {
  const c = { ...CS_DEFAULTS, ...cfg }
  try {
    if (!subtle) return { ok: false, error: 'no_webcrypto' }
    const [h64, p64, s64] = String(token).trim().split('.')
    if (!h64 || !p64 || !s64) return { ok: false, error: 'not_jwt' }
    const header = JSON.parse(_dec.decode(b64uToBytes(h64)))
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, error: 'bad_header' }
    // Pinned keys (opts.jwks) verify offline — NO googleapis.com fetch; else fall back to the live JWKS.
    const key = c.jwks ? await pinnedKey(header.kid, c.jwks) : await jwksKey(header.kid, c.jwksUrl, fetchImpl, now)
    if (!key) return { ok: false, error: c.jwks ? 'unknown_kid_pinned' : 'unknown_kid' }
    const okSig = await subtle.verify(RS256, key, b64uToBytes(s64), new TextEncoder().encode(h64 + '.' + p64))
    if (!okSig) return { ok: false, error: 'bad_signature' }
    const p = JSON.parse(_dec.decode(b64uToBytes(p64)))
    const sec = Math.floor(now / 1000)
    if (!(p.iat <= sec + 60 && p.exp >= sec - 60)) return { ok: false, error: 'stale' }
    if (p.iss !== c.iss) return { ok: false, error: 'wrong_iss' }
    if (expect.aud && p.aud !== expect.aud) return { ok: false, error: 'wrong_aud' }
    if (expect.subProject && !String(p.sub || '').includes('/projects/' + expect.subProject + '/')) return { ok: false, error: 'wrong_operator' }
    if (p.hwmodel !== c.hwmodel || p.swname !== c.swname) return { ok: false, error: 'wrong_platform' }
    if (p.secboot !== true) return { ok: false, error: 'no_secboot' }
    if (p.dbgstat !== 'disabled-since-boot') return { ok: false, error: 'debug_enabled' }
    if (expect.nonce) { // liveness / connection binding — the client's fresh nonce must be echoed
      const nonces = Array.isArray(p.eat_nonce) ? p.eat_nonce : (p.eat_nonce ? [p.eat_nonce] : [])
      if (!nonces.includes(expect.nonce)) return { ok: false, error: 'nonce_absent' }
    }
    const cont = (p.submods && p.submods.container) || {}
    const digest = String(cont.image_digest || '')
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return { ok: false, error: 'no_image_digest' }
    const pins = Array.isArray(expect.digests) ? expect.digests : []
    if (pins.length && !pins.includes(digest)) return { ok: false, error: 'unpinned_image', imageDigest: digest }
    return { ok: true, imageDigest: digest, imageReference: String(cont.image_reference || ''), sub: String(p.sub || ''), exp: p.exp }
  } catch (e) { return { ok: false, error: 'verify_' + String((e && e.message) || e).slice(0, 80) } }
}

/** Fetch the attestation from a URL, then verify. `attestUrl` may append the nonce as CS requires. */
export async function fetchAndVerifyCs(attestUrl, expect = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  try {
    const r = await fetchImpl(attestUrl)
    if (!r || !r.ok) return { ok: false, error: 'fetch_' + (r && r.status) }
    return verifyCsToken((await r.text()).trim(), expect, opts)
  } catch (e) { return { ok: false, error: 'fetch_' + String((e && e.message) || e).slice(0, 80) } }
}
