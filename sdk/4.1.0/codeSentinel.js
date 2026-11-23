// codeSentinel.js — what the page and the Credential Sentinel must agree on byte for byte (docs/credential-sentinel.md §9).
// One file, imported by both: the page (browser WebCrypto) and the Sentinel enclave (Node's WebCrypto).
//
//   keys      a cloud computer's `grantKey` (32 bytes, kept in the account) → the approve key and the log key, by HKDF.
//             The page hands both to the Sentinel inside the sealed grant; the agent's VM never holds either.
//   asks      a request the Sentinel holds for the person carries a tag (HMAC, approve key) over what it is, so the page
//             shows only asks the Sentinel really made — the agent, which relays them, cannot invent or relabel one.
//             The person's answer carries a tag too, so the agent cannot answer for them.
//   the log   one sealed entry per call, AES-GCM under the log key, each naming the hash of the entry before it; stored
//             through the host, which can hold entries back but cannot read, change or reorder them unnoticed.

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s) }
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
const subtle = globalThis.crypto.subtle

async function hkdf(rootB64, info) {
  const k = await subtle.importKey('raw', unb64(rootB64), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, k, 256))
}

/** grantKey (base64, 32 bytes) → { approve, log } (base64). */
export async function sentinelKeys(grantKeyB64) {
  return { approve: b64(await hkdf(grantKeyB64, 'witbitz-sentinel approve v1')), log: b64(await hkdf(grantKeyB64, 'witbitz-sentinel log v1')) }
}

/** Canonical JSON (sorted keys) — what a tag signs. */
export function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']'
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
}

async function hmac(keyB64, text) {
  const k = await subtle.importKey('raw', unb64(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await subtle.sign('HMAC', k, enc.encode(text))))
}
const same = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 }

/** An ask's tag: over its id, when it expires and what it is. */
export const askTag = (approveB64, ask) => hmac(approveB64, 'ask\n' + canon({ id: ask.id, expires: ask.expires, summary: ask.summary }))
export const askGenuine = async (approveB64, ask) => same(await askTag(approveB64, ask), ask.tag)
/** The person's answer to one ask. */
export const decideTag = (approveB64, id, allow) => hmac(approveB64, `decide\n${id}\n${allow ? 'allow' : 'deny'}`)
export const decideGenuine = async (approveB64, id, allow, tag) => same(await decideTag(approveB64, id, allow), tag)

// ── the log ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const aadOf = (workspace, grantId, seq) => enc.encode(`witbitz-sentinel log v1\n${workspace}\n${grantId}\n${seq}`)
export const logName = (grantId, seq) => `log-${grantId}-${String(seq).padStart(8, '0')}`

/** Seal entry `seq` of a grant's log. `prev`: the hash of entry seq-1 ('' for the first). → { name, blob, hash } */
export async function sealLogEntry({ logKey, workspace, grantId, seq, prev = '', at = Date.now(), entry }) {
  const key = await subtle.importKey('raw', unb64(logKey), 'AES-GCM', false, ['encrypt'])
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(workspace, grantId, seq) }, key, enc.encode(JSON.stringify({ seq, prev, at, entry }))))
  const blob = new Uint8Array(12 + ct.length)
  blob.set(iv); blob.set(ct, 12)
  return { name: logName(grantId, seq), blob, hash: hex(new Uint8Array(await subtle.digest('SHA-256', blob))) }
}

/**
 * Open a grant's log and check it is whole: every entry opens, the numbers run 0,1,2… with no gap, and each names the
 * hash of the one before. → { entries: [{ seq, at, entry }], ok, problem? }. An entry the host held back at the END cannot
 * be told from one never written; the page compares with what it saw live.
 */
export async function openLog({ logKey, workspace, grantId, blobs }) {
  const key = await subtle.importKey('raw', unb64(logKey), 'AES-GCM', false, ['decrypt'])
  const sorted = [...blobs].filter((b) => b.name.startsWith(`log-${grantId}-`)).sort((a, b) => (a.name < b.name ? -1 : 1))
  const entries = []
  let prevHash = ''
  for (let i = 0; i < sorted.length; i++) {
    const blob = sorted[i].blob instanceof Uint8Array ? sorted[i].blob : unb64(sorted[i].blob)
    if (sorted[i].name !== logName(grantId, i)) return { entries, ok: false, problem: `entry ${i} is missing` }
    let rec
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12), additionalData: aadOf(workspace, grantId, i) }, key, blob.slice(12))
      rec = JSON.parse(dec.decode(pt))
    } catch { return { entries, ok: false, problem: `entry ${i} does not open — changed, or not this grant's` } }
    if (rec.seq !== i || rec.prev !== prevHash) return { entries, ok: false, problem: `entry ${i} does not follow entry ${i - 1}` }
    entries.push({ seq: rec.seq, at: rec.at, entry: rec.entry })
    prevHash = hex(new Uint8Array(await subtle.digest('SHA-256', blob)))
  }
  return { entries, ok: true }
}
