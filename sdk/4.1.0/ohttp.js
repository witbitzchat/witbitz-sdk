// ohttp.js — Oblivious HTTP (RFC 9458) over HPKE (RFC 9180) + Binary HTTP (RFC 9292), isomorphic (browser + Node),
// zero-dependency (WebCrypto only). This is the CLIENT-side encapsulation and the shared crypto; the gateway
// (agent/ohttpGateway.mjs) imports the same primitives for decapsulation.
//
// WHAT IT BUYS: it splits WHO from WHAT. The client encrypts the whole HTTP request to the GATEWAY's public key and
// sends it through a RELAY. The relay sees the client IP but only ciphertext; the gateway decrypts but sees only the
// relay's IP. Neither party alone links a user to their room. (Sizes/timing = the separate shaping axis; not here.)
//
// Ciphersuite = the OHTTP-mandatory-to-implement one, chosen for pure-WebCrypto support in every browser TODAY:
//   KEM  0x0010  DHKEM(P-256, HKDF-SHA256)   (ECDH P-256 + HKDF; X25519 would be nicer but isn't universal in WebCrypto)
//   KDF  0x0001  HKDF-SHA256
//   AEAD 0x0001  AES-128-GCM
// Verified byte-for-byte against the official CFRG HPKE test vectors (agent/ohttp.test.mjs).
const subtle = (globalThis.crypto && globalThis.crypto.subtle)
if (!subtle) throw new Error('ohttp: WebCrypto subtle unavailable')

export const SUITE = { kemId: 0x0010, kdfId: 0x0001, aeadId: 0x0001, Nsecret: 32, Nh: 32, Nk: 16, Nn: 12, Nenc: 65, Npk: 65 }

// ── byte helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const te = new TextEncoder()
export const cat = (...as) => { let n = 0; for (const a of as) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of as) { o.set(a, i); i += a.length } return o }
export const i2osp = (n, len) => { const o = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { o[i] = n & 0xff; n = Math.floor(n / 256) } return o }
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
export const unhex = (s) => { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o }
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// ── HKDF (separate Extract/Expand — WebCrypto only exposes the combined form, so build it from HMAC) ────────────────
async function hmac(key, data) {
  const k = await subtle.importKey('raw', key.length ? key : new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', k, data))
}
const extract = (salt, ikm) => hmac(salt, ikm)
async function expand(prk, info, L) {
  const out = []; let t = new Uint8Array(0)
  for (let i = 1; out.reduce((n, b) => n + b.length, 0) < L; i++) { t = await hmac(prk, cat(t, info, new Uint8Array([i]))); out.push(t) }
  return cat(...out).slice(0, L)
}
// Labeled variants (RFC 9180 §4). suite_id distinguishes the KEM sub-context from the full HPKE context.
const kemSuite = cat(te.encode('KEM'), i2osp(SUITE.kemId, 2))
const hpkeSuite = cat(te.encode('HPKE'), i2osp(SUITE.kemId, 2), i2osp(SUITE.kdfId, 2), i2osp(SUITE.aeadId, 2))
const labeledExtract = (salt, label, ikm, suite) => extract(salt, cat(te.encode('HPKE-v1'), suite, te.encode(label), ikm))
const labeledExpand = (prk, label, info, L, suite) => expand(prk, cat(i2osp(L, 2), te.encode('HPKE-v1'), suite, te.encode(label), info), L)

// ── DHKEM(P-256, HKDF-SHA256) ───────────────────────────────────────────────────────────────────────────────────────
const importPub = (raw) => subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
async function extractAndExpand(dh, kemContext) {
  const eaePrk = await labeledExtract(new Uint8Array(0), 'eae_prk', dh, kemSuite)
  return labeledExpand(eaePrk, 'shared_secret', kemContext, SUITE.Nsecret, kemSuite)
}
export async function kemEncap(pkRraw, ephemeral) {
  const pkR = await importPub(pkRraw)
  const kp = ephemeral || await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const dh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pkR }, kp.privateKey, 256))
  const enc = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  const shared = await extractAndExpand(dh, cat(enc, pkRraw))
  return { shared, enc }
}
export async function kemDecap(enc, skR, pkRraw) {
  const pkE = await importPub(enc)
  const dh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pkE }, skR, 256))
  return extractAndExpand(dh, cat(enc, pkRraw))
}

