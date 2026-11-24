// Per-member identity for async Spaces — the BROWSER counterpart of agent/spaceEntrySig.mjs, and byte-compatible
// with it (and with the Kibitz room link's inviteToken). The member holds an ECDSA signing keypair; their GRANT is a
// Kibitz invite token, payload superset `{name, room, exp, spk}`, signed by the ROOM invite key and verified against
// the public `gk` in the link. Each async ledger turn is SIGNED with the member key; the server (or any reader)
// checks `grant → (name, spk)` then `entry → spk`. This file signs turns client-side; agent/spaceEntrySig.mjs verifies
// them server-side in the decrypt-once render. The two MUST stay in lockstep — the interop test cross-verifies them.
//
// Standalone (no dependency on e2ee.js): base64url via btoa/atob, ECDSA-P256-SHA256 via crypto.subtle — identical
// bytes to the server's Buffer.base64url + crypto.subtle path.

const enc = new TextEncoder()
const dec = new TextDecoder()
const toB64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64 = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGN = { name: 'ECDSA', hash: 'SHA-256' }
const importPriv = (jwk) => crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign'])
const importPub = (jwk) => crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['verify'])

// Canonical (sorted-key) JSON — identical to agent/spaceEntrySig.mjs + bridgeLog so the signed form matches.
function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o)
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']'
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}'
}

/** A fresh ECDSA P-256 keypair (JWK). Doubles as the ROOM invite keypair and a MEMBER signing keypair. */
export async function genKeypair() {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  return { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) }
}

/** Mint a member GRANT (Kibitz invite token, payload `{name,room,exp,spk,caps?}`) — signed by the ROOM invite private
 *  key. `caps` (spaceCaps.Grant) is OPTIONAL; omit it and the token is byte-identical to the pre-caps grant. `caps`
 *  is LAST so the byte order matches the server twin (agent/spaceEntrySig.mjs) — the interop test asserts it. */
export async function mintGrant(roomInvitePrivJwk, { name, room, exp, spk, caps }) {
  const body = toB64(enc.encode(JSON.stringify({ name, room, exp, spk, caps })))
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, await importPriv(roomInvitePrivJwk), enc.encode(body)))
  return `${body}.${toB64(sig)}`
}

/** Verify a grant against the room invite PUBLIC key (`gk`) + room + expiry. `now`/`exp` are epoch SECONDS. */
export async function verifyGrant(token, roomInvitePubJwk, { room, now } = {}) {
  const t = String(token)
  const dot = t.indexOf('.')
  if (dot < 1 || dot === t.length - 1) return { ok: false, reason: 'malformed' }
  let payload
  let sig
  try {
    sig = fromB64(t.slice(dot + 1))
    payload = JSON.parse(dec.decode(fromB64(t.slice(0, dot))))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const valid = await crypto.subtle.verify(SIGN, await importPub(roomInvitePubJwk), sig, enc.encode(t.slice(0, dot))).catch(() => false)
  if (!valid) return { ok: false, reason: 'bad signature' }
  if (payload.room !== room) return { ok: false, reason: 'wrong room' }
  if (typeof payload.exp !== 'number' || now >= payload.exp) return { ok: false, reason: 'expired' }
  if (!payload.name || !payload.spk) return { ok: false, reason: 'incomplete' }
  return { ok: true, name: payload.name, spk: payload.spk, ...(payload.caps !== undefined ? { caps: payload.caps } : {}) }
}

// `chal` (a server-issued challenge) is folded in only when present, so the entry signature also commits to the fresh
// challenge (the async presence proof). Omitted ⇒ byte-identical to a pre-challenge signature. MUST match the server
// twin (agent/spaceEntrySig.mjs) — the interop test asserts it.
const entryCore = (e) => ({ room: e.room, author: e.author, ts: e.ts, kind: e.kind, id: e.id, text: e.text, ...(e.chal !== undefined ? { chal: e.chal } : {}) })

/** Sign a ledger entry with the member's signing PRIVATE key → the entry with `sig` set. */
export async function signEntry(memberPrivJwk, entry) {
  const sig = toB64(new Uint8Array(await crypto.subtle.sign(SIGN, await importPriv(memberPrivJwk), enc.encode(canon(entryCore(entry))))))
  return { ...entry, sig }
}

/** Sign an arbitrary canonical assertion with a signing PRIVATE key (ECDSA-P256-SHA256) → base64url signature. Used by
 *  the email-code SESSION REFRESH to prove possession of the key a token is bound to (api/email/refresh verifies it). */
export async function signAssertion(privJwk, obj) {
  return toB64(new Uint8Array(await crypto.subtle.sign(SIGN, await importPriv(privJwk), enc.encode(canon(obj)))))
}

/** Verify an entry's signature against a signing PUBLIC key (`spk`). */
export async function verifyEntry(entry, signPubJwk) {
  if (!entry || !entry.sig) return false
  return crypto.subtle.verify(SIGN, await importPub(signPubJwk), fromB64(entry.sig), enc.encode(canon(entryCore(entry)))).catch(() => false)
}

/** The OIDC nonce that binds a Google ID token to this member's signing key: base64url(SHA-256(canonical-JWK(spk))).
 *  Pass it as the `nonce` to Google Identity Services; the server (agent/spaceOidc.mjs spkNonce) recomputes it from the
 *  spk the turn carries and requires equality — so a Google token can't be replayed onto a different key. MUST match
 *  the server byte-for-byte (the interop test asserts it). */
export async function spkNonce(spk) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(canon(spk)))
  return toB64(new Uint8Array(h))
}

