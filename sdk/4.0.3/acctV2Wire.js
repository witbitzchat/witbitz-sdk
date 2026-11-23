// acctV2Wire.js — the bytes of account recovery v2 on the CLIENT (docs/account-recovery-protocol.md § 5.2, § 5.4, § 8.4).
// The same formats the service verifies (control-plane/src/lib/acct/transcript.mjs); both sides are pinned to the protocol's
// § 13 vectors (spaces/test/acctV2Client.test.mjs), so a drift on either side fails a test. Browser and Node alike:
// WebCrypto only, no dependencies.

const enc = new TextEncoder()

/** RFC 8785 for the value types the protocol signs (strings, safe integers, booleans, null, arrays, plain objects). */
export function jcs(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('jcs: only safe integers are signed'); return String(v) }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']'
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return '{' + Object.keys(v).sort().map((k) => { if (v[k] === undefined) throw new Error('jcs: undefined at ' + k); return JSON.stringify(k) + ':' + jcs(v[k]) }).join(',') + '}'
  }
  throw new Error('jcs: unsupported value')
}

const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length } return o }
function framed(context, fields, obj) {
  for (const f of fields) if (!(f in obj)) throw new Error(`${context}: missing ${f}`)
  for (const k of Object.keys(obj)) if (!fields.includes(k)) throw new Error(`${context}: unexpected ${k}`)
  return concat(enc.encode(context), new Uint8Array([0]), enc.encode(jcs(obj)))
}

export const hexOf = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
export const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export const unb64u = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
export const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8))

/** § 5.2 — the operation transcript T. */
export const transcript = (o) => framed('witbitz-account-v1', ['op', 'acct', 'params', 'challenge', 'nonce', 'exp', 'pv', 'rg', 'ev', 'epoch'], o)

const enc3986 = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
/** § 5.4 — the canonical query string. */
export function canonicalQuery(q) {
  const pairs = []
  for (const [k, v] of Object.entries(q || {})) for (const one of (Array.isArray(v) ? v : [v])) pairs.push([enc3986(k), enc3986(one)])
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => k + '=' + v).join('&')
}

/** § 5.4 — the bytes a device signs for a request. */
export async function deviceRequestBytes({ method, path, query = '', body = new Uint8Array(0), ts, nonce }) {
  return framed('witbitz-device-v1', ['method', 'path', 'query', 'body_sha256', 'ts', 'nonce'],
    { method: String(method).toUpperCase(), path, query, body_sha256: hexOf(await sha256(body)), ts, nonce })
}

/** § 8.4 — the bytes the backup write key signs. */
export const writeProofBytes = (o) => framed('witbitz-backup-write-v1', ['acct', 'id', 'ver', 'digest', 'prev', 'rg', 'epoch', 'nonce', 'ts'], o)

/** WebCrypto signs ECDSA as raw r‖s (64 bytes); the service verifies DER. */
export function rawToDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.subarray(i); if (v[0] & 0x80) v = concat(new Uint8Array([0]), v); return concat(new Uint8Array([2, v.length]), v) }
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32, 64))
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s)
}