// ── HPKE key schedule (mode_base = 0x00) + single-shot AEAD ──────────────────────────────────────────────────────────
export async function keySchedule(shared, info) {
  const pskIdHash = await labeledExtract(new Uint8Array(0), 'psk_id_hash', new Uint8Array(0), hpkeSuite)
  const infoHash = await labeledExtract(new Uint8Array(0), 'info_hash', info, hpkeSuite)
  const ctx = cat(new Uint8Array([0x00]), pskIdHash, infoHash)
  const secret = await labeledExtract(shared, 'secret', new Uint8Array(0), hpkeSuite)
  const key = await labeledExpand(secret, 'key', ctx, SUITE.Nk, hpkeSuite)
  const baseNonce = await labeledExpand(secret, 'base_nonce', ctx, SUITE.Nn, hpkeSuite)
  const exporter = await labeledExpand(secret, 'exp', ctx, SUITE.Nh, hpkeSuite)
  return { key, baseNonce, exporter }
}
const aeadSeal = async (key, nonce, aad, pt) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']), pt))
const aeadOpen = async (key, nonce, aad, ct) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']), ct))
const exportSecret = (ks, ctx, L) => labeledExpand(ks.exporter, 'sec', te.encode(ctx), L, hpkeSuite)

// ── OHTTP request/response (RFC 9458 §4.3/§4.4) ──────────────────────────────────────────────────────────────────────
const reqInfo = (keyId) => cat(te.encode('message/bhttp request'), new Uint8Array([0]), new Uint8Array([keyId]), i2osp(SUITE.kemId, 2), i2osp(SUITE.kdfId, 2), i2osp(SUITE.aeadId, 2))
const hdr = (keyId) => cat(new Uint8Array([keyId]), i2osp(SUITE.kemId, 2), i2osp(SUITE.kdfId, 2), i2osp(SUITE.aeadId, 2))

/** Client: wrap a BHTTP request → { encRequest, ks, enc } (keep ks+enc to open the response). */
export async function encapsulateRequest(keyConfig, bhttp, _ephemeral) {
  const { keyId, publicKey } = keyConfig
  const { shared, enc } = await kemEncap(publicKey, _ephemeral)
  const ks = await keySchedule(shared, reqInfo(keyId))
  const ct = await aeadSeal(ks.key, ks.baseNonce, new Uint8Array(0), bhttp) // seq 0 → nonce = base_nonce
  return { encRequest: cat(hdr(keyId), enc, ct), ks, enc }
}
/** Gateway: unwrap → { bhttp, ks, enc } (keep ks+enc to seal the response). skR = P-256 ECDH private CryptoKey. */
export async function decapsulateRequest(encRequest, skR, pkRraw) {
  const keyId = encRequest[0]
  const enc = encRequest.slice(7, 7 + SUITE.Nenc)
  const ct = encRequest.slice(7 + SUITE.Nenc)
  const shared = await kemDecap(enc, skR, pkRraw)
  const ks = await keySchedule(shared, reqInfo(keyId))
  const bhttp = await aeadOpen(ks.key, ks.baseNonce, new Uint8Array(0), ct)
  return { keyId, bhttp, ks, enc }
}
/** Gateway: seal a BHTTP response. Per RFC 9458 §4.4 the response leg re-keys from the exporter with plain HKDF
 *  (Extract over enc‖nonce, Expand with the raw 'key'/'nonce' infos — NOT the HPKE labeled variants). */
