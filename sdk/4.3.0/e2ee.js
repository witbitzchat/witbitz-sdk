// Client-side E2EE for Collections (docs: witbitz-privacy-certification-northstar). A WIRE-COMPATIBLE browser port
// of the agent's platform-blind envelope (agent/envelope.mjs) — same v1 shape { v, iv, ct, recipients:{room} },
// same HKDF(mk,"memwrap")+AES-256-GCM, so a field sealed here in the browser opens with the Node envelope (and the
// reverse). The `mk` (32 random bytes, base64url) lives in the LINK FRAGMENT, and THIS MODULE never transmits it —
// it seals and opens locally. Seal to `room` ⇒ admin-blind; an optional user-held `recovery` key can be added (the
// user's own code) — there is NO operator recipient. What the operator stores is the ciphertext this produces.
//
// ★ READ THIS BEFORE REPEATING THE SENTENCE ABOVE. "mk never reaches the server" is true OF THIS FILE and is NOT true
//   of the product on every tier — and the difference decides what you may tell your users. An agent turn runs
//   server-side, so the ops that carry one (`data`, `send`, `state`, `turn` — see spaceClient.js `keyFields`) send the
//   room key ALONGSIDE this envelope:
//     • CONFIDENTIAL tier — sealed to the enclave's ATTESTED key, gated on the room accepting that measured build, and
//       FAIL-CLOSED (no key ⇒ it throws rather than send the key to the relay). The platform sees opaque bytes. Here
//       the sentence holds architecturally.
//     • STANDARD tier — the key is sent in the clear and the Lambda holds it for the turn. The store still holds only
//       ciphertext, so this protects against the STORE; it does not protect against the operator. spaces/public/
//       mkseal.js states the same limit in its own words and is worth reading.
//   A tenant read this header from the deployed file and described our model to his own users as "mk never reaches
//   the platform" (2026-09-20). He was quoting us accurately. Every comment in this client is SERVED, unminified, on
//   an origin we sign and invite people to verify — so a header here is a published claim, not a note to the next
//   engineer, and an unqualified one will be repeated by someone who cannot see which tier they are on.
//
// This runs untrusted in the browser; its guarantee against the OPERATOR is only as strong as the tier above.
// Its guarantee against the APP holds only for a certified, egress-locked build (the CSP + build-attestation blocks)
// — a malicious build could read the fragment. That composition is the whole point of the north star.
//
// Uses only browser-native crypto/atob/btoa/TextEncoder → also runs in modern Node (for the tests). No deps.
const VERSION = 1
const enc = new TextEncoder()
const dec = new TextDecoder()

// M4: the AAD that binds a v3 ledger box to its {room, absolute-index}. MUST stay BYTE-IDENTICAL to the agent twin
// (agent/spaceLedgerV3.mjs ledgerAad) — unit-separated so it can never collide with a room id. A box moved/replayed to a
// different position fails GCM auth on open() (which applies this as additionalData when the box carries the aad:1 marker).
export const ledgerAad = (room, index) => enc.encode('v3\x1f' + String(room) + '\x1f' + String(index))

