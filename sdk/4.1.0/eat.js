// eat.js — Witbitz attestation as standard ENTITY ATTESTATION TOKENS (RFC 9711, the JSON/JWT form), in the vocabulary of
// the IETF RATS architecture (RFC 9334). docs/rats-eat.md has the mapping and the profile.
//
// Our attesters (the standing Sentinel, the turn enclave) produce AWS Nitro attestation documents — evidence in AWS's own
// format, which no one can change. An EAT wraps it so a relying party can check it with standard tools:
//   • the token is a JWT, ES256, signed by a P-256 key the ENCLAVE generated;
//   • `measurements` carries the Nitro document as evidence — content format 18 (application/cose; COSE_Sign1) — and that
//     document's `public_key` is the token's signing key, its `nonce` the token's `eat_nonce`;
//   • so: the AWS chain proves the document, the PCRs name the build, and the signature proves THIS token came from it.
// A turn EAT (one per confidential reply) carries no document — it is signed by the same attested key, which a boot EAT
// proves — and the audit's verdicts are ATTESTATION RESULTS (attestationResults below), never passed off as evidence.
import { verifyAttestation } from './nitroVerify.js'

export const EAT_PROFILE = 'https://witbitz.chat/eat/nitro-v1'
export const COSE_SIGN1_CONTENT_FORMAT = 18 // CoAP Content-Format: application/cose; cose-type="cose-sign1"
const MAX_TOKEN = 64 * 1024

const te = new TextEncoder(), td = new TextDecoder()
const b64u = (u8) => { let s = ''; const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const unb64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
const jsonPart = (s, what) => { try { return JSON.parse(td.decode(unb64u(s))) } catch { throw new Error(`eat: the ${what} is not base64url JSON`) } }

/** A fresh ES256 key: { privateKey, publicKey, spki } (spki: DER bytes — what a Nitro document's public_key carries). */
export async function makeEatKey() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return { privateKey: k.privateKey, publicKey: k.publicKey, spki: new Uint8Array(await crypto.subtle.exportKey('spki', k.publicKey)) }
}
/** The `measurements` entry that carries a Nitro document as evidence: [18, base64url(COSE_Sign1)]. */
export const evidenceClaim = (doc) => [COSE_SIGN1_CONTENT_FORMAT, b64u(doc)]
/** Sign a claims-set as a JWT EAT (ES256). WebCrypto's ECDSA signature is already JWS's raw r‖s. */
export async function signEat(claims, privateKey) {
  const head = b64u(te.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })))
  const body = b64u(te.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, te.encode(head + '.' + body))
  return head + '.' + body + '.' + b64u(new Uint8Array(sig))
}

/**
 * Verify a Witbitz EAT. → { ok, claims, doc, userData, pinned }.
 * @param token  the JWT
 * @param opts   { expectedPCRs, nonce, root, now, maxAgeMs, key, profile } — `expectedPCRs` pins the build (without it the
 *               result says pinned:false); `nonce` is YOUR challenge (it must be the token's eat_nonce AND the document's);
 *               `key` (SPKI bytes) verifies a detached EAT (a turn's), whose key a boot EAT proved.
 */
export async function verifyEat(token, { expectedPCRs = null, nonce = null, root, now = Date.now(), maxAgeMs = 0, key = null, profile = EAT_PROFILE } = {}) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) throw new Error('eat: not a token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('eat: a JWT has three parts')
  const [h, p, s] = parts
  const header = jsonPart(h, 'header')
  if (header.alg !== 'ES256') throw new Error('eat: only ES256 is accepted (got ' + JSON.stringify(header.alg) + ')')
  const claims = jsonPart(p, 'claims-set')
  if (!claims || typeof claims !== 'object') throw new Error('eat: the claims-set is not an object')
  if (claims.eat_profile !== profile) throw new Error(`eat: profile ${JSON.stringify(claims.eat_profile)} is not ${profile}`)
  if (nonce !== null && claims.eat_nonce !== nonce) throw new Error('eat: eat_nonce is not the nonce you sent')

  const ev = Array.isArray(claims.measurements) ? claims.measurements.find((m) => Array.isArray(m) && m[0] === COSE_SIGN1_CONTENT_FORMAT && typeof m[1] === 'string') : null
  let doc = null, spki = null
  if (ev) {
    doc = await verifyAttestation(unb64u(ev[1]), {
      ...(root ? { root } : {}), now, maxAgeMs,
      ...(expectedPCRs ? { expectedPCRs } : {}),
      ...(typeof claims.eat_nonce === 'string' ? { nonce: te.encode(claims.eat_nonce) } : {}), // the document was made FOR this token
    })
    if (typeof claims.eat_nonce !== 'string') throw new Error('eat: a token carrying evidence must carry the eat_nonce it was made for')
    if (!doc.publicKey) throw new Error('eat: the attestation document attests no key')
    spki = doc.publicKey
  } else if (key) spki = key instanceof Uint8Array ? key : new Uint8Array(key)
  else throw new Error('eat: no evidence in the token and no attested key to verify it with')

  let pub
  try { pub = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) } catch { throw new Error('eat: the attested key is not a P-256 signing key') }
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(s), te.encode(h + '.' + p))
  if (!ok) throw new Error('eat: the signature does not verify under the attested key')

  let userData = null
  if (doc && doc.userData) { try { userData = JSON.parse(td.decode(doc.userData)) } catch { userData = null } }
  return { ok: true, claims, doc, userData, pinned: !!(ev && expectedPCRs) }
}

/**
 * The audit's verdict as ATTESTATION RESULTS in EAT vocabulary (RFC 9711 §4.2.17 `measres`, §4.2.18 `submods`): what a
 * VERIFIER concluded, not evidence. Unsigned on purpose — the audit runs on the operator's machine, so a signature would
 * be the operator's claim dressed as a proof; its integrity is the verdict log's hash chain and the commit it names.
 */
export function attestationResults({ subject, pass, pcrs = {}, measurement = null, commit = '', at = Date.now(), chain = '' } = {}) {
  const name = String(subject || 'unknown')
  return {
    eat_profile: EAT_PROFILE,
    iat: Math.floor(Number(at) / 1000),
    measres: [['witbitz-audit', [[name, pass ? 'success' : 'fail']]]],
    submods: { [name]: { wbx_pcrs: { ...pcrs }, ...(measurement && typeof measurement === 'object' ? { wbx_measurement: { ...measurement } } : {}), ...(commit ? { wbx_commit: String(commit) } : {}), ...(chain ? { wbx_chain: String(chain) } : {}) } },
  }
}

/** Challenge a door for a fresh EAT and verify it: a random nonce, GET <eatUrl>?nonce=…, verifyEat with your pins.
 *  `eatUrl` is the A2A card's attestation extension `params.eat` (https://agents.witbitz.chat/eat). → verifyEat's result. */
export async function fetchAndVerifyEat(eatUrl, { expectedPCRs = null, fetchImpl = fetch, ...opts } = {}) {
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(24)))
  const res = await fetchImpl(String(eatUrl) + (String(eatUrl).includes('?') ? '&' : '?') + 'nonce=' + nonce, { cache: 'no-store' })
  if (!res.ok) throw new Error(`eat: ${eatUrl} answered ${res.status}`)
  return verifyEat((await res.text()).trim(), { ...opts, expectedPCRs, nonce })
}