export async function encapsulateResponse(ks, enc, bhttpResp, _fixedNonce) {
  const L = Math.max(SUITE.Nn, SUITE.Nk)
  const responseNonce = _fixedNonce || (globalThis.crypto.getRandomValues(new Uint8Array(L)))
  const secret = await exportSecret(ks, 'message/bhttp response', L)
  const prk = await extract(cat(enc, responseNonce), secret)
  const key = await expand(prk, cat(te.encode('key')), SUITE.Nk)
  const nonce = await expand(prk, cat(te.encode('nonce')), SUITE.Nn)
  const ct = await aeadSeal(key, nonce, new Uint8Array(0), bhttpResp)
  return cat(responseNonce, ct)
}
/** Client: open the sealed BHTTP response. */
export async function decapsulateResponse(ks, enc, encResponse) {
  const L = Math.max(SUITE.Nn, SUITE.Nk)
  const responseNonce = encResponse.slice(0, L)
  const ct = encResponse.slice(L)
  const secret = await exportSecret(ks, 'message/bhttp response', L)
  const prk = await extract(cat(enc, responseNonce), secret)
  const key = await expand(prk, cat(te.encode('key')), SUITE.Nk)
  const nonce = await expand(prk, cat(te.encode('nonce')), SUITE.Nn)
  return aeadOpen(key, nonce, new Uint8Array(0), ct)
}

// ── Binary HTTP (RFC 9292), known-length messages, the subset OHTTP needs ────────────────────────────────────────────
function putVarint(n) {
  if (n < 64) return new Uint8Array([n])
  if (n < 16384) return new Uint8Array([0x40 | (n >> 8), n & 0xff])
  if (n < 1073741824) return new Uint8Array([0x80 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
  throw new Error('varint too large')
}
function getVarint(b, i) {
  const p = b[i] >> 6, len = 1 << p
  let v = b[i] & 0x3f
  for (let j = 1; j < len; j++) v = v * 256 + b[i + j]
  return [v, i + len]
}
const strField = (s) => { const u = te.encode(s); return cat(putVarint(u.length), u) }
const getStr = (b, i) => { const [n, j] = getVarint(b, i); return [new TextDecoder().decode(b.slice(j, j + n)), j + n] }

/** { method, scheme, authority, path, headers:{}, body:Uint8Array } → BHTTP known-length request bytes. */
export function encodeRequest({ method = 'POST', scheme = 'https', authority, path = '/', headers = {}, body = new Uint8Array(0) }) {
  const control = cat(strField(method), strField(scheme), strField(authority), strField(path))
  let fields = new Uint8Array(0)
  for (const [k, v] of Object.entries(headers)) fields = cat(fields, strField(k.toLowerCase()), strField(String(v)))
  const content = cat(putVarint(body.length), body)
  return cat(new Uint8Array([0]), control, putVarint(fields.length), fields, content, putVarint(0)) // framing 0, …, empty trailers
}
export function decodeRequest(b) {
  let i = 1 // framing indicator 0
  let method, scheme, authority, path
  ;[method, i] = getStr(b, i); [scheme, i] = getStr(b, i); [authority, i] = getStr(b, i); [path, i] = getStr(b, i)
  let flen; [flen, i] = getVarint(b, i)
  const fEnd = i + flen; const headers = {}
  while (i < fEnd) { let k, v; [k, i] = getStr(b, i); [v, i] = getStr(b, i); headers[k] = v }
  let clen; [clen, i] = getVarint(b, i)
  const body = b.slice(i, i + clen)
  return { method, scheme, authority, path, headers, body }
}
/** { status, headers, body } → BHTTP known-length response bytes. */
export function encodeResponse({ status = 200, headers = {}, body = new Uint8Array(0) }) {
  let fields = new Uint8Array(0)
  for (const [k, v] of Object.entries(headers)) fields = cat(fields, strField(k.toLowerCase()), strField(String(v)))
  const content = cat(putVarint(body.length), body)
  return cat(new Uint8Array([1]), putVarint(status), putVarint(fields.length), fields, content, putVarint(0)) // framing 1 = response
}
export function decodeResponse(b) {
  let i = 1
  let status; [status, i] = getVarint(b, i)
  let flen; [flen, i] = getVarint(b, i)
  const fEnd = i + flen; const headers = {}
  while (i < fEnd) { let k, v; [k, i] = getStr(b, i); [v, i] = getStr(b, i); headers[k] = v }
  let clen; [clen, i] = getVarint(b, i)
  return { status, headers, body: b.slice(i, i + clen) }
}

export { eq as _eq }