// base64url ⇄ bytes, no Buffer (browser-safe; matches Buffer.from(x,'base64url') byte-for-byte).
function b64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function ub64(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/')
  s += '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// mk (base64url, 32 random bytes) → an AES-256-GCM wrap key via HKDF. Stable `info` so reads match writes AND match
// the Node envelope (must be byte-identical: salt = empty, info = "memwrap").
async function roomWrapKey(mk) {
  const ikm = await crypto.subtle.importKey('raw', ub64(mk), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('memwrap') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** A fresh random key (base64url) — mint at collection create, put in the link fragment, NEVER send to the server. */
export function newKey() {
  return b64(crypto.getRandomValues(new Uint8Array(32)))
}

/** Commitment to a key: base64url(SHA-256(key-string)). Store THIS server-side (never the key) so a reader's mk can
 *  be checked (commit(mk) === stored) without the server ever seeing mk. Matches envelope.commit(). */
export async function commit(mk) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(String(mk || '')))
  return b64(new Uint8Array(h))
}

// ── 2-of-2 SHARED-PRESENCE secret sharing (M1b, docs/shared-presence-m1b.md) ───────────────────────────────────────
// Split the room key into TWO shares — one per partner — so NEITHER opens the room alone; only BOTH shares together
// reconstruct mk. XOR = perfect 2-of-2 secrecy: a single share is information-theoretically independent of mk (it's a
// uniform random value, revealing NOTHING). This makes "the room opens only when BOTH are present" CRYPTOGRAPHIC, not
// policy — one partner alone, or the operator, holds only a share and cannot open the room. Each share lives in that
// partner's own link fragment; the server holds only commit(mk). (Exactly 2 required; k-of-n — e.g. a couple + a
// therapist — is a later generalization to Shamir.)
/** Split mk into { shareA, shareB } (each base64url). shareA random, shareB = mk XOR shareA. */
export function splitKey(mk) {
  const k = ub64(mk)
  if (!k.length) throw new Error('splitKey needs a key')
  const a = crypto.getRandomValues(new Uint8Array(k.length))
  const b = new Uint8Array(k.length)
  for (let i = 0; i < k.length; i++) b[i] = k[i] ^ a[i]
  return { shareA: b64(a), shareB: b64(b) }
}
/** Reconstruct mk from BOTH shares (ORDER-INDEPENDENT — a partner needn't know if they're "A" or "B"). Returns the
 *  base64url mk, or null if the shares don't pair up (empty / different lengths). Verify with commit(mk) before trust. */
export function combineShares(shareA, shareB) {
  const a = ub64(shareA || '')
  const b = ub64(shareB || '')
  if (!a.length || a.length !== b.length) return null
  const mk = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) mk[i] = a[i] ^ b[i]
  return b64(mk)
}
/** The both-present OPEN gate: combine two shares AND verify the result against the Space's stored commitment. Returns
 *  mk only if both shares are present and reconstruct the committed key — else null (a lone/wrong/tampered share ⇒ the
 *  room stays sealed). This is the one call the session uses to unseal "only when both are here". */
export async function assembleRoomKey(shareA, shareB, expectedCommit) {
  const mk = combineShares(shareA, shareB)
  if (mk == null) return null
  // §6.4 (tenant-split-key-design.md): a MULTI-SHARE reconstruction is only trustworthy once verified against the room's
  // registered commitment. Refuse to hand back a combined key with no commit to check it against — otherwise a malicious
  // share-provider (a hostile app-plane serving a crafted appShare) could steer the client onto an attacker-chosen key.
  if (!expectedCommit) return null
  if ((await commit(mk)) !== expectedCommit) return null
  return mk
}

async function wrapSym(key, cek) {
  const wk = await roomWrapKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const w = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, cek))
  return { iv: b64(iv), w: b64(w) }
}

/** Seal a string to a MAP of named symmetric recipients — the app picks its privacy level per field by choosing which
 *  keys to include. Every mode is just a recipient set:
 *    • admin-blind, no recovery : { room: mk }                  ← even witbitz can't read; lose the link, lose the data
 *    • user-held recovery        : { room: mk, recovery: recKey } ← recoverable WITHOUT witbitz reading (a user code)
 *  There is NO operator recipient — the platform never holds a reader key (retired 2026-07-31, matching the Node
 *  envelope). `room` is the fragment key (the primary reader) and the ONE slot the platform envelope also opens
 *  (wire-compat); `recovery` is the user's own second key. Returns the v1 envelope. */
export async function seal(plaintext, recipients = {}) {
  const entries = Object.entries(recipients).filter(([, k]) => typeof k === 'string' && k)
  if (!entries.length) throw new Error('seal needs at least one recipient key, e.g. { room: mk }')
  const cek = crypto.getRandomValues(new Uint8Array(32))
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cekKey, enc.encode(String(plaintext))))
  const out = {}
  for (const [slot, key] of entries) out[slot] = await wrapSym(key, cek)
  return { v: VERSION, iv: b64(iv), ct: b64(ct), recipients: out }
}

