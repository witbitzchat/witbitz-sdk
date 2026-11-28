// 2-of-2 async handshake — seal one share under the couple's shared CODE (docs: the async code-sealed exchange).
// The creator seals shareA under a key derived from a short code (PBKDF2) and registers the ciphertext ("invite") with
// the room. The partner, holding their OWN share-link + the code (both out of band), fetches the invite, unseals shareA,
// and combines → mk. Neither factor alone opens the room: a leaked link is one bare share; the code alone unseals only
// shareA (still needs the other share). The server only ever holds ciphertext under a code it doesn't have.
const enc = new TextEncoder()
const dec = new TextDecoder()

// A short, human-shareable code — 4 groups so it reads like "7K2P-9QF3-…". Ambiguous chars dropped.
export function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1
  const r = crypto.getRandomValues(new Uint8Array(12))
  const s = [].slice.call(r).map((x) => A[x % A.length]).join('')
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12)
}

const normCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') // forgiving: case + dashes/spaces

async function keyFromCode(code, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, // slow: the code is low-entropy, so make guessing costly
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const ub64 = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a }

/** Seal a short string under the code → an opaque base64 blob ( salt16 ‖ iv12 ‖ ciphertext ). */
export async function sealUnderCode(plaintext, code) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFromCode(code, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plaintext))))
  const out = new Uint8Array(16 + 12 + ct.length)
  out.set(salt); out.set(iv, 16); out.set(ct, 28)
  return b64(out)
}

/** Open a code-sealed blob → the string, or null on a wrong code / tamper (never throws). */
export async function openUnderCode(blob, code) {
  try {
    const raw = ub64(blob)
    const key = await keyFromCode(code, raw.slice(0, 16))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, key, raw.slice(28))
    return dec.decode(pt)
  } catch {
    return null
  }
}
