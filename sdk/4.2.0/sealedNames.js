// sealedNames.js — OPAQUE NAMES for a protected device's stores (docs/desktop-protection.md, phase 2; the owner, 2026-10-11:
// "Some metadata stays readable — why?"). Sealing a VALUE under its own name still told a disk copy which rooms this device
// holds (`space:mk:<room>`, idb `chat:<room>`) and every reviewed-clear flag around them. On a protected device every entry is
// stored under `p:` + an encryption of its real name instead.
//
// The name is encrypted DETERMINISTICALLY (a synthetic IV: the AES-GCM nonce is HMAC(name), as in SIV), so the page finds an
// entry by computing its stored name, and a listing recovers every real name by decrypting the KEYS alone — no value is read
// (reading every value at unlock is what once killed the page on an iPhone, idb.js § A PREFIX READ). Equal names give equal
// stored names; that is all a disk copy learns: how many entries there are, and their sizes.
//
// Both keys come from the device key's raw bytes by HKDF with their own labels — never the value-sealing key itself.
const enc = new TextEncoder(), dec = new TextDecoder()
const SALT = enc.encode('witbitz-sealed-names')
export const NAME_PREFIX = 'p:'
export const isOpaqueName = (k) => typeof k === 'string' && k.startsWith(NAME_PREFIX)

const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error('no WebCrypto'); return s }
const toB64u = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const fromB64u = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const bytes = (x) => (x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : Array.isArray(x) ? Uint8Array.from(x) : null)

/** The two name keys from the device key's 32 raw bytes. */
export async function nameKeys (raw) {
  const r = bytes(raw); if (!r || r.length < 16) throw new Error('bad device key')
  const base = await subtle().importKey('raw', r, 'HKDF', false, ['deriveKey'])
  const hk = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) })
  const mac = await subtle().deriveKey(hk('witbitz-names-v1-mac'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const aes = await subtle().deriveKey(hk('witbitz-names-v1-enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return { mac, aes }
}

async function ivFor (keys, name) { return new Uint8Array(await subtle().sign('HMAC', keys.mac, enc.encode(name))).slice(0, 12) }

/** The stored name for a real name. */
export async function opaqueName (keys, name) {
  const iv = await ivFor(keys, String(name))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, keys.aes, enc.encode(String(name))))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return NAME_PREFIX + toB64u(out)
}

/** The real name behind a stored name, or null (not ours, another key, or damaged). */
export async function realName (keys, stored) {
  if (!isOpaqueName(stored)) return null
  try {
    const all = fromB64u(stored.slice(NAME_PREFIX.length)); if (all.length < 29) return null
    const iv = all.slice(0, 12)
    const name = dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv }, keys.aes, all.slice(12)))
    const want = await ivFor(keys, name) // the IV IS the name's MAC: a stored name made by another key, or edited, fails here
    for (let i = 0; i < 12; i++) if (want[i] !== iv[i]) return null
    return name
  } catch { return null }
}

/** A cached namer over one device key: opaque(name) and real(stored), both memoised (names repeat on every write). */
export async function makeNamer (raw) {
  const keys = await nameKeys(raw)
  const fwd = new Map(), back = new Map()
  return {
    async opaque (name) { const n = String(name); let o = fwd.get(n); if (!o) { o = await opaqueName(keys, n); fwd.set(n, o); back.set(o, n) } return o },
    async real (stored) { if (back.has(stored)) return back.get(stored); const n = await realName(keys, stored); if (n != null) { back.set(stored, n); fwd.set(n, stored) } return n },
    known (name) { return fwd.get(String(name)) || null }, // synchronous: the stored name if computed before
  }
}