/** Open a v1 envelope with a symmetric key → plaintext string, or null on wrong key / tamper / malformed (fail-closed).
 *  Tries the key against EVERY symmetric recipient slot, so one call opens whichever slot the caller's key matches
 *  (the fragment key or a user recovery key). Any non-symmetric slot on a legacy record is skipped. */
export async function open(envelope, { mk, aad = null } = {}) {
  if (!isEnvelope(envelope) || !mk) return null
  if (envelope.aad && !aad) return null // M4: a bound ledger box (aad:1) MUST be opened with its {room,index} aad — refuse context-free
  const wk = await roomWrapKey(mk)
  for (const slot of Object.keys(envelope.recipients)) {
    const r = envelope.recipients[slot]
    if (!r || typeof r.iv !== 'string' || typeof r.w !== 'string') continue // skip non-symmetric recipients
    try {
      const cek = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(r.iv) }, wk, ub64(r.w)))
      const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
      const p = { name: 'AES-GCM', iv: ub64(envelope.iv) }
      if (envelope.aad) p.additionalData = aad // verify the box still sits at its sealed {room,index}; a legacy box (no marker) ignores it
      const pt = new Uint8Array(await crypto.subtle.decrypt(p, cekKey, ub64(envelope.ct)))
      return dec.decode(pt)
    } catch {
      /* wrong key / tamper / moved box for this slot → try the next, else fail closed */
    }
  }
  return null
}

/** True if a stored value is a v1 envelope (vs plaintext) — has at least one symmetric recipient. */
export function isEnvelope(o) {
  return !!(
    o && typeof o === 'object' && o.v === VERSION && typeof o.iv === 'string' && typeof o.ct === 'string' &&
    o.recipients && typeof o.recipients === 'object' && Object.values(o.recipients).some((r) => r && typeof r.iv === 'string' && typeof r.w === 'string')
  )
}

// ── Binary sealing (keepsake clips/images) — wire-compatible with agent/envelope.mjs sealBytes/openBytes ───────────
// Same CEK-wrap as seal(), but the ciphertext is RAW BYTES (the `body`, e.g. the S3 object) not base64'd into JSON, so
// a multi-MB video isn't bloated. The small `header` (wrapped CEK + content IV) is JSON — store it as metadata. The
// organizer's console opens with openBytes(body, header, { mk }) to decrypt + download the keepsake locally.
export async function sealBytes(bytes, recipients = {}) {
  const entries = Object.entries(recipients).filter(([, k]) => typeof k === 'string' && k)
  if (!entries.length) throw new Error('sealBytes needs at least one recipient key, e.g. { room: mk }')
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const cek = crypto.getRandomValues(new Uint8Array(32))
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cekKey, data))
  const recips = {}
  for (const [slot, key] of entries) recips[slot] = await wrapSym(key, cek)
  return { header: { v: VERSION, alg: 'bin', iv: b64(iv), recipients: recips }, body }
}

/** Open a sealBytes body + header with a symmetric key → plaintext BYTES (Uint8Array), or null (fail-closed). Tries the
 *  key against EVERY symmetric slot (room / recovery), so the organizer opens whichever slot their key matches. */
export async function openBytes(body, header, { mk } = {}) {
  if (!isBinHeader(header) || !mk || !body) return null
  const data = body instanceof Uint8Array ? body : new Uint8Array(body)
  const wk = await roomWrapKey(mk)
  for (const slot of Object.keys(header.recipients)) {
    const r = header.recipients[slot]
    if (!r || typeof r.iv !== 'string' || typeof r.w !== 'string') continue
    try {
      const cek = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(r.iv) }, wk, ub64(r.w)))
      const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(header.iv) }, cekKey, data))
    } catch {
      /* wrong key / tamper for this slot → try the next, else fail closed */
    }
  }
  return null
}

