// Tier-2 email-invite ENROLL (docs/spaces-email-invite.md). Runs once after email sign-in: mint (or reuse) a per-user
// invite identity — an ECDH "box" keypair + a random inbox id — derive THIS user's directory handle via the BLINDED
// OPRF (the email never leaves the device), and publish { boxPub, inbox } to the directory, authenticated by the login
// idToken (the server checks OPRF(email)==handle, so a slot can't be squatted). The box PRIVATE key is what opens
// invites sent to you; it is persisted AND backed up, so every device of yours shares ONE invite identity (restored via
// the recovery vault → an invite sealed to your boxPub opens on any of them, and they all poll the same inbox).
import { blind, finalize } from './oprf.js'

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randInbox = () => b64u(crypto.getRandomValues(new Uint8Array(18))) // 24-char base64url mailbox id (high-entropy)

// Resolve an email → its directory handle via the blinded OPRF round-trip. The email is blinded locally; the server
// only ever sees a uniform random point. Throws on a bad DLEQ or an unavailable service (caller treats as "can't
// resolve" — never fall back to an unverified handle).
// A tenant/app SCOPE (per-tenant account isolation). Default '' = the GLOBAL directory (standalone regular Spaces —
// byte-identical). A tenant vault/app sets a STABLE, origin-INDEPENDENT scope, so the SAME email is a DIFFERENT account
// per app: the handle derives from (scope · email), never colliding with — or resolving — the global one. The scope
// must be applied to BOTH blind() and finalize() (the DLEQ verify re-hashes the same input), so they stay consistent.
let _dirScope = ''
// `spaces` and `spaces.<kind>` are slot NAMES with their own writers (the regular app's slot, attestedBox.js boxApp) — never a
// scope: the username slot is written under the scope's name, so a link's `?dirscope=spaces.emulated` would put the regular
// invite box into the attested slot (sync sweep 2026-10-20 #3).
export const reservedScope = (s) => /^spaces(\.|$)/.test(String(s || ''))
export function setDirScope(scope) { _dirScope = reservedScope(scope) ? '' : String(scope || '') }
export const getDirScope = () => _dirScope // the same namespace for the email-discovery switch (usernameSettings.js)

export async function resolveHandle(email, client, scope = _dirScope) {
  const e = scope ? scope + '\x1f' + email : email
  const { b, r } = blind(e)
  const ev = await client.oprf(b)
  if (!ev || ev.status !== 200 || !ev.z || !ev.proof || !ev.kpub) throw new Error('oprf_unavailable')
  return finalize(e, ev.z, r, ev.proof, ev.kpub) // verifies the DLEQ, unblinds, hashes → the handle
}

// THE USERNAME DOOR OF A SCOPED APP (the owner, 2026-10-19: an invite sent in the hosted app by @username landed in the
// invitee's REGULAR app). A username names the GLOBAL handle, and a scoped app's own slot lives under its scoped one, so
// the lookup could only answer the regular app's inbox. A scoped app therefore ALSO keeps its slot under the global handle,
// named after its scope (agent/spaceHandler.mjs dirSlot — one row, one slot per app), and asks for that slot by name
// (inviteSend.js). The same "find me by email" switch covers it. Only first-party apps can write under the global handle
// (the server refuses a sign-in made on another website). → { ok } | { skip } | { ok:false, reason }.
export const usernameSlotApp = () => _dirScope || null
export async function enrollUsernameSlot({ email, idToken, client, id }) {
  if (!_dirScope) return { skip: true }
  if (!email || !idToken || !client || !id || !id.boxPub || !id.inbox) return { ok: false, reason: 'bad_args' }
  const handle = await resolveHandle(email, client, '') // the GLOBAL handle — what a username names
  const r = await client.dirPut(handle, { boxPub: id.boxPub, inbox: id.inbox }, idToken, '', _dirScope)
  return r && r.status === 200 ? { ok: true } : { ok: false, reason: 'dir_put_failed:' + (r ? r.status : 'net') }
}

// Publish (or refresh) this user's invite slot. Idempotent by design: REUSES an existing invite identity when present
// (so all your devices — and a restored one — share one boxPub/inbox), otherwise mints a fresh keypair. `load`/`save`
// persist the identity; `save` is also where the caller queues a backup so boxPriv survives device loss.
// `scope`: the directory namespace (default: the one this page set) — the SDK passes its app's own, 'app:<origin>'.
export async function enroll({ email, idToken, client, genRecipientKey, load, save, scope = _dirScope }) {
  if (!email || !idToken || !client || !genRecipientKey) return null
  let id = (load && load()) || null
  if (!id || !id.boxPub || !id.boxPriv || !id.inbox) {
    const kp = await genRecipientKey() // { publicJwk, privateJwk } — ECDH P-256 (e2ee.js)
    id = { boxPub: kp.publicJwk, boxPriv: kp.privateJwk, inbox: randInbox() }
  }
  const handle = await resolveHandle(email, client, scope)
  const r = await client.dirPut(handle, { boxPub: id.boxPub, inbox: id.inbox }, idToken, scope) // send the scope so the server re-derives OPRF(scope·email)==handle (a scoped account's put would otherwise 403 handle_mismatch)
  if (!r || r.status !== 200) throw new Error('dir_put_failed:' + (r ? r.status : 'net'))
  const next = { ...id, handle }
  if (save) save(next)
  return next
}
