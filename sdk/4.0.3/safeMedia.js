// safeMedia.js — SAFE MEDIA on the device (docs/safe-media.md; the owner, 2026-10-26: "do it"). A photo or a PDF is made safe
// ONCE, when it is posted: the posting device sends it — sealed to the tools enclave's ATTESTED key — through the Space
// server (op:'safemedia', which sees ciphertext only), and gets back, sealed to its one-time key, the safe versions (JPEGs our
// enclave encoded from pixels a keyless one-shot parser produced) with an attestation whose nonce is sha256(statement). Every
// other device checks that attestation BEFORE it decodes anything: a version is drawn only if the hardware vouches that this
// enclave image (PCR0) and the safe-media tool (its register) made exactly these bytes.
//
//   makeSafe({ bytes, kind, mime }, { client, idToken })  → { statement, att, versions: [{ w, h, bytes }], text }   (posting)
//   verifySafe({ statement, att }, versionBytes)           → { ok, why, st }                                        (reading)
import { sealTo, openBox, genRecipientKey } from './e2ee.js'
import { verifyAttestation, b64ToBytes } from './nitroVerify.js'
import { SAFE_MEDIA_PINS } from './safeMediaPins.js'
import { checkToolPaired } from './followImage.js' // a tools-enclave image released since, by its release log (docs/release-trust-design.md § 6)

export const SAFE_USER_DATA = 'witbitz-safe-media-v1' // app/sealed.go safeUserData
export const SAFE_REGISTER = 20 // infra/tools-enclave/build-blobs.sh PCR_safe_media
export const SAFE_MAX_INPUT = 3 * 1024 * 1024 // what op:'safemedia' carries after two base64 layers (agent/safeMediaRelay.mjs MAX_BOX)

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
const stdB64 = (bytes) => { let s = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s) }
const fromStdB64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0))

/** The accepted builds: { pcr0: [hex96…], register: [hex96…] } — empty until a release names them (safeMediaPins.js). */
function pinsOf (pins) {
  const p = pins || SAFE_MEDIA_PINS || {}
  return { pcr0: Array.isArray(p.pcr0) ? p.pcr0 : [], register: Array.isArray(p.register) ? p.register : [] }
}

/** Is there an accepted safe-media build at all? — until a release names one, the room setting is not offered. */
export const safeMediaReady = (pins) => { const p = pinsOf(pins); return p.pcr0.length > 0 && p.register.length > 0 }

/** A statement + its attestation → { ok, why, st }. `versionBytes[i]` (when given) must hash to the statement's versions[i];
 *  checked as of the document's OWN time (a stored statement outlives the ~3-hour Nitro leaf, as turn certificates do). */
export async function verifySafe ({ statement, att } = {}, versionBytes = [], { pins, root, follow } = {}) {
  const p = pinsOf(pins)
  if (!p.pcr0.length || !p.register.length) return { ok: false, why: 'no accepted safe-media build yet' }
  if (typeof statement !== 'string' || typeof att !== 'string') return { ok: false, why: 'no statement' }
  let st
  try { st = JSON.parse(statement) } catch { return { ok: false, why: 'the statement is not readable' } }
  if (!st || st.v !== 1 || st.tool !== 'safe_media' || !Array.isArray(st.versions)) return { ok: false, why: 'not a safe-media statement' }
  try {
    const nonce = await sha256(enc.encode(statement))
    const doc = await checkToolPaired((p0, reg) => verifyAttestation(fromStdB64(att), { root, nonce, expectedPCRs: { 0: p0, [SAFE_REGISTER]: reg }, atDocTime: true }), p, SAFE_REGISTER, follow === undefined ? {} : { follow })
    if (!doc.userData || new TextDecoder().decode(doc.userData) !== SAFE_USER_DATA) return { ok: false, why: 'not a safe-media attestation' }
  } catch (e) { return { ok: false, why: String((e && e.message) || e).split('\n')[0] } }
  for (let i = 0; i < versionBytes.length; i++) {
    if (!versionBytes[i]) continue
    const want = st.versions[i] && st.versions[i].sha256
    if (!want || hex(await sha256(versionBytes[i])) !== want) return { ok: false, why: 'a safe version is not the one the enclave made' }
  }
  return { ok: true, why: '', st }
}