/** True if `h` is a v1 binary-envelope header (from sealBytes) — distinct from a string envelope (which carries `ct`). */
export function isBinHeader(h) {
  return !!(
    h && typeof h === 'object' && h.v === VERSION && h.alg === 'bin' && typeof h.iv === 'string' &&
    h.recipients && typeof h.recipients === 'object' && Object.values(h.recipients).some((r) => r && typeof r.iv === 'string' && typeof r.w === 'string')
  )
}

// ── Sealed box (PUBLIC-KEY) — for CONTRIBUTOR wishes ──────────────────────────────────────────────────────────────
// A friend seals a wish to the ORGANIZER's PUBLIC key (safe to share; encrypt-only); ONLY the organizer's PRIVATE key
// (recoverable from mk) opens it. Anonymous "sealed box" (like NaCl crypto_box_seal): a fresh EPHEMERAL ECDH-P256 key
// per message → HKDF → AES-256-GCM, the sender's ephemeral key DISCARDED — so a friend can't reopen their own wish OR
// read anyone else's; only the recipient can. The secret (mk / the private key) is NEVER shared with contributors.
// Wire-compatible with agent/envelope.mjs (same ECDH-P256 + HKDF("sealedbox") + AES-GCM + box shape).
const EC = { name: 'ECDH', namedCurve: 'P-256' }
async function boxKey(priv, pubJwk) {
  const privKey = priv && priv.kty ? await crypto.subtle.importKey('jwk', priv, EC, false, ['deriveBits']) : priv
  const pub = await crypto.subtle.importKey('jwk', pubJwk, EC, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256)
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('sealedbox') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
/** Generate a recipient (organizer) keypair → { publicJwk, privateJwk }. PUBLISH publicJwk (in the invite); wrap
 *  privateJwk to mk (sealBytes) + store it, so ONLY mk-holders (the organizer + the agent) recover the private key. */
export async function genRecipientKey() {
  const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits'])
  return { publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) }
}
/** Seal a string to a recipient PUBLIC key (jwk) → an anonymous sealed box. Encrypt-only: no private key is used here. */
export async function sealTo(plaintext, recipientPublicJwk) {
  if (!recipientPublicJwk) throw new Error('sealTo needs the recipient public key')
  const eph = await crypto.subtle.generateKey(EC, true, ['deriveBits'])
  const key = await boxKey(eph.privateKey, recipientPublicJwk)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plaintext))))
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey)
  return { v: VERSION, alg: 'box', epk: { x: epk.x, y: epk.y }, iv: b64(iv), ct: b64(ct) }
}
/** Open a sealed box with the recipient PRIVATE key (jwk) → plaintext string, or null on wrong key / tamper / malformed. */
export async function openBox(box, recipientPrivateJwk) {
  if (!isBox(box) || !recipientPrivateJwk) return null
  try {
    const key = await boxKey(recipientPrivateJwk, { kty: 'EC', crv: 'P-256', x: box.epk.x, y: box.epk.y })
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(box.iv) }, key, ub64(box.ct)))
    return dec.decode(pt)
  } catch {
    return null
  }
}
/** True if a stored value is a v1 sealed box (public-key), vs a symmetric envelope / bin header. */
export function isBox(o) {
  return !!(o && typeof o === 'object' && o.v === VERSION && o.alg === 'box' && o.epk && typeof o.epk.x === 'string' && typeof o.iv === 'string' && typeof o.ct === 'string')
}

// ── The collection blob — content-blind append + owner peel (docs/e2ee-collection-blob.md) ────────────────────────
// The collection is ONE opaque blob: an append-only LIST of sealed boxes. Each contributor sealTo's their item to the
// owner's PUBLIC key; the SERVER just appends that opaque box to the list — it needs NO key, never decrypts, and the
// append is a single atomic DynamoDB list_append (no read-modify-write, no version). One row → the item COUNT is not
// listable ambiently (Part B, docs/trust-model.md). LINEAR in size (unlike onion nesting, which is exponential in
// base64 and unbounded without an online mk-holder to compact — see nestAppend below). Only the owner's PRIVATE key
// (from mk) opens the boxes. Wire-compatible Node ⇄ browser.
/** True if a value is a collection blob (an append-only list of sealed boxes). Accepts the raw DynamoDB shape too. */
export function isBoxList(o) { return !!(o && typeof o === 'object' && Array.isArray(o.boxes)) }
/** A stable, opaque id for a box — a prefix of its ciphertext (unique per box: fresh IV + ephemeral key). Sync, needs
 *  NO key, so the console and the agent derive the SAME id to key moderation decisions (leave-out) without decrypting. */
