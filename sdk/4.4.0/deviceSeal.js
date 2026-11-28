// deviceSeal.js — DEVICE STORAGE PROTECTION, the primitive (docs/device-storage-protection.md). A key the authenticator
// derives (spacePasskey.js: PRF or largeBlob → a 32-byte device secret) becomes an AES-GCM key that is NOWHERE on disk;
// every secret and every cached message the device keeps is written through `seal()` and read through `open()`. Works in
// the key worker and on the page alike: no DOM, no storage of its own — the callers decide where a sealed blob lives.
//
//   deriveSealKey(secret)   HKDF-SHA256(secret, info 'witbitz-device-seal-v1') → a non-extractable AES-GCM-256 key. A
//                           DIFFERENT derivation from the backup recovery key the same passkey secret feeds (recovery.js),
//                           so a local store and a backup never share a key.
//   seal(key, value)        → { v: 1, s: base64(iv ‖ ciphertext) } — value is any JSON-able thing; a fresh 12-byte iv each time.
//   open(key, blob)         → the value; THROWS on a wrong key or a tampered blob (never a silent null: a reader that
//                           cannot open must show the lock, not an empty room).
//   isSealed(x)             → true for a blob this module wrote (so a store can hold clear and sealed entries during migration).
//   exportRaw / importRaw   move a key between realms (page → worker) as 32 raw bytes over postMessage; the raw bytes never
//                           touch storage. The CryptoKey itself is non-extractable once imported, so a realm that only
//                           opens and seals cannot read the key back out.
const enc = new TextEncoder(), dec = new TextDecoder()
const INFO = enc.encode('witbitz-device-seal-v1')
const SALT = enc.encode('witbitz-device-seal') // a fixed HKDF salt: the secret already carries the per-credential entropy
export const SEAL_V = 1

const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error('no WebCrypto'); return s }
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
const fromB64 = (s) => { const b = atob(String(s)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const bytes = (x) => (x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : Array.isArray(x) ? Uint8Array.from(x) : null)

/** The 32 raw key bytes from a device secret — what travels page → worker. Deterministic for one secret. */
export async function deriveSealRaw (secret) {
  const s = bytes(secret); if (!s || s.length < 16) throw new Error('device secret too short')
  const ikm = await subtle().importKey('raw', s, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO }, ikm, 256))
}
/** A non-extractable AES-GCM key from the raw bytes (or straight from the secret). */
export async function importRaw (raw) {
  const r = bytes(raw); if (!r || r.length !== 32) throw new Error('seal key must be 32 bytes')
  return subtle().importKey('raw', r, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
export async function deriveSealKey (secret) { return importRaw(await deriveSealRaw(secret)) }

export async function seal (key, value) {
  if (!key) throw new Error('no seal key')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value === undefined ? null : value))))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv, 0); out.set(ct, iv.length)
  return { v: SEAL_V, s: b64(out) }
}
export async function open (key, blob) {
  if (!key) throw new Error('no seal key')
  if (!isSealed(blob)) throw new Error('not a sealed blob')
  const all = fromB64(blob.s)
  if (all.length < 12 + 16) throw new Error('sealed blob too short')
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12)) // a wrong key or a tampered blob throws here
  return JSON.parse(dec.decode(pt))
}
export const isSealed = (x) => !!(x && typeof x === 'object' && !Array.isArray(x) && x.v === SEAL_V && typeof x.s === 'string' && x.s.length > 0)

/** Seal when a key is present, else store in the clear — the shape every protected store uses while the switch may be off. */
export const sealIf = async (key, value) => (key ? seal(key, value) : value)
/** Open a stored value: a sealed blob needs the key (throws without it, as `open` does); a clear value passes through. */
export const openIf = async (key, stored) => (isSealed(stored) ? open(key, stored) : stored)