/** Does `orig` hash to what the statement says was made safe? — checked before "Open original" opens it. */
export async function isTheOriginal (st, orig) { return !!(st && orig && hex(await sha256(orig)) === st.orig) }
/** THE ONE CHECK the app (safeMediaRoom.js) and the SDK (sdkSafeMedia.js) run over a photo's safe copies (sync sweep 2026-11-09,
 *  still open P3 — it was written twice): the first candidate whose fetched versions VERIFY and whose statement was made from
 *  THIS original (sync sweep 2026-10-29 #1). `fetch(cand, versions)` → { bytes, ...extra } (bytes as verifySafe takes them; a
 *  throw = could not be fetched); `verify(safe, bytes)` → { ok, st, why }; `original()` → the original's bytes (read once, only
 *  when a copy verifies). → { ok: true, cand, st, ...extra, bytes } | { ok: false, why } */
export async function firstVerifiedCopy (cands, { fetch, verify, original }) {
  let why = '', orig
  for (const cand of cands) {
    const vs = cand && cand.c && cand.c.safe && Array.isArray(cand.c.safe.versions) ? cand.c.safe.versions : []
    if (!vs.length) continue
    let got = null
    try { got = await fetch(cand, vs) } catch { got = null }
    if (!got || !got.bytes) { why = 'a safe copy could not be fetched'; continue }
    const v = await verify(cand.c.safe, got.bytes)
    if (!v || !v.ok) { why = (v && v.why) || 'the safe copy does not verify'; continue }
    if (orig === undefined) { try { orig = (await original()) || null } catch { orig = null } }
    if (!orig || !(await isTheOriginal(v.st, orig))) { why = orig ? 'the copy was made from another file' : 'the original could not be read to check the copy against it'; continue }
    return { ok: true, cand, st: v.st, ...got }
  }
  return { ok: false, why: why || 'no safe copy verifies' }
}

/** The enclave's front key, from a FRESH attestation for our nonce (PCR0 + the safe-media register) → its public JWK. */
async function frontKey (client, idToken, pins, root, now) {
  const p = pinsOf(pins)
  if (!p.pcr0.length || !p.register.length) throw new Error('safe media is not available in this build yet')
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  const r = await client.safeMedia(idToken, { step: 'attest', nonce: hex(nonce) })
  if (!r || r.status !== 200 || typeof r.cose !== 'string') throw new Error((r && (r.reason || r.error)) || 'the safe-media enclave did not answer')
  const doc = await checkToolPaired((p0, reg) => verifyAttestation(fromStdB64(r.cose), { root, nonce, expectedPCRs: { 0: p0, [SAFE_REGISTER]: reg }, maxAgeMs: 5 * 60_000, ...(now ? { now } : {}) }), p, SAFE_REGISTER)
  if (!doc.publicKey) throw new Error('the enclave named no key')
  const key = await crypto.subtle.importKey('spki', doc.publicKey, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  const jwk = await crypto.subtle.exportKey('jwk', key)
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

/** Make a file safe (the POSTING device): → { statement, att, versions: [{ w, h, bytes }], text } — verified here too, so a
 *  device never stores a result it would itself refuse. Throws with a reason a person can read. */
export async function makeSafe ({ bytes, kind, mime = '' }, { client, idToken, pins, root, now } = {}) {
  if (kind !== 'image' && kind !== 'pdf') throw new Error('only photos and PDFs are made safe')
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!b.length || b.length > SAFE_MAX_INPUT) throw new Error('this file is too large to make safe')
  const to = await frontKey(client, idToken, pins, root, now)
  const reply = await genRecipientKey()
  const box = await sealTo(JSON.stringify({ v: 1, reply: { x: reply.publicJwk.x, y: reply.publicJwk.y }, job: { kind, mime: String(mime).slice(0, 80), data: stdB64(b) } }), to)
  const r = await client.safeMedia(idToken, { step: 'make', box })
  if (!r || r.status !== 200 || !r.box) throw new Error((r && (r.reason || r.error)) || 'the safe-media enclave did not answer')
  const plain = await openBox(r.box, reply.privateJwk)
  if (plain == null) throw new Error('the answer was not sealed to this device')
  const rep = JSON.parse(plain)
  if (rep.error) throw new Error(rep.error)
  const versions = (rep.versions || []).map((v) => ({ w: v.w, h: v.h, bytes: fromStdB64(v.jpeg) }))
  const v = await verifySafe({ statement: rep.statement, att: rep.att }, versions.map((x) => x.bytes), { pins, root })
  if (!v.ok) throw new Error('the safe versions did not verify: ' + v.why)
  if (!(await isTheOriginal(v.st, b))) throw new Error('the enclave made safe another file')
  return { statement: rep.statement, att: rep.att, versions, text: rep.text || '' }
}

export { b64ToBytes }
