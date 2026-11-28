// accountSeal.js — sealing an account's sync documents ON THE DEVICE, one implementation for the SDK's account index
// (sdkAccount.js) and the Spaces app's account stores (accountStores.js). A sealed doc is { v: 1, z, s }: the JSON, gzipped
// where the platform can, AES-GCM under a key derived from the account's backup master secret — which the server never
// holds. So the server stores and serves what it cannot read: the room list and every room key in it, the invite and Siri
// and A2A private keys, contacts, the calendar (docs/sdk-convergence.md § The account stores).
const enc = new TextEncoder(), dec = new TextDecoder()
export const ub64 = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
export const b64url = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export async function hkdf (secret, salt, info, len) {
  const km = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) }, km, len * 8))
}
const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
async function pipeThrough (bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()) }
export async function sealDoc (key, obj) {
  let bytes = enc.encode(JSON.stringify(obj)), z = false
  if (canZip) { bytes = await pipeThrough(bytes, new CompressionStream('gzip')); z = true }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const buf = new Uint8Array(12 + ct.length); buf.set(iv); buf.set(ct, 12)
  return { v: 1, z, s: b64url(buf) }
}
export async function openDoc (key, doc) {
  const buf = ub64(doc.s)
  let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12)))
  if (doc.z) bytes = await pipeThrough(bytes, new DecompressionStream('gzip'))
  return JSON.parse(dec.decode(bytes))
}
export const isSealedDoc = (d) => !!(d && typeof d === 'object' && typeof d.s === 'string' && d.v === 1)
/** The Spaces app's account-store key, from the backup master secret (32 bytes). Non-extractable; it can be handed to a
 *  worker (structured clone) but never read back out. */
export async function appStoreKey (master) {
  return crypto.subtle.importKey('raw', await hkdf(master, 'witbitz-account-stores-v1', 'seal', 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
/** A random device-held sealing key (the temp-room index: one device's list, so no account master is needed) as base64url,
 *  and its CryptoKey. It lives beside the pointer it seals for — never on the server. */
export const newRawKey = () => b64url(crypto.getRandomValues(new Uint8Array(32)))
const _rawKeys = new Map()
export function rawSealKey (b64) {
  if (!_rawKeys.has(b64)) _rawKeys.set(b64, crypto.subtle.importKey('raw', ub64(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']))
  return _rawKeys.get(b64)
}
