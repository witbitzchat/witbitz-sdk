// spaces/public/mkseal.js — seal the room key TO THE SERVICE'S PUBLIC KEY before it goes on the wire.
//
// WHAT THIS DOES: removes `mk` from every surface that captures request bodies without meaning to — API Gateway's
// "log full requests/responses", WAF body logging to Firehose/S3, a `console.log(event)` added while debugging, an
// exception handler that serialises the event, an intercepting proxy. Each of those archives ciphertext to a key that
// is not in the archive. That is the common way keys actually leak, and this closes all of it at once.
//
// WHAT THIS DOES NOT DO — say it plainly, because overclaiming here would be worse than not shipping it: the Lambda
// unwraps `mk` and holds it in memory for the turn, exactly as before. This is NOT protection against the operator.
// The honest sentence is "your key is never transmitted in a form logging can capture", never "we can't read it".
//
// WHY IT'S WORTH BUILDING ANYWAY: it is the migration path. Today the private half lives in the service; tomorrow it
// can live only inside an attested enclave with key release gated on the measured image, and NOTHING on this side
// changes — same wire format, same client, same receipts. Protocol changes are expensive to coordinate; key-custody
// changes are not. Ship the protocol now, upgrade the trust property later.
//
// CONSTRUCTION: ephemeral-static ECDH (P-256) → HKDF-SHA256 → AES-256-GCM. That is HPKE base mode in shape, hand-rolled
// on the same WebCrypto primitives e2ee.js already uses so a certified, egress-locked, reproducible build gains no new
// dependency. It is NOT an RFC 9180 implementation and must not be described as one.
//
// The AAD is what makes this more than a wrapper. Sealed to a static public key with no binding, the ciphertext is
// itself a bearer token: capture it from a log, replay it, and you have the same power as holding mk. Binding
// room|op|ts|nonce means a captured blob only works for that exact operation, inside the freshness window, once.
const VERSION = 1
const enc = new TextEncoder()

// ── THE SEAL CLOCK (state machines pass 7, T#2). A seal's `ts` must be within 60 s of the ENCLAVE's clock (agent/mkUnseal.mjs
//   DEFAULT_SKEW_MS), so a device whose clock was off had every confidential request refused, with no way back. Every seal's
//   `ts` reads sealNow(): the device clock plus an offset learned from the enclave — from a refused envelope's `now`
//   (agent/reqEnvelope.mjs) or a fresh attestation's own timestamp (enclaveRoute.js). Clamped to ±1 day: a front that lies
//   can make requests fail (it can anyway), never move this clock further.
export const MAX_CLOCK_OFFSET_MS = 86_400_000
// Kept on the realm, not the module: this file is imported under more than one URL (with and without ?v=), and each would
// otherwise hold its own offset.
const CLOCK = (globalThis.__wbSealClock = globalThis.__wbSealClock || { offset: 0 })
export const sealNow = () => Date.now() + CLOCK.offset
export const clockOffset = () => CLOCK.offset
/** Learn the offset from a server time taken just now. → true when it moved by more than a second (a retry is worth it). */
export function noteServerClock (serverNow, localNow = Date.now()) {
  const t = Number(serverNow)
  if (!Number.isFinite(t) || t <= 0) return false
  const d = Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, Math.round(t - localNow)))
  const moved = Math.abs(d - CLOCK.offset) > 1000
  CLOCK.offset = d
  return moved
}
export const _resetSealClock = () => { CLOCK.offset = 0 } // test hook

function b64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The canonical bound context. MUST match agent/mkUnseal.mjs byte for byte — the cross-module test pins it.
 *  `|` is safe as a separator: room ids are slugs, op is from a fixed set, ts is a number, nonce is base64url. */
export function mkAad({ room, op, ts, nonce } = {}) {
  return `mkseal-v1|${room || ''}|${op || ''}|${ts || 0}|${nonce || ''}`
}

/** A single-use request nonce (base64url, 96 bits). Paired with `ts` it makes a captured blob replayable at most once,
 *  inside the skew window, for the one operation it was sealed for. */
export function newNonce() {
  return b64(crypto.getRandomValues(new Uint8Array(12)))
}

/** Seal `mk` to the service's public key (JWK, P-256), bound to `aad`. → { v, epk, iv, ct }, all base64url.
 *  A fresh ephemeral keypair per call, so two seals of the same key share no bytes and a captured blob is never a
 *  stable fingerprint of the room. */
export async function sealMk(mk, publicJwk, aad) {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256))
  const key = await deriveKey(shared, epk)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(String(aad || '')) }, key, enc.encode(String(mk)),
  ))
  return { v: VERSION, epk: b64(epk), iv: b64(iv), ct: b64(ct) }
}

/** Seal the sign-in identity — `{ idToken, from }` — to the service's public key, bound to `aad`, in the SAME envelope
 *  as `sealMk`. Rides alongside `mkSealed` on a turn; the enclave unwraps it inside the measured image, so the email
 *  never reaches the operator. Same limits as sealMk: out of body-logging today, out of the operator's view only once
 *  the private half lives enclave-only. Ship the protocol now, upgrade the trust property later. */
export async function sealIdentity(fields, publicJwk, aad) {
  return sealMk(JSON.stringify(fields || {}), publicJwk, aad)
}

// HKDF over the ECDH shared secret, with the ephemeral public key folded into `info` so the derived key is bound to
// this exact encapsulation (HPKE binds its KEM context the same way). Salt empty — the shared secret is already
// uniformly random. Must stay identical to the server's deriveKey.
async function deriveKey(shared, epk) {
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const info = new Uint8Array([...enc.encode('mkseal-v1'), ...epk])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}
