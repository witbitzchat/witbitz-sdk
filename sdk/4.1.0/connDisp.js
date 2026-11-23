// connDisp.js — A CONNECTION'S LABEL, SEALED TO THE PERSON'S OWN DEVICES (Sentinel step 2; docs/standing-sentinel.md § Step 2;
// the owner, 2026-11-07: "Yes"). The standing Sentinel keeps what it must act on (the secret, the host, the limits) and, until
// now, also what it only SHOWS back: the name the person gave a connection. Now every grant also carries `disp` — that name
// sealed under a key only the account's devices derive, which the Sentinel stores and hands back on credlist but cannot open.
// Once every record carries one, the Sentinel stops keeping the readable label (its own later image).
//
// THE KEY: AES-256-GCM from the account's backup master — HKDF(master, salt "witbitz-sentinel-display-v1", info
// "sentinel-display"), the same on every device of the account, as the erase key is (sdkErase.js eraseKeyOf). SYMMETRIC on
// purpose: only the person's devices seal and open these. (The design's P-256 "display box" is for step 2's other part — the
// Sentinel sealing delivered A2A history TO the person — and gets its own key when that is built; a browser cannot derive a
// P-256 pair deterministically from a secret.)
//
// THE FORMAT: "d1." + b64url(iv) + "." + b64url(ciphertext), AAD = "witbitz-disp v1\n" + the connection's id — a sealed name
// opens only on the record it was made for (the Sentinel cannot move one onto another connection). Inside: { v: 1, label }.
// Pure: no storage, no DOM — the app, the hosted vault and the SDK all use it.

const enc = new TextEncoder(), dec = new TextDecoder()
const SALT = enc.encode('witbitz-sentinel-display-v1'), INFO = enc.encode('sentinel-display')
const PREFIX = 'd1.'
export const DISP_MAX = 8192 // the Sentinel's limit (custody.mjs)

const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64 = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const p = t + '='.repeat((4 - (t.length % 4)) % 4); const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
const bytesOf = (m) => (m instanceof Uint8Array ? m : (typeof m === 'string' && m ? ub64(m) : null))
const aadOf = (id) => enc.encode('witbitz-disp v1\n' + String(id || ''))

/** The 32 raw bytes of the display key, from the backup master (Uint8Array, or base64 / base64url text). null without one. */
export async function dispRawOf (master) {
  const m = bytesOf(master)
  if (!m || m.length < 16) return null
  const km = await crypto.subtle.importKey('raw', m, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO }, km, 256))
}

/** A non-extractable AES-GCM key from the raw bytes (what the hosted vault hands its frame). null for anything else. */
export async function dispKeyFromRaw (raw) {
  const r = bytesOf(raw)
  if (!r || r.length !== 32) return null
  return crypto.subtle.importKey('raw', r, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** The display key straight from the master. */
export async function dispKeyOf (master) { const raw = await dispRawOf(master); return raw ? dispKeyFromRaw(raw) : null }

/** Seal { label } for connection `id` → the `disp` string ('' when it cannot be made or would not fit). */
export async function sealDisp (key, id, { label = '' } = {}) {
  if (!key || !id) return ''
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(id) }, key, enc.encode(JSON.stringify({ v: 1, label: String(label || '').slice(0, 200) }))))
  const out = PREFIX + b64u(iv) + '.' + b64u(ct)
  return out.length <= DISP_MAX ? out : ''
}

/** Open a `disp` made for connection `id` → { label } or null (another account's key, another connection, tampered, unknown form). */
export async function openDisp (key, id, disp) {
  if (!key || !id || typeof disp !== 'string' || !disp.startsWith(PREFIX)) return null
  const parts = disp.slice(PREFIX.length).split('.')
  if (parts.length !== 2) return null
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(parts[0]), additionalData: aadOf(id) }, key, ub64(parts[1]))
    const o = JSON.parse(dec.decode(pt))
    return o && o.v === 1 && typeof o.label === 'string' ? { label: o.label } : null
  } catch { return null }
}

/** A credlist answer with each sealed name opened: `label` = the person's own name when its `disp` opens, else what the
 *  Sentinel holds (a record made before step 2, or by a sign-in the Sentinel finished). `disp` is left out of the result. */
export async function withDisplay (list, key) {
  if (!Array.isArray(list)) return []
  return Promise.all(list.map(async (c) => {
    if (!c || typeof c !== 'object') return c
    const { disp, ...rest } = c
    const o = key && disp ? await openDisp(key, c.id, disp) : null
    return o && o.label ? { ...rest, label: o.label, labelSealed: true } : rest
  }))
}
