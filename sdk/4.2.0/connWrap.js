// connWrap.js — MOVE 3 of the Sentinel's per-account keys (docs/standing-sentinel.md § The two open pieces; owner, 2026-11-18:
// "Do it"). A connection the Sentinel still holds in the OLD form keeps its callKey beside its secret, so the Sentinel's data key
// opens it with no caller present. It is locked under the callKey the first time a caller brings that key — and a connection no
// room ever spends never meets one. So a device that holds the key presents it: the same proof and the same sealed key a call
// makes (agent/sentinelRelay.mjs credCall), over the wrap's own request, and the Sentinel locks it without calling the service.
// The callKey lives where it lives: the regular app's page, the hosted app's VAULT (it answers `proofOf` itself — vaultConnKeys.js
// connWrapProof — so the key never enters the frame), the SDK's store. Pure: WebCrypto only.
import { sealTo } from './sealShare.js'

/** The request a wrap's proof is over (custody.mjs WRAP_REQUEST): never one a call could make. */
export const WRAP_REQUEST = '{"wrap":1}'
const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))

/** The proof (HMAC(callKey, nonce ‖ "\n" ‖ sha256(request))) and the callKey sealed to the attested share key, for THIS wrap. */
export async function wrapProof({ callKey, nonce, key }) {
  const reqHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(WRAP_REQUEST)))
  const hk = await crypto.subtle.importKey('raw', unb64(callKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const msg = new Uint8Array([...enc.encode(String(nonce) + '\n'), ...reqHash])
  const [mac, keySealed] = await Promise.all([ // one hop each on WebKit, run together (webkit-webcrypto-await-per-call)
    crypto.subtle.sign('HMAC', hk, msg).then(b64),
    sealTo(key, crypto.getRandomValues(new Uint8Array(16)), { v: 1, callKey, nonce, reqHash: b64(reqHash) }),
  ])
  return { mac, keySealed }
}

/**
 * Lock every listed connection the Sentinel marks `locked: false` whose key can be reached here.
 * @param {object} o
 * @param {(body) => Promise<object>} o.post — the Space client's sentinel post ({ op:'sentinel', sentinel, ...auth })
 * @param {Array<{ id, locked? }>} o.list — credlist's connections (an older Sentinel marks none: nothing is asked)
 * @param {() => Promise<{ key: CryptoKey, spki?: Uint8Array }>} o.attest — the standing Sentinel, attested (connections.js)
 * @param {(id, nonce, key, spki) => Promise<{ mac, keySealed } | null>} o.proofOf — null: this device does not hold its key
 * → { locked, failed, skipped } — never throws for one connection.
 */
export async function lockConnections({ post, auth = {}, list, attest, proofOf }) {
  const out = { locked: 0, failed: 0, skipped: 0 }
  const todo = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === 'string' && c.locked === false)
  if (!todo.length) return out
  const att = await attest()
  for (const c of todo) {
    try {
      const n = await post({ op: 'sentinel', sentinel: { mode: 'crednonce' }, ...auth })
      if (!n || typeof n.nonce !== 'string') { out.failed++; continue }
      const p = await proofOf(c.id, n.nonce, att.key, att.spki)
      if (!p) { out.skipped++; continue }
      const r = await post({ op: 'sentinel', sentinel: { mode: 'credwrap', connection: c.id, nonce: n.nonce, mac: p.mac, request: WRAP_REQUEST, keySealed: p.keySealed }, ...auth })
      if (r && r.ok && r.locked) out.locked++; else out.failed++
    } catch { out.failed++ }
  }
  return out
}
