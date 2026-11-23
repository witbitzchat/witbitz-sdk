// spaces/public/ownerPolicy.js — CLIENT-side peer verification of the owner rule (docs/the-owner-rule.md).
//
// The render enforces the owner policy server-side; this is the peer half: the OWNER'S APP verifies a room's policy
// independently, against an owner key it PINS itself (baked into the app / a well-known URL) — so it never takes the
// server's word for who governs a room, and won't join one whose policy is missing, swapped, or foreign. It also
// resolves the local member's tier for the UI. Wire-compatible with agent/ownerPolicy.mjs: ECDSA P-256 / SHA-256 over
// the SAME canonical (sorted-key) JSON, so a policy the server signs verifies here byte-for-byte, and vice-versa.
//
// Isomorphic (browser + node): uses global crypto.subtle / TextEncoder / btoa / atob only. No bundler, no deps.
const enc = new TextEncoder()
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: 'SHA-256' }

const bytesToB64u = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const b64uToBytes = (str) => { const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }

// Canonical sorted-key JSON — MUST match agent/ownerPolicy.mjs canon (and spaceEntrySig) so signatures interoperate.
function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']'
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
}
const sha256b64u = async (s) => bytesToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
const sameKey = (a, b) => !!a && !!b && canon({ kty: a.kty, crv: a.crv, x: a.x, y: a.y }) === canon({ kty: b.kty, crv: b.crv, x: b.x, y: b.y })

// SIGNING (B8, docs/tenant-releases.md): a builder's SERVER signs its rooms' policy and genesis with its owner key
// (WitbitzAdmin.owner) — the same bytes agent/ownerPolicy.mjs signs and checks. Never in a page: the private key is the app's.
export async function signPolicy(policy, ownerPrivJwk) {
  const key = await crypto.subtle.importKey('jwk', ownerPrivJwk, ECDSA, false, ['sign'])
  return { policy, sig: bytesToB64u(new Uint8Array(await crypto.subtle.sign(SIGN, key, enc.encode(canon(policy))))) }
}
export async function signRoomAuth(room, app, ownerPrivJwk) {
  const key = await crypto.subtle.importKey('jwk', ownerPrivJwk, ECDSA, false, ['sign'])
  const core = canon({ app: String(app), room: String(room) })
  return { room: String(room), app: String(app), sig: bytesToB64u(new Uint8Array(await crypto.subtle.sign(SIGN, key, enc.encode(core)))) }
}

export async function ownerKeyId(jwk) { return (await sha256b64u(canon({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }))).slice(0, 22) }
export async function policyHash(policy) { return sha256b64u(canon(policy)) }

export async function verifyPolicy(signed, { ownerKey = null, now = Date.now() } = {}) {
  const policy = signed && typeof signed === 'object' ? signed.policy : null
  if (!policy || typeof policy !== 'object' || typeof signed.sig !== 'string') return { ok: false, reason: 'malformed' }
  const declared = policy.ownerKey
  if (!declared || typeof declared !== 'object') return { ok: false, reason: 'no_owner_key' }
  if (ownerKey && !sameKey(declared, ownerKey)) return { ok: false, reason: 'owner_mismatch' }
  let valid = false
  try { valid = await crypto.subtle.verify(SIGN, await crypto.subtle.importKey('jwk', ownerKey || declared, ECDSA, false, ['verify']), b64uToBytes(signed.sig), enc.encode(canon(policy))) } catch { valid = false }
  if (!valid) return { ok: false, reason: 'bad_sig' }
  const nowSec = Math.floor(now / 1000)
  if (typeof policy.notBefore === 'number' && nowSec < policy.notBefore) return { ok: false, reason: 'not_yet_valid' }
  if (typeof policy.notAfter === 'number' && nowSec >= policy.notAfter) return { ok: false, reason: 'expired' }
  return { ok: true, policy }
}

/** The peer check: the room's cleartext `marker` and its `sealed` signed policy (the app opens it with mk) must agree
 *  and verify against the app's PINNED `ownerKey`. Returns { ok, governed, policy?, reason? }. Refuse to join on !ok. */