/** The reader/agent check: grant valid → (name, spk); entry claims that name; entry signed by spk. */
export async function attribute(entry, grant, roomInvitePubJwk, { room, now } = {}) {
  const g = await verifyGrant(grant, roomInvitePubJwk, { room, now })
  if (!g.ok) return { ok: false, reason: `grant: ${g.reason}` }
  if (entry.author !== g.name) return { ok: false, reason: 'author mismatch' }
  if (!(await verifyEntry(entry, g.spk))) return { ok: false, reason: 'bad entry signature' }
  // `spk` rides back so the caller can persist it on the entry → the room ROSTER (name→spk) is derivable from the
  // ledger (needed to seal a membership-fork pointer to each keeper — docs/spaces-membership-fork.md, P0).
  return { ok: true, name: g.name, spk: g.spk, ...(g.caps !== undefined ? { caps: g.caps } : {}) }
}

// ── link carry (Kibitz `g*` grammar) ───────────────────────────────────────────────────────────────
// A JWK rides the link base64url-json (as Kibitz encodes `gk`). PUBLIC bits (`gk`) and the bearer grant (`gt`) plus
// the member's PRIVATE signing key (`sk`) ALL ride the FRAGMENT (never sent to the server), appended after the room's
// existing fragment — so this composes with the spaces link grammar without changing it.
const encJwk = (jwk) => toB64(enc.encode(JSON.stringify(jwk)))
const decJwk = (s) => { try { return JSON.parse(dec.decode(fromB64(s))) } catch { return null } }

/** Append a member's identity params to a link's FRAGMENT: `gk` (room invite pubkey), `gt` (grant), `sk` (member
 *  signing PRIVATE key). Returns the extended link. Fragment-only → the server never sees any of it. */
export function appendIdentity(link, { gk, gt, sk } = {}) {
  const parts = []
  if (gk) parts.push('gk=' + encJwk(gk))
  if (gt) parts.push('gt=' + encodeURIComponent(gt))
  if (sk) parts.push('sk=' + encJwk(sk))
  if (!parts.length) return link
  const hashAt = link.indexOf('#')
  const sep = hashAt < 0 ? '#' : link.indexOf('?', hashAt) >= 0 ? '&' : '?'
  return link + sep + parts.join('&')
}

/** The `name` a grant CLAIMS, decoded without verifying (for a display label; attribution still verifies in §4). */
export function grantName(token) {
  try {
    return JSON.parse(dec.decode(fromB64(String(token).split('.')[0]))).name || null
  } catch {
    return null
  }
}

/** The signing key a grant BINDS (`spk`), decoded without verifying — the key the server attributes a grant turn to, so the
 *  one an attested room's assertion must be bound to (deviceAttest bindHash). Null for anything unreadable. */
export function grantSpk(token) {
  try {
    return JSON.parse(dec.decode(fromB64(String(token).split('.')[0]))).spk || null
  } catch {
    return null
  }
}

/** Read `{ gk, gt, sk }` from a link/hash fragment (whatever's present). `gk`/`sk` come back as JWKs. */
export function readIdentity(hashOrLink = '') {
  const h = String(hashOrLink)
  const frag = h.slice(h.indexOf('#') + 1)
  const q = frag.indexOf('?')
  const params = new URLSearchParams(q >= 0 ? frag.slice(q + 1) : '')
  const gk = params.get('gk')
  const gt = params.get('gt')
  const sk = params.get('sk')
  return { gk: gk ? decJwk(gk) : null, gt: gt || null, sk: sk ? decJwk(sk) : null }
}