export function boxId(box) { return String((box && box.ct) || '').slice(0, 40) }
/** Append one contributor box to the blob (immutable — returns a new blob). No key needed; the box is already sealed. */
export function appendBox(blob, box) {
  const boxes = isBoxList(blob) ? blob.boxes : []
  return { v: VERSION, alg: 'boxlist', boxes: [...boxes, box] }
}
/** Owner/agent read: open every box with the PRIVATE key → items. Handles the boxlist blob AND a bounded onion (below).
 *  Fail-closed per box (a box that won't open is skipped for the list; the onion stops). */
export async function peelAll(blob, ownerPrivateJwk) {
  if (isBoxList(blob)) { // the collection-blob form (also the raw DynamoDB { boxes:[...] } item)
    const out = []
    for (const b of blob.boxes) { const item = await openBox(b, ownerPrivateJwk); if (item != null) out.push(item) }
    return out
  }
  const out = [] // bounded onion form (nestAppend) — newest-first
  let cur = blob
  while (cur && isBox(cur)) {
    const layer = await openBox(cur, ownerPrivateJwk)
    if (layer == null) break // can't open this layer → stop (fail-closed)
    let parsed
    try { parsed = JSON.parse(layer) } catch (e) { break }
    if (parsed && parsed.inner) { const item = await openBox(parsed.inner, ownerPrivateJwk); if (item != null) out.push(item) }
    cur = parsed && parsed.prev ? parsed.prev : null
  }
  return out
}
/** BOUNDED-USE onion append: wrap { box, prev } in a fresh layer to the PUBLIC key. WARNING: size is EXPONENTIAL in the
 *  number of appends (each layer re-base64s the whole blob) — use ONLY for a small, bounded count (e.g. a compaction of
 *  ≤K items). The async collection uses appendBox (linear) instead. Kept for bounded nesting; peelAll reads both. */
export async function nestAppend(oldBlob, contributorBox, ownerPublicJwk) {
  return sealTo(JSON.stringify({ inner: contributorBox, prev: oldBlob || null }), ownerPublicJwk)
}

// ── The collection keypair — minted at create, PUBLIC published, PRIVATE wrapped to mk ────────────────────────────
// The owner's read key is `mk` (never shared). At create the organizer mints a recipient keypair: the PUBLIC jwk is
// published on the gift record (contributors seal their boxes to it — encrypt-only, safe to expose); the PRIVATE jwk
// is symmetric-sealed to `mk` and stored as an opaque envelope. Anyone holding `mk` (organizer console, or the agent
// at call time) unwraps it to peel the blob. The server stores only the public jwk + the wrapped (opaque) private key.
/** Mint a collection keypair → { publicJwk (publish), wrapped (store; the private jwk sealed to mk) }. */
export async function sealRecipientKey(mk) {
  if (!mk) throw new Error('sealRecipientKey needs mk')
  const { publicJwk, privateJwk } = await genRecipientKey()
  const wrapped = await seal(JSON.stringify(privateJwk), { room: mk })
  return { publicJwk, wrapped }
}
/** Unwrap the private jwk from its mk-sealed envelope → privateJwk, or null (fail-closed on wrong mk / tamper). */
export async function openRecipientKey(mk, wrapped) {
  if (!mk || !isEnvelope(wrapped)) return null
  const s = await open(wrapped, { mk })
  if (s == null) return null
  try { return JSON.parse(s) } catch (e) { return null }
}