export async function verifyRoomPolicy({ marker = null, sealed = null, ownerKey = null, required = false, now = Date.now() } = {}) {
  if (!marker) return required ? { ok: false, governed: true, reason: 'policy_required' } : { ok: true, governed: false }
  if (!sealed || !sealed.policy) return { ok: false, governed: true, reason: 'policy_missing' }
  const v = await verifyPolicy(sealed, { ownerKey, now })
  if (!v.ok) return { ok: false, governed: true, reason: v.reason }
  if (String(v.policy.app || '') !== String(marker.app || '')) return { ok: false, governed: true, reason: 'app_mismatch' }
  if ((await policyHash(v.policy)) !== marker.policyHash) return { ok: false, governed: true, reason: 'hash_mismatch' }
  if ((await ownerKeyId(v.policy.ownerKey)) !== marker.ownerKeyId) return { ok: false, governed: true, reason: 'owner_mismatch' }
  return { ok: true, governed: true, policy: v.policy }
}

// Tier resolution for the UI — mirror of agent/ownerPolicy.mjs (so the app can show "you're on the gold tier").
export function qualifies(admit, { authenticated = false, issuer = null, claims = {} } = {}) {
  if (admit === 'anonymous' || (admit && admit.anonymous)) return true
  if (!admit || typeof admit !== 'object' || !admit.issuer) return false
  if (!authenticated || issuer !== admit.issuer) return false
  if (admit.any) return true
  if (admit.claim && typeof admit.claim === 'object') {
    return Object.entries(admit.claim).every(([k, val]) => {
      const c = claims && claims[k]
      if (Array.isArray(c)) return c.includes(val)
      if (k === 'group' && Array.isArray(claims && claims.groups)) return claims.groups.includes(val)
      return c === val
    })
  }
  return false
}

export function resolveTier(policy, { authenticated = false, issuer = null, claims = {}, roomTier = null } = {}) {
  const tiers = Array.isArray(policy && policy.tiers) ? policy.tiers : []
  if (!tiers.length) return { tier: null }
  const ceilingName = roomTier || (policy.roomTiers && policy.roomTiers.default) || tiers[tiers.length - 1].name
  const ceilingRank = Math.max(0, tiers.findIndex((t) => t.name === ceilingName))
  let best = -1
  for (let i = 0; i <= ceilingRank && i < tiers.length; i++) if (qualifies(tiers[i].admit, { authenticated, issuer, claims })) best = i
  return best < 0 ? { tier: null } : { tier: tiers[best].name, caps: tiers[best].caps || {}, limits: tiers[best].limits || null }
}

/**
 * The JOIN-flow peer check (docs/the-owner-rule.md): verify a room's governance against the app's PINNED owner key
 * before trusting it, instead of taking the server's word. Fetches the room's marker + sealed config (op:'policy'),
 * opens the config with mk to get the owner-signed policy, and verifies. Deps are injected so this stays self-contained:
 *   fetchPolicy(room) → { policy: marker, configSealed }   ·   openConfig(configSealed, mk) → the decrypted config
 * Returns { ok, governed, policy?, tier?, reason? }. No pinned key, or an ungoverned room ⇒ { ok:true, governed:false }.
 */
export async function verifyRoomGovernance({ room, mk, ownerKey = null, fetchPolicy, openConfig, member = null, now = Date.now() } = {}) {
  // fetchPolicy (op:'policy') returns { policy: marker, configSealed, ownerKey? }. A PINNED deployment passes its own
  // ownerKey (authoritative); otherwise fall back to the app's registry-resolved key the server hands back — enough to
  // enforce the owner's embed allow-list on the hosted multi-tenant PWA (the caller only BLOCKS entry when pinned).
  let marker = null, configSealed = null, key = ownerKey
  try { const r = (await fetchPolicy(room)) || {}; marker = r.policy; configSealed = r.configSealed; if (!key) key = r.ownerKey || null } catch { return { ok: false, governed: true, reason: 'fetch_failed' } }
  if (!marker) return { ok: true, governed: false } // ungoverned room
  if (!key) return { ok: true, governed: false } // governed but no key resolvable (registry off / unknown) ⇒ can't verify here
  let sealed = null
  try { const cfg = await openConfig(configSealed, mk); sealed = cfg && cfg.ownerPolicy } catch { /* undecodable ⇒ verifyRoomPolicy reports it */ }
  const rp = await verifyRoomPolicy({ marker, sealed, ownerKey: key, now })
  if (!rp.ok) return { ok: false, governed: true, reason: rp.reason }
  const tier = member ? resolveTier(rp.policy, { ...member }).tier : undefined
  return { ok: true, governed: true, policy: rp.policy, ...(tier ? { tier } : {}) }
}
