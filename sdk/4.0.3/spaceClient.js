// witz/public/spaceClient.js — the THIN async-Space client (docs/async-spaces-m2.md).
//
// The client holds `mk` (reconstructed LOCALLY from the link fragment). TWO read paths exist:
//   • pollSealed (preferred) — the server returns the SEALED ledger and we open it here. `mk` never leaves the device
//     on the hot loop, which fires every ~600ms while a Space is on screen.
//   • poll (legacy)          — `mk` is sent and the Lambda decrypts inside the AWS boundary, returning plaintext.
// `turn` still sends `mk`, because the agent genuinely needs plaintext to think; that window is bounded and per-request
// rather than continuous. So this module is transport + the client-side KEY math (mint / reconstruct / open). `fetch`
// is injectable so the whole thing is testable without a network. All the crypto lives in spaceConfig.js/e2ee.js.
import { applyConnectionsPatch } from './connectionEntry.js' // what a room keeps about a connection (docs/mcp-connections.md)
import { createConfiguredSpace, assembleConfiguredKey, parseConfiguredLink } from './spaceConfig.js'
import { newCode, sealUnderCode, openUnderCode } from './invite.js'
import { seal, open, ledgerAad, sealTo, genRecipientKey, splitKey, combineShares, newKey, commit as keyCommit } from './e2ee.js'
import { parseAcceptance } from './enclaveAccept.js'
import { signEntry } from './entrySig.js'
import { sealMk, mkAad, newNonce, sealNow, noteServerClock } from './mkseal.js'
import { sealRequest, openAnswer, PLAIN_OPS, IDENTITY_PLAIN_OPS, carriesIdentity } from './reqEnvelope.js' // the sealed request envelope (confidential rooms)

// SELF-SERVE EMBED attribution (demo tier): when the app runs at /embed-create?tid=…, carry the tenant id + the EMBEDDER
// origin (document.referrer — browser-set; the iframe can't forge its own referrer) so the server can adopt the new room
// to that tenant IFF the origin is one it DECLARED. Omitted (→ {}) outside the embed-create flow, so behavior is unchanged.
function embedAttribution() {
  try {
    if (typeof location === 'undefined') return {}
    const tid = new URLSearchParams(location.search).get('tid') || ''
    const embedOrigin = (typeof document !== 'undefined' && document.referrer) ? new URL(document.referrer).origin : ''
    return (tid && embedOrigin) ? { tid: tid.slice(0, 64), embedOrigin } : {}
  } catch { return {} }
}
import { verifyRoomGovernance } from './ownerPolicy.js'
import { staysDirect } from './roomName.js' // a direct chat that gains a third member is a group (rekey)
import { memberHash } from './rosterHash.js' // hash the email allow-list (room-bound) before sealing → co-members can't read addresses

// Seal the agent CONFIG (persona/tools/…) under mk so it's ciphertext at rest — the server can't read what a Space is
// for; it decrypts-once per turn (same discipline as the ledger). Wire-compatible with the Lambda's envelope.open.
const sealConfig = async (config, mk) =>
  JSON.stringify(await seal(JSON.stringify({
    tools: config.tools, immediateTools: config.immediateTools, clientTools: config.clientTools, persona: config.persona, agentName: config.agentName,
    ...(config.appId ? { appId: String(config.appId).slice(0, 40) } : {}), // §APP STORE Stage 1: the Space's chosen app — an ID, never a URL (the store origin resolves it against its catalog)
    // The DECLARED MCP server (name → typed input schema) — sealed like the rest, so the platform can't read the app's
    // skill surface at rest; the turn op reads it in the mk-scoped decrypt to type-check + admit an app→agent mcp call.
    skills: config.skills,
    // BYO model — {provider, key, model, baseUrl}. Sealed like the rest of the config, so the tenant's credential is
    // ciphertext at rest and the platform cannot read it outside a turn.
    model: config.model,
    // Admission policy + allow-list ride INSIDE the sealed config → the platform can't read a Space's gate or who's
    // allowed at rest; the turn op reads them only in the mk-scoped decrypt (spaceHandler create → spaceService turn).
    // JSON.stringify drops undefined keys, so an open Space seals exactly as before (backward compatible).
    admission: config.admission, allow: config.allow, requireChallenge: config.requireChallenge, agentKeys: config.agentKeys, usernames: config.usernames, // usernames:false = the room opted out of the server-stamped @username on verified entries (docs/spaces-usernames.md §7)
    // Owner rule (docs/the-owner-rule.md): the owner-SIGNED App Policy + this room's tier, sealed like the rest — so the
    // render enforces it and a joining client can open + peer-verify governance against the pinned owner key. Undefined
    // (ungoverned room) ⇒ JSON.stringify drops them ⇒ sealed exactly as before.
    ownerPolicy: config.ownerPolicy, roomTier: config.roomTier,
    // Private lane (docs/spaces-private-lane.md): `bridge` = a private lane's link to its shared room; `agentReplies`
    // = false for a Bridge SHARED room (an observer venue — the agent doesn't auto-reply). Sealed like the rest, so
    // both are content-blind at rest; undefined (a normal Space) ⇒ JSON.stringify drops them ⇒ sealed exactly as before.
    bridge: config.bridge, agentReplies: config.agentReplies,
    // THE ROOM AS A STORE (agent/dataTools.mjs): the app's declared collections + field rules. Sealed like the rest; a
    // room without one sees no data tools. Undefined ⇒ dropped ⇒ sealed exactly as before.
    dataSchema: config.dataSchema,
    // WHICH PLATFORM TOOLS the assistant gets (agent/spaceService.mjs normPlatformTools): absent = all, false = none, a list =
    // only those. Undefined ⇒ dropped ⇒ sealed exactly as before.
    platformTools: config.platformTools === false || Array.isArray(config.platformTools) ? config.platformTools : undefined,
    // BUILDER MODE (Tomer, 2026-10-10): `framing: 'builder'` = the prompt is the app's persona and tools only — no Spaces
    // framing; `dataWrites: false` = the room store offers data_query only. Undefined ⇒ dropped ⇒ sealed exactly as before.
    framing: config.framing === 'builder' ? 'builder' : undefined,
    // A PURGEABLE room (docs/room-messages.md § Retention): its handled rows may be purged (op 'purge'). Create-time only,
    // and only the account's own control rooms — the server refuses it on any room with an assistant or admission.
    retention: config.retention === 'purgeable' ? 'purgeable' : undefined,
    dataWrites: config.dataWrites === false ? false : undefined,
    // SAFE MEDIA (docs/safe-media.md): photos and PDFs here are shown from copies the tools enclave made safe. Undefined ⇒ dropped ⇒ sealed exactly as before.
    safeMedia: config.safeMedia === true ? true : undefined,
    // Private lanes for EVERYONE (create checkbox): a create-time room property every joiner learns from the room —
    // this whitelist silently DROPPED it, which is why an invitee whose link lost the one-shot &lanes=1 hint could
    // never self-heal (the sealed config genuinely lacked the field). Undefined ⇒ dropped ⇒ sealed exactly as before.
    lanes: config.lanes === true ? true : undefined,
    lane: config.lane === true ? true : undefined, // A PRIVATE LANE SAYS SO (laneConfig.js `lane: true`): this whitelist dropped it, so the server and the cloud device never saw it (sync sweep 11-19 P1)
    // Membership fork (docs/spaces-membership-fork.md): the epoch's admitted ROSTER (name+spk per keeper), stamped by
    // forkRoom. Since membership only changes via a fork (add = fork), this stays authoritative between forks — so the
    // NEXT fork reads it instead of re-deriving from the ledger (whose carried history still holds removed members'
    // spks). Absent on an original room ⇒ dropped by JSON.stringify ⇒ sealed exactly as before (roster derived from the
    // ledger as the bootstrap). Sealed under mk like the rest — the platform can't read who's in.
    roster: config.roster,
    // `forkAuthority` = the spk allowed to publish a membership-fork notice for this room (the creator, then carried
    // across forks). A keeper AUTO-FOLLOWS a fork only if the notice is signed by this key — the hijack defense, since
    // anyone holding mk could otherwise read keeper spks from the ledger and forge a fork to a room they control.
    forkAuthority: config.forkAuthority,
    // `parent` = { room } of the PRIOR epoch, set by a LINK fork (P4, epoch-keyed): history lives in the parent chain
    // rather than being re-sealed here, so a fork is O(1). readEpochChain walks it with the ancestor keys from the
    // pointer. Absent on a normal/full-fork room ⇒ dropped by JSON.stringify ⇒ sealed exactly as before.
    parent: config.parent,
    // Enclave acceptance (docs/enclave-room-acceptance.md): what THIS Space accepts from the confidential tier —
    // `{mode: follow|pin, minPolicyVersion, accepted:[{kernel,payload,policy,…}]}`. Sealed under mk like the rest, so
    // every member (and the enclave, which re-opens the config) reads the same declaration; create-once, so a change
    // is a fork. Validated here so garbage is refused at mint rather than guessed about by every opener. Absent
    // (a normal Space, or a pre-P2 confidential one ⇒ follow) ⇒ dropped by JSON.stringify ⇒ sealed exactly as before.
    enclave: parseAcceptance(config.enclave) || undefined,
    // ROOM GOVERNANCE (2026-10-02). `admins` ({ emails }) and `approve` ('admins'|'members') are enforced by the SERVER
    // (spaceService hasAdmins/isRoomAdmin/cardNeedsAdmin) — and were MISSING from this list, so an SDK room declared them
    // and sealed without them: no admins, approvals by any member (a builder measured it on production). `forkedFrom` is
    // where a fork came from; `connections` are the grants a fork carries. Undefined ⇒ dropped ⇒ sealed exactly as before.
    admins: config.admins && Array.isArray(config.admins.emails) ? { emails: config.admins.emails.map((x) => String(x).toLowerCase()) } : undefined,
    owners: config.owners && Array.isArray(config.owners.emails) ? { emails: config.owners.emails.map((x) => String(x).toLowerCase()) } : undefined, // OWNERS (2026-10-03): above admins, enforced by the room
    forkedFrom: typeof config.forkedFrom === 'string' && config.forkedFrom ? config.forkedFrom.slice(0, 120) : undefined,
    connections: Array.isArray(config.connections) && config.connections.length ? config.connections : undefined,
    direct: config.direct === true ? true : undefined, // a DIRECT chat (directChat.js): the server refuses its rename, the other side files it by this
    help: config.help === true ? true : undefined, // the account's HELP SPACE (helpSpace.js): the server runs its built-in help configuration
  }), { room: mk }))
// A random pad the same shape as a real 2-of-2 invite → a SOLO record carries one too, so the stored record doesn't
// reveal the key model (couple vs solo).
const invitePad = () => { const r = crypto.getRandomValues(new Uint8Array(90)); return btoa(String.fromCharCode(...r)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

const DEFAULT_ENDPOINT = '/space'
const originBase = () => (typeof location !== 'undefined' && location.origin) || ''

// ── OHTTP (RFC 9458) — flag-gated oblivious transport ────────────────────────────────────────────────────────────
// When a client is configured with an OHTTP relay + the gateway's key config, every op is encapsulated to the
// gateway's public key and POSTed through the RELAY: the relay sees this device's IP but only ciphertext, the gateway
// decrypts the op but sees only the relay's IP — so neither alone links a device to its room. Behaviour-neutral when
// unset: `call()` posts JSON to the endpoint exactly as before. The crypto lives in ohttp.js (RFC-vector-tested).
// Two OHTTP modes, one seam. `{ send }` = the L1.5 mode: the app hands the raw op to a pinned, separate-origin frame
// (spaces/ohttp-l1) that encapsulates + fetches the attested relay itself, so the ENCAPSULATION runs in code the app
// can't tamper with (the verifiable-client property). `{ relay, keyConfig }` = the direct mode: the app encapsulates
// in-process (simpler; used by tests / the non-framed path). Unset ⇒ plain JSON POST (behaviour-neutral).
let _ohttp = null
export function configureOhttp(cfg) { _ohttp = (cfg && (typeof cfg.send === 'function' || (cfg.relay && cfg.keyConfig))) ? cfg : null }
export function ohttpActive() { return !!_ohttp }

// OHTTP-PENDING GATE. When "Hide my IP" is ON, its setup (frame the L1.5 shim → attest the relay → fetch the key config)
// takes a beat, and NO op may fire direct meanwhile or it leaks the device IP the toggle exists to hide. The old code
// bought that guarantee by AWAITing setup in boot — which held the whole UI hostage for the full setup (seconds, and up
// to the 25s timeout on a bad network), the "blank for 30s then the app appears" bug. Instead: boot marks OHTTP pending
// SYNCHRONOUSLY (before op one) and stops awaiting, so views resolve instantly; each network op below awaits this gate,
// so it still never fires before OHTTP is up (success ⇒ routed oblivious) or has definitively given up (failure ⇒ direct,
// the unchanged fail-open-to-direct posture). Untouched when OHTTP is off: _ohttpPending stays null → zero added latency.
let _ohttpPending = null // a Promise (with its resolver stapled on) while setup is in flight; null otherwise
export function markOhttpPending() { let done; _ohttpPending = new Promise((r) => { done = r }); _ohttpPending._done = done }
export function resolveOhttpPending() { const p = _ohttpPending; _ohttpPending = null; if (p && p._done) p._done() }
async function awaitOhttpReady() { const p = _ohttpPending; if (p) { try { await p } catch { /* setup rejects are swallowed → fall through to the _ohttp check */ } } }

// Route ONE raw op through the ACTIVE OHTTP channel (the exact seam call() uses) and resolve the parsed JSON — or null
// when OHTTP is inactive, so a caller that does its own direct POST (the enclave attest/wake path, which bypasses the
// mk-sealing client) can fall back. This lets those non-sealing transports ALSO hide the device IP when "Hide my IP" is
// on: null ⇒ toggle off ⇒ direct POST (unchanged); an object (even {status:0,error}) ⇒ toggle on ⇒ NEVER a direct
// leak — fail-closed on IP exactly like call().
export async function ohttpSend(body, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  await awaitOhttpReady() // hold until "Hide my IP" setup settles, so this never picks the direct path while OHTTP is still coming up
  if (!_ohttp) return null
  try { return _ohttp.send ? await _ohttp.send(body) : await ohttpCall(body, fetchImpl) }
  catch (e) { return { status: 0, error: 'ohttp: ' + String((e && e.message) || e).slice(0, 120) } }
}

// VERIFY the relay's attestation, THEN enable OHTTP — fail-closed (an unverifiable relay is never used). The gateway
// key config is fetched THROUGH the relay (a plain {op:'ohttp-config'} the relay forwards), so even that first fetch
// never reveals the device IP to the gateway. `expect` pins the relay's Confidential Space identity (aud, operator
// project, hwmodel, optional image digest). Returns true when OHTTP is now active. Behaviour-neutral on failure.
export async function verifyAndEnableOhttp(relayBase, expect = {}, gateway = { authority: 'api.witbitz.chat', path: '/v1/space' }, fetchImpl) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null); if (!f) return false
  try {
    const cs = await import('./csAttest.js')
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const att = await (await f(relayBase + '/attestation?nonce=' + nonce)).text()
    const v = await cs.verifyCsToken(att, { ...expect, nonce }, { hwmodel: expect.hwmodel || 'GCP_AMD_SEV' })
    if (!v.ok) { try { console.warn('ohttp: relay attestation refused —', v.error) } catch { /* */ } return false }
    const cfg = await (await f(relayBase + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'ohttp-config' }) })).json()
    if (!cfg || !cfg.publicKey) return false
    const bin = atob(String(cfg.publicKey).replace(/-/g, '+').replace(/_/g, '/')); const pk = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) pk[i] = bin.charCodeAt(i)
    configureOhttp({ relay: relayBase + '/relay', gatewayAuthority: gateway.authority, gatewayPath: gateway.path, keyConfig: { keyId: cfg.keyId, publicKey: pk } })
    try { console.log('ohttp: enabled via attested relay', v.imageReference) } catch { /* */ }
    return true
  } catch (e) { try { console.warn('ohttp enable failed:', (e && e.message) || e) } catch { /* */ } return false }
}
let _ohttpMod = null
const ohttpMod = async () => (_ohttpMod || (_ohttpMod = await import('./ohttp.js')))

async function ohttpCall(body, fetchImpl) {
  const O = await ohttpMod()
  const inner = O.encodeRequest({
    method: 'POST', scheme: 'https', authority: _ohttp.gatewayAuthority, path: _ohttp.gatewayPath || '/',
    headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)),
  })
  const { encRequest, ks, enc } = await O.encapsulateRequest(_ohttp.keyConfig, inner)
  // Send the encapsulated request THROUGH the relay as { op:'ohttp', enc:<base64> } — the relay forwards this opaque
  // envelope to the gateway verbatim (it can't read enc: ciphertext) and returns { res:<base64> }. Relay sees our IP
  // but not the room; the gateway decrypts the room but sees the relay's IP, not ours.
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s) }
  const ub64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
  const res = await fetchImpl(_ohttp.relay, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'ohttp', enc: b64(encRequest) }) })
  if (!res.ok) return { status: res.status }
  let env = {}; try { env = await res.json() } catch { return { status: res.status } }
  if (!env.res) return { status: env.status || res.status, ...(env.error ? { error: env.error } : {}) }
  const respBhttp = await O.decapsulateResponse(ks, enc, ub64(env.res))
  const resp = O.decodeResponse(respBhttp)
  let data = {}
  try { data = JSON.parse(new TextDecoder().decode(resp.body) || '{}') } catch { /* status only */ }
  return { status: resp.status, ...data }
}

async function call(endpoint, body, fetchImpl) {
  await awaitOhttpReady() // hold until "Hide my IP" setup settles, so an op never leaks direct while OHTTP is still coming up
  if (_ohttp) { try { return _ohttp.send ? await _ohttp.send(body) : await ohttpCall(body, fetchImpl) } catch (e) { return { status: 0, error: 'ohttp: ' + String((e && e.message) || e).slice(0, 120) } } }
  const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let data = {}
  try { data = await res.json() } catch { /* non-JSON → status only */ }
  return { status: res.status, ...data }
}

/** A space client bound to an endpoint. `create`/`open` do the KEY math locally; turn/poll/pending/decide are transport. */
// `app` — a short tag naming the app that creates rooms with this client ('spaces' for the first-party PWA, a
// third party's own tag when they embed). Sent on create only, so every room is attributable to its origin. It is
// self-declared and the server treats it as a hint, never as authorization — see the note in spaceHandler's create.
// Set it once here rather than at each call site, so no future create can forget it.
// This device's own push endpoint, if it has one. Sent with a turn so the server skips THIS DEVICE rather than every
// subscription whose stored name matches the author's — which fails in both directions: one person on two devices
// notifies neither, and two people who share a display name notify neither. Absent is fine; the server falls back to
// the old name rule for clients that predate this.
let _pushSelf = ''
export function setPushSelf(endpoint) { _pushSelf = String(endpoint || '') }
const pushSelf = () => _pushSelf
/** THIS device's VIEWING TAG for a room (agent/roomStream.mjs viewingTagFor — the same HMAC): its push endpoint as the key,
 *  so the server can recompute it from the subscription, per room so the relay cannot link the device across rooms. The
 *  room's stream socket carries it; while that socket is open, the server does not tickle this device for this room.
 *  '' when this device has no push endpoint (nothing to suppress). */
export async function viewingTag(room) {
  if (!_pushSelf || !room || !(globalThis.crypto && crypto.subtle)) return ''
  try {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(_pushSelf), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('witbitz-viewing|' + room))).slice(0, 16))
  } catch { return '' }
}
// …and this device's ACCOUNT, so the server skips the poster's OTHER devices too (2026-10-03, the owner: "the other device
// started a round, I still get the tickle"). The secret is derived from the key of the account's INDEX ROOM — the room
// that syncs the account's room list, so every synced device of the account holds the same key, and no other member
// does (an account recovery key would have done too, but many accounts never set one up); what goes on the wire
// is HMAC(secret, room) — per room, so it never links one account across rooms. No secret ⇒ no field ⇒ as before.
let _pushAcct = ''
const _acctTags = new Map()
export const hasPushAcct = () => !!_pushAcct // export diagnostics: does this device tag its subscribes with an account?
export function setPushAcct(secret) { const s = String(secret || ''); if (s !== _pushAcct) { _pushAcct = s; _acctTags.clear() } }
const b64u = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function pushAcctField(room) {
  if (!_pushAcct || !room || !(globalThis.crypto && crypto.subtle)) return {}
  try {
    let t = _acctTags.get(room)
    if (!t) {
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(_pushAcct), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      t = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('witbitz-push-acct|' + room))).slice(0, 16))
      _acctTags.set(room, t)
    }
    return { pushAcct: t }
  } catch { return {} }
}
/** The push secret of the account, from its index room's key (`mk`), or '' — a one-way derivation, never the key. */
export async function pushAcctSecretOf(indexMk) {
  const k = typeof indexMk === 'string' ? indexMk : ''
  if (!k || !(globalThis.crypto && crypto.subtle)) return ''
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('witbitz-push-acct-secret|' + k))))
}

// VERIFIED-CLIENT attestation provider (docs/verified-client-design.md, Phase 2 S3b). A requireVerifiedClient room
// withholds material reads unless the request carries a client-release attestation. The attestation is minted by the
// L1 vault (its install-time key), so L3 REQUESTS one per read via this injectable provider: `provider(room)` →
// attestation object (or null). Set by the extension/vault (setAttestProvider), or read from `window.__vcAttestProvider`.
// Unset ⇒ material reads on a verified room stay withheld (fail-closed — a non-verified client can't open one).
let _attestProvider = null
export function setAttestProvider(fn) { _attestProvider = typeof fn === 'function' ? fn : null }
export const getAttestProvider = () => _attestProvider // so the L1 façade can serve the WORKER realm's attestation requests from the main-thread provider
// THE READ PROOF provider — its own slot, so the verified-client provider (the vault's
// release attestation) is never replaced by it. In the worker realm both are the main-thread shim (attestShim forwards `o`).
let _readProvider = null
export function setReadAttestProvider(fn) { _readProvider = typeof fn === 'function' ? fn : null }
export const getReadAttestProvider = () => _readProvider
const readAttestProvider = () => _readProvider || _attestProvider
const attestProvider = () => _attestProvider || ((typeof window !== 'undefined' && typeof window.__vcAttestProvider === 'function') ? window.__vcAttestProvider : null)

// `tenant` — the PUBLIC id of the tenant this page belongs to (never a key). A create carries it as `tid`, and the
// server adopts the room to that tenant iff this page's origin is one the tenant declared. A page on an undeclared
// origin gains nothing by naming a tenant; a declared origin needs no credential.
// `userToken` — PER-USER BILLING (docs/tenant-billing.md § 13 3a): a short-lived token the TENANT'S BACKEND minted for one
// of its users (POST /v1/tenant/users/{id}/token). A value, or a function (sync or async) the app uses to refresh it. It
// rides ONLY on ops that can spend (SPEND_OPS): the server refuses a request whose token does not hold, and a page left
// open past the token's expiry must still be able to READ its rooms. Absent ⇒ nothing is sent, exactly as before.
/** A request body with its sign-in's token replaced by a renewed one → the new body, or null (no sign-in here, or the renewal is
 *  for another key: a turn's entry is signed by its key, so its token can be replaced only by one bound to the same key). */
export function withSignIn(b, fresh) {
  if (!b || !fresh || typeof fresh.idToken !== 'string' || !fresh.idToken || !fresh.spk) return null
  const same = (a) => { try { return JSON.stringify(a) === JSON.stringify(fresh.spk) } catch { return false } }
  if (b.message && typeof b.message === 'object' && b.message.idToken) return same(b.message.spk) ? { ...b, message: { ...b.message, idToken: fresh.idToken } } : null
  if (b.idToken) return { ...b, idToken: fresh.idToken, spk: fresh.spk } // a read: the key may change with the token (psig names it afresh)
  return null
}
export const SPEND_OPS = new Set(['turn', 'title', 'decide', 'import'])
// VOICE ON CREDITS (docs/spaces-plans.md § 4a escape 9): press-to-talk and read-aloud keys are billed to the account whose
// token comes with the request — the account's own is attached here too (never over one the caller passed: the SDK's user).
const VOICE_OPS = new Set(['stt', 'tts'])
// THE ROOM PASS (docs/device-gate-design.md; roomPass.js): `roomPass` — { fieldsFor(body) → { pass, psig } | {}, renew?(body) } —
// adds an active device's pass and its session key's signature to every request that carries a sign-in. Unset ⇒ as before.
// `renewSignIn(body)` → { idToken, spk } | null: a fresh token for the request's sign-in (the same key: a turn's entry stays signed).
export function makeSpaceClient({ endpoint = DEFAULT_ENDPOINT, fetch: fetchImpl, auth, mkPub, app, enclave = false, envelope = false, identity = false, tenant, userToken, delCommit, roomPass = null, renewSignIn = null, onConfidential = null } = {}) {
  const tenantHint = tenant ? { tid: String(tenant).slice(0, 64) } : {}
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!f) throw new Error('no fetch available — pass { fetch }')
  // ENCLAVE TIER. `enclave` and `mkPub` may EACH be a value OR a per-room function (room) => …, so ONE client can run
  // some rooms in the enclave and others normally (a room's tier is fixed at creation). For an enclave room, post()
  // marks the op enclave:true (the backend relays it to the Nitro enclave) and keyFields() seals mk to the room's
  // ATTESTED enclave key (mkPub) — so the relay only ever sees opaque bytes. FAIL-CLOSED: an enclave room with no key
  // throws rather than send raw mk to the relay. Both unset ⇒ identity, unchanged behavior.
  const enclaveFor = (room) => { try { return typeof enclave === 'function' ? !!enclave(room) : !!enclave } catch { return false } }
  // A thrown `enclave_not_accepted` (enclaveAccept.js gatedKey: the Space refuses THIS enclave build) must surface as
  // itself — the UI shows the mismatch sheet on that code; any other mkPub failure still flattens to "no key".
  const mkPubFor = (room) => { try { return typeof mkPub === 'function' ? (mkPub(room) || null) : (mkPub || null) } catch (e) { if (e && e.code === 'enclave_not_accepted') throw e; return null } }
  // THE SEALED REQUEST ENVELOPE (reqEnvelope.js; docs/confidential-path-sweep-2026-11-05.md option A): `envelope` — a value or
  // (room) => bool — says the room's LIVE enclave opens envelopes (its measured policy: reqEnvelope.opensEnvelopes). Then every
  // content op goes sealed WHOLE to the enclave, and its answer comes back sealed under a one-time key. Unset ⇒ as before.
  // → true | false | null (UNKNOWN: the live enclave's policy is not known here). Unknown is never "plaintext" (reqEnvelope.opensEnvelopes).
  const envelopeFor = (room) => { try { const v = typeof envelope === 'function' ? envelope(room) : envelope; return v === true ? true : (v === null || v === undefined) && typeof envelope === 'function' ? null : false } catch { return null } }
  // OPTION B (docs/confidential-identity-option-b.md): `identity` — a value or (room) => bool — says the room's live enclave takes
  // WHO YOU ARE from inside the envelope (reqEnvelope.sealsIdentity). Then the sign-in token rides inside, with the hints the
  // front would have added (op `idextras`, fetched apart from any room request and kept until they near their end).
  const identityFor = (room) => { try { return (typeof identity === 'function' ? identity(room) : identity) === true } catch { return false } }
  const extrasCache = new Map() // issuer|email → { v, exp } | { p } (in flight)
  const EXTRAS_REFRESH_MS = 3_600_000 // refreshed in the background once an hour old: a changed @username reaches rooms within the hour
  const tokenClaims = (tok) => { try { const p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return p && typeof p === 'object' ? p : null } catch { return null } }
  const fetchExtras = async (key, tok) => {
    let r = await call(endpoint, { op: 'idextras', idToken: tok }, f).catch(() => null)
    if (!r || (r.status !== 200 && r.status !== 401)) { await new Promise((ok) => setTimeout(ok, 400)); r = await call(endpoint, { op: 'idextras', idToken: tok }, f).catch(() => null) } // once more before the token goes outside
    if (!r || r.status !== 200 || r.ok !== true || !Number.isFinite(r.exp)) { extrasCache.delete(key); return null }
    // boundHints (sync sweep 2026-11-16 #6): the room-pass cutoff's word for this address, signed by the front for ten minutes — the enclave
    // takes no other (agent/roomPass.mjs boundFromHints). They were dropped here, so with the cutoff on every confidential verified room
    // refused a request without a pass. The front caps `exp` at theirs, so the cache below asks again before they end.
    const v = { ...(Array.isArray(r.userHints) ? { userHints: r.userHints } : {}), ...(r.issuerCfg && typeof r.issuerCfg === 'object' ? { issuerCfg: r.issuerCfg } : {}), ...(Array.isArray(r.boundHints) && r.boundHints.length ? { boundHints: r.boundHints.slice(0, 4) } : {}) }
    extrasCache.set(key, { v, exp: r.exp, at: Date.now() })
    return v
  }
  /** The extras for this sign-in → {userHints?, issuerCfg?, boundHints?}, or null when they could not be had (the token then still rides
   *  INSIDE, with no hints — post() sends a refused request again once with fresh ones; state machines pass 7). `fresh`: past the cache. */
  const extrasFor = async (tok, { fresh = false } = {}) => {
    const c = tokenClaims(tok)
    const email = c && typeof c.email === 'string' ? c.email.trim().toLowerCase() : ''
    if (!email) return {} // a token with no email claim gets no hint from the front either
    const key = String(c.iss || '') + '|' + email, now = Date.now()
    if (fresh && !(extrasCache.get(key) || {}).p) extrasCache.delete(key)
    const hit = extrasCache.get(key)
    if (hit && hit.v && now < hit.exp - 60_000) {
      if (now > hit.at + EXTRAS_REFRESH_MS && !hit.p) { hit.p = fetchExtras(key, tok).finally(() => { const h = extrasCache.get(key); if (h) delete h.p }) }
      return hit.v
    }
    if (hit && hit.p) return hit.p
    const p = fetchExtras(key, tok)
    extrasCache.set(key, { p })
    return p
  }
  const tokenOfBody = (b) => (typeof b.idToken === 'string' ? b.idToken : (b.message && typeof b.message.idToken === 'string' ? b.message.idToken : ''))
  const tokenFor = async (op) => {
    if (!userToken || !(SPEND_OPS.has(op) || VOICE_OPS.has(op))) return ''
    try { const t = typeof userToken === 'function' ? await userToken() : userToken; return typeof t === 'string' ? t : '' } catch { return '' }
  }
  const post = async (body) => {
    const tok = body && !body.userToken ? await tokenFor(body.op) : '' // a token the caller passed (the SDK's user) is never replaced
    // In a CONFIDENTIAL room the token rides SEALED to the attested enclave (turn.mjs opens it; docs/tenant-billing.md
    // § 12.2) — the relay must neither read nor swap who pays. A seal that cannot be made sends no token at all.
    let tokFields = {}
    if (tok) {
      if (body.room && enclaveFor(body.room)) { try { tokFields = (await sealField(body.room, body.op + ':ut', tok, 'userToken')) || {} } catch { tokFields = {} } }
      else tokFields = { userToken: tok }
    }
    let b0 = tok ? { ...body, ...tokFields } : body // let: a renewed sign-in replaces its token (app_unnamed, below)
    // ★ EVERY OP OF AN ATTESTED ROOM CARRIES A FRESH PROOF (step 2b; agent/spaceService.mjs
    //   ATTEST_READ_OPS): a room this client knows answers `attest_required` gets one on every request, and a refusal from a
    //   room it did not yet know is signed and retried once. Turns (their own attestation), `policy` and `attest-accept`
    //   are left alone; a body that already carries a proof (the read paths, withVerified) is too.
    const attested = !!(b0 && b0.room && !ATTEST_OWN_OPS.has(b0.op) && !b0.readAttestation)
    const send = async () => {
      let b = attested ? { ...b0, ...(await readAttestFor(b0.room)) } : b0
      if (roomPass && b && typeof roomPass.fieldsFor === 'function') { let pf = {}; try { pf = (await roomPass.fieldsFor(b, { ts: sealNow() })) || {} } catch { pf = {} } if (pf.pass && pf.psig) b = { ...b, pass: pf.pass, psig: pf.psig } } // signed afresh on every send, at the server's clock as learned here (sealNow; sync sweep 11-16 #8)
      // …or a KEYLESS content-free request (PLAIN_OPS) for a Space a `confidential_room` refusal already named (tierKnown, below):
      // it goes to the enclave too — this device does not mark the Space, and every such request went to the standard tier again
      const body = (b && (b.enclave === true || enclaveFor(b.room) || learnedConfidential(b))) ? { enclave: true, ...b } : b
      const enc = body && body.enclave === true && typeof body.room === 'string'
      const idWay = enc && identityFor(body.room) && carriesIdentity(body)
      // a verified room's read carries a token: sealed under option B when the live enclave opens envelopes (unknown → plain, as before)
      const sealedWay = !enc ? false : !PLAIN_OPS.has(body.op) ? envelopeFor(body.room) : (idWay && IDENTITY_PLAIN_OPS.has(body.op) && envelopeFor(body.room) === true)
      if (sealedWay === null) return { status: 503, ok: false, error: 'enclave_policy_unknown', retryable: true, reason: 'this confidential Space\'s enclave could not be fully checked yet, so nothing was sent — try again' } // 503, never 0: nothing was sent, so it is not "maybe posted" (sweep 11-06 #8)
      // ONLY THE SIGN-IN made this read sealed (a content-blind read of a room that is not gated): while the room's enclave
      // sleeps, the front serves such a read itself — readable, so the sealed request gets 502 answer_unsealed and an open
      // confidential room showed nothing to a signed-in SDK (sweep 11-07 #4; the app sends no sign-in for an open room). The
      // read needs no sign-in: it goes plain WITHOUT it for a short while — the sign-in never goes outside an envelope.
      const idOnly = sealedWay === true && PLAIN_OPS.has(body.op) && !gatedRooms.has(body.room)
      const plainNoId = () => { const { idToken: _t, spk: _s, pass: _p, psig: _q, ...rest } = body; return call(endpoint, rest, f) }
      if (idOnly && (asleepPlain.get(body.room) || 0) > Date.now()) return plainNoId()
      if (sealedWay === true) {
        const pub = mkPubFor(body.room) // fail CLOSED: an enclave that opens envelopes but no attested key here → nothing is sent
        if (!pub) throw new Error('enclave key unavailable for this room — refusing to send the request to the relay')
        // ⛔ THE SIGN-IN NEVER GOES OUTSIDE AN ENVELOPE THAT TAKES IT (owner, state machines pass 7): when the hints could not be
        //   had (the front's idextras failed), the token still rides INSIDE, with no hints. A member the enclave admits only by
        //   a hint (an @username tag, a non-Google issuer) is then refused — the refused request ran nothing, so it is sent
        //   again ONCE after a fresh fetch of the hints, and the refusal stands if they still cannot be had.
        let extras = idWay ? await extrasFor(tokenOfBody(body)) : null
        const sealedSend = async (ex, bd = body) => { const { outer, answer } = await sealRequest(bd, pub, { identity: idWay, extras: ex || {} }); return openAnswer(await call(endpoint, outer, f), answer) }
        let out = await sealedSend(extras)
        // …only a refusal that NAMES itself ran nothing: a bare 5xx is the gateway's 30 s cut-off of a turn the Lambda is still
        // running — sent again, the message was posted twice (sync sweep 2026-11-13, P2)
        if (idWay && !extras && out && ((out.status === 403 && out.error === 'not_authorized') || (out.status === 503 && typeof out.error === 'string' && out.error))) {
          extras = await extrasFor(tokenOfBody(body))
          if (extras) out = await sealedSend(extras)
        } else if (idWay && extras && out && out.status === 403 && /^pass: bound_unknown/.test(String(out.reason || ''))) {
          // the enclave had no word on this address's room passes (sync sweep 2026-11-16 #6): hints kept from before the cutoff, or
          // ended — fetched afresh past the cache and sent ONCE more (a refused request ran nothing); the refusal stands if none come
          const ex = await extrasFor(tokenOfBody(body), { fresh: true })
          if (ex && Array.isArray(ex.boundHints) && ex.boundHints.length) { extras = ex; out = await sealedSend(extras) }
        }
        // T#2: the enclave refused the envelope as stale and said its time — learn the offset and send it ONCE more, every seal
        // made again at the enclave's clock. Only when the offset moved (a stale envelope at the right clock is something else).
        if (out && out.error === 'envelope_stale' && noteServerClock(out.serverNow)) {
          const again = await resealBody(body)
          if (again) out = await sealedSend(extras, again)
        }
        if (idOnly && out && out.error === 'answer_unsealed') { asleepPlain.set(body.room, Date.now() + ASLEEP_PLAIN_MS); return plainNoId() }
        return out
      }
      // ⛔ A ROOM KEY GOES READABLE ONLY TO A ROOM KNOWN TO BE STANDARD (state machines pass 7, T#1): a device with no tier mark
      //   for a confidential room (restored, a joiner's link without enc=1, a protected device before its unlock, a lane in the
      //   negative cache) sent the key in the clear on its first keyed read or write, and learned the tier only from the answer.
      //   …and NOT KNOWN is not standard either (sync sweep 2026-11-11 #1): the probe failing (a store fault answers 503 tier_unknown,
      //   or no network) left 'unknown', and the key went readable anyway. Now it waits: a retryable refusal, nothing sent.
      if (!enc && body && typeof body.room === 'string') {
        const keyFor = async (room) => { const t = await tierOf(room); return t === 'enclave' ? tierRefusal(body) : t === 'unknown' ? tierUnknown() : null }
        if (typeof body.mk === 'string' && body.mk) { const no = await keyFor(body.room); if (no) return no }
        if (typeof body.bridgeMk === 'string' && body.bridgeMk && typeof body.bridgeRoom === 'string' && body.bridgeRoom) { const no = await keyFor(body.bridgeRoom); if (no) return no }
      }
      return call(endpoint, body, f)
    }
    let r = await send()
    // A KEYLESS REQUEST REFUSED AS CONFIDENTIAL (agent/tierGuard.mjs: `409 confidential_room` — the refused request ran nothing): this
    // device does not mark the Space as confidential, so it went to the standard tier. Noted, and sent ONCE more — to the enclave,
    // as every later one for that Space (the owner's devices, 2026-11-23: usage receipts for 43 confidential Spaces went to the
    // standard tier every run — 6,808 refusals in a day, and those Spaces' usage was never collected).
    if (r && r.error === 'confidential_room' && b0 && typeof b0.room === 'string' && !b0.enclave && !enclaveFor(b0.room) && PLAIN_OPS.has(b0.op) && keyless(b0)) {
      noteTier(b0.room, r)
      // the answer keeps saying the tier: a caller that learns from it (l1.js learnTier, through the key worker) still marks the Space
      if (learnedConfidential(b0)) { r = await send(); if (r && typeof r === 'object' && !r.tier) r = { ...r, tier: 'enclave' } }
    }
    // A SIGN-IN THAT NAMES NO APP where a room pass is required (docs/device-gate-design.md § 12.1: a token from before `asc`, a raw
    // Google one): renewed ONCE — the renewal names the app — and the request sent once more, never a loop and never a prompt.
    // (401 too: op `grant` answered every refusal 401 until the sync sweep of 2026-11-16 #7, and a Lambda not yet redeployed still does)
    const passRefused = (re) => !!(r && (r.status === 403 || r.status === 401) && re.test(String(r.reason || '')))
    if (renewSignIn && passRefused(/^pass: app_unnamed/)) {
      let fresh = null; try { fresh = await renewSignIn(b0) } catch { fresh = null }
      const nb = withSignIn(b0, fresh)
      if (nb) { b0 = nb; r = await send() }
    }
    // a pass that ended, or none where one is required now: a fresh one and ONE more try (a refused request ran nothing)
    if (roomPass && typeof roomPass.renew === 'function' && passRefused(/^pass: (pass_expired|pass_required)/)) { try { await roomPass.renew(b0) } catch { /* */ } r = await send() }
    // THE CLOCK (sync sweep 2026-11-16 #8): psig's ts was more than 2 minutes from the server's, which said its time — learned (the same
    // offset every seal uses, mkseal.js) and signed again ONCE. Only when the offset moved: a stale psig at the right clock is something else.
    if (roomPass && passRefused(/^pass: psig_stale/) && noteServerClock(r.serverNow)) r = await send()
    if (attested && r && r.error === 'attest_required' && typeof r.challenge === 'string') { attestReadRooms.set(b0.room, r.challenge); if (r.reason) attestReadWhy.set(b0.room, String(r.reason)); r = await send() }
    if (attested) noteReadChal(b0.room, r)
    return r
  }
  // THE TIER OF A ROOM THIS CLIENT HAS NOT MARKED (T#1 above): learned from any answer that says it (the front's tier hint, a
  // `confidential_room` refusal, a plain 200 of a key-free read), else asked ONCE with the keyless `policy` op — which the
  // front answers with `tier: 'enclave'` for a confidential room (agent/tierGuard.mjs) and which carries no key.
  const tierKnown = new Map() // room → 'standard' | 'enclave' | { until } (could not tell; asked again after TIER_RETRY_MS)
  const keyless = (x) => !(typeof x.mk === 'string' && x.mk) && !(typeof x.bridgeMk === 'string' && x.bridgeMk) && !x.userShare
  // a content-free request for a Space a refusal named confidential goes to the enclave (send, above) — keyed ones never: they wait for
  // the device's own mark (tierRefusal), as before
  const learnedConfidential = (x) => !!x && typeof x.room === 'string' && PLAIN_OPS.has(x.op) && keyless(x) && tierKnown.get(x.room) === 'enclave'
  const tierAsk = new Map() // room → the probe in flight
  const TIER_RETRY_MS = 10_000 // could not tell: keyed requests wait (tierUnknown), so ask again soon
  const noteTier = (room, r) => {
    if (!room || !r || tierKnown.get(room) === 'enclave') return
    // …and a Space the device's own list did not name is REPORTED (onConfidential; the page marks it — enclave.js markEnclaveRoom, durable
    // and mirrored to the hosted app's vault): the learning lived only in this client's memory, so every launch went to the standard
    // tier again (2026-11-23: one device's list lacked 43 confidential Spaces)
    if (r.tier === 'enclave' || r.error === 'confidential_room') { tierKnown.set(room, 'enclave'); if (!enclaveFor(room) && typeof onConfidential === 'function') { try { onConfidential(room) } catch { /* the next refusal reports it again */ } } }
    // the front's tier guard runs right before the room code and marks EVERY answer for a confidential room (agent/tierGuard.mjs
    // withTier, any status) — so the room's own answer with no tier is the guard saying "standard": a 200, or the room's gate
    // refusing the keyless probe (401/403, or need_identity in a 200 — a gated standard room). A fault (503 tier_unknown, other
    // 5xx, 429, no network) is not an answer about the tier: asked again soon, and the key waits meanwhile.
    else if (r.error !== 'tier_unknown' && (r.status === 200 || r.status === 401 || r.status === 403)) tierKnown.set(room, 'standard')
    else if (tierKnown.get(room) !== 'standard') tierKnown.set(room, { until: Date.now() + TIER_RETRY_MS })
  }
  const tierOf = async (room) => {
    if (enclaveFor(room)) return 'enclave'
    const k = tierKnown.get(room)
    if (k === 'standard' || k === 'enclave') return k
    if (k && k.until > Date.now()) return 'unknown'
    if (!tierAsk.has(room)) {
      tierAsk.set(room, (async () => {
        try { noteTier(room, await call(endpoint, { op: 'policy', room, ...(await authFor(room)) }, f)) } catch { noteTier(room, { status: 0 }) } finally { tierAsk.delete(room) }
      })())
    }
    await tierAsk.get(room)
    const v = tierKnown.get(room)
    return v === 'standard' || v === 'enclave' ? v : 'unknown'
  }
  // Nothing was sent. A read answers like the front's tier hint (an unchanged 200 that says the tier — the page marks the room
  // and re-reads it in the enclave); anything else like the front's own refusal, so every caller's existing path follows it.
  const TIER_READS = new Set(['poll', 'pollsealed'])
  const tierRefusal = (body) => TIER_READS.has(body.op)
    ? { status: 200, ok: true, changed: false, tier: 'enclave', ...(body.sinceEtag ? { etag: body.sinceEtag } : {}) }
    : { status: 409, ok: false, error: 'confidential_room', tier: 'enclave', reason: 'this Space is confidential: its requests go to the enclave — nothing was sent. Reopen the Space.' }
  const tierUnknown = () => ({ status: 503, ok: false, error: 'tier_unknown', retry: true, reason: 'could not tell yet whether this Space is confidential, so its key was not sent — trying again in a moment' })
  const ATTEST_OWN_OPS = new Set(['turn', 'policy', 'attest-accept'])
  const asleepPlain = new Map() // room → until when its sign-in-only sealed reads go plain without the sign-in (#4 above)
  const ASLEEP_PLAIN_MS = 20_000
  // The attested half of attestFor alone: a proof for a room known to need one, nothing for any other room.
  const readAttestFor = async (room) => {
    if (!attestReadRooms.has(room)) return {}
    try { const p = readAttestProvider(); const why = takeReadWhy(room); const att = p ? await p(room, { read: true, challenge: attestReadRooms.get(room), ...(why ? { refused: why } : {}) }) : null; return att && att.read ? { readAttestation: att.read } : {} } catch { return {} }
  }
  // For an EMAIL-gated room the SERVER gates every op — reads too — so attach the caller's cached Google identity
  // ({idToken, spk}) to read/other ops. `auth(room)` returns it (or null) without prompting; a non-gated room → {}.
  // `turn` is exempt: its caller passes the full email identity in `message`. Fail-open to {} so open rooms are unaffected.
  const authFor = async (room) => {
    if (!auth) return {}
    try { const a = await auth(room); return a && a.idToken && a.spk ? { idToken: a.idToken, spk: a.spk } : {} } catch { return {} }
  }
  // A request that opens ANOTHER room (a lane turn reading its shared room, a crossing into it, personal-agent links)
  // must pass THAT room's gate too (agent/spaceService.mjs otherRoomAdmits, 2026-10-02). A private lane is usually not
  // gated itself, so its own auth is {} — attach the member's sign-in for the first other room that has one. The
  // sign-in is bound to the device key, not to a room, so one identity proves the member wherever their email is listed.
  const otherAuth = async (rooms) => {
    for (const r of rooms) { if (!r) continue; const a = await authFor(r); if (a.idToken) return a }
    return {}
  }

  // KEY TRANSPORT. With a service public key configured (`mkPub`), every op that must carry the room key sends it
  // SEALED and bound to this exact request (room|op|ts|nonce) instead of in the clear — so a body-logging capture
  // yields ciphertext, and a captured body can't be replayed as another op or after the freshness window. Without
  // `mkPub` this is the identity function and the raw key is sent, exactly as before: the server accepts both, so an
  // old client and a new one work against the same deployment. See spaces/public/mkseal.js for the limits of the claim
  // — this hides the key from LOGS, not from the service.
  // TURN PROGRESS (docs/turn-progress.md): what the turn is doing right now — { phase:'thinking'|'writing' } or
  // { tool } — sealed like the reply text and opened the same way. Only a well-formed step is passed on; anything else
  // is dropped, never fatal, and never shown.
  const withTurnStatus = async (out, r, mk) => {
    if (typeof r.partialStatus !== 'string') return out
    try {
      const st = JSON.parse(await open(JSON.parse(r.partialStatus), { mk }))
      const ok = st && typeof st === 'object' && ((st.phase === 'thinking' || st.phase === 'writing' || st.phase === 'deciding') || (typeof st.tool === 'string' && /^[a-z0-9_]{1,64}$/.test(st.tool)))
      const since = Number.isFinite(st.since) ? { since: st.since } : {} // when the turn started (asyncTurn) — the seconds count from it
      return ok ? { ...out, partialStatus: { ...(st.tool ? { tool: st.tool } : { phase: st.phase }), ...since }, partialSeq: r.partialSeq || out.partialSeq || 0 } : out
    } catch { return out }
  }
  // ROOM STREAMS (docs/change-inbox.md § Room streams): a GATED room's poll that passed the gate brings the stream grants
  // — sealed under the room key when the request carried it, plain on a keyless read. Only well-formed ones pass on
  // (`streamGrants`); the page hands them to the stream client (roomStreamClient.js), which needs them AND the key.
  const withStreamGrants = async (out, r, mk) => {
    let g = Array.isArray(r.stream) ? r.stream : null
    if (typeof r.streamSealed === 'object' && r.streamSealed && mk) { try { g = JSON.parse(await open(r.streamSealed, { mk })) } catch { g = null } }
    const ok = Array.isArray(g) && g.length <= 4 && g.every((x) => x && Number.isInteger(x.e) && typeof x.g === 'string' && x.g.length <= 64)
    return ok ? { ...out, streamGrants: g.map((x) => ({ e: x.e, g: x.g })) } : out
  }
  // A SEAL CAN BE MADE AGAIN (state machines pass 7, T#2): a request refused `envelope_stale` (this device's clock is off the
  //   enclave's) is sent once more with the learned offset — and every field sealed inside it carries its own ts, checked
  //   too, so each is sealed again. Kept by nonce for a couple of minutes; a body holding a seal not kept here is not retried.
  const _reseal = new Map() // nonce → () => Promise<fields>
  const resealable = (nonce, again) => { _reseal.set(nonce, again); const t = setTimeout(() => _reseal.delete(nonce), 120_000); if (t && t.unref) t.unref() }
  const resealBody = async (body) => {
    if (!body || body.newMkSealed !== undefined || body.idSealed !== undefined) return null // bound to the key seal's own ts/nonce: not rebuilt here
    let out = { ...body }
    for (const [k, v] of Object.entries(body)) {
      if (!/Nonce$/.test(k) || typeof v !== 'string') continue
      const again = _reseal.get(v); if (!again) return null
      out = { ...out, ...(await again()) }
    }
    return out
  }
  const keyFields = async (room, op, mk) => {
    const pub = mkPubFor(room)
    if (enclaveFor(room) && !pub) throw new Error('enclave key unavailable for this room — refusing to send the room key to the relay')
    if (!pub || !mk) return { mk }
    try {
      const ts = sealNow() // the enclave's clock as far as known (mkseal.js, T#2)
      const nonce = newNonce()
      resealable(nonce, () => keyFields(room, op, mk))
      return { mkSealed: await sealMk(mk, pub, mkAad({ room, op, ts, nonce })), mkTs: ts, mkNonce: nonce }
    } catch (e) { if (enclaveFor(room)) throw e; return { mk } } // enclave room MUST seal; a normal room may fall back to the plain path
  }
  // A private-lane turn carries the SHARED room's key (bridgeMk) so the agent can observe it, and a mirror carries the
  // shared room's PLAINTEXT messages. For an enclave-tier lane both must be sealed to the enclave too — else the relay
  // would see the shared room's key/content even though the lane itself is sealed. Same fail-closed rule as keyFields.
  const sealField = async (room, aadOp, plaintext, base) => {
    const pub = mkPubFor(room)
    if (enclaveFor(room) && !pub) throw new Error('enclave key unavailable for this room — refusing to send bridged data to the relay')
    if (!pub) return null // not an enclave room → caller sends the field raw, unchanged
    const ts = sealNow(); const nonce = newNonce() // T#2: the enclave's clock as far as known
    resealable(nonce, () => sealField(room, aadOp, plaintext, base))
    // Field names MUST match what the enclave reads (infra/enclave/node/turn.mjs): `${base}Sealed`/`${base}Ts`/`${base}Nonce`.
    return { [`${base}Sealed`]: await sealMk(plaintext, pub, mkAad({ room, op: aadOp, ts, nonce })), [`${base}Ts`]: ts, [`${base}Nonce`]: nonce }
  }
  const bridgeFields = async (room, op, bridgeMk) => (await sealField(room, op + ':bridge', bridgeMk, 'bridgeMk')) || { bridgeMk }
  // The LINKED rooms' keys (a lane's setLinks) seal the same way, as one field (AAD op + ':links') — on a confidential room
  // they never cross the relay in the clear (2026-10-02; they used to, while bridgeMk was sealed).
  // A CONFIDENTIAL ROOM WHOSE ENCLAVE HOLDS NO CONFIG heals on first read (2026-10-03, the owner's trip room ran the
  // default assistant and showed empty instructions): its create-time seal into the enclave never landed. The standard
  // tier keeps a copy; fetch it WITHOUT the key (mk never goes to the standard tier for a confidential room), keep it
  // only if it opens with mk, and give it to the enclave as the room's first config. A gated copy is not served keyless,
  // so a gated room is not healed here. → { cfg, configSealed, saved } or null.
  const healEnclaveConfig = async (room, mk) => {
    if (!mk || !enclaveFor(room)) return null
    let s = null
    try { s = await call(endpoint, { op: 'policy', room }, f) } catch { return null }
    if (!s || typeof s.configSealed !== 'string' || !s.configSealed) return null
    let cfg = null
    try { cfg = JSON.parse(await open(JSON.parse(s.configSealed), { mk })) } catch { cfg = null }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
    let r = null
    try { r = await post({ op: 'config', room, ...(await keyFields(room, 'config', mk)), configSealed: s.configSealed, ...(await authFor(room)) }) } catch { r = null }
    return { cfg, configSealed: s.configSealed, saved: !!(r && r.status === 200) }
  }
  const policyPost = async (room, mk) => post({ op: 'policy', room, ...(mk ? await keyFields(room, 'policy', mk) : {}), ...(await authFor(room)) })
  const linksFields = async (room, op, links) => (await sealField(room, op + ':links', JSON.stringify(links), 'links')) || { links }

  // reconstruct mk from the pieces carried in a set of links (a share `#s=` each, or `#mk=` for solo)
  const mkFromLinks = async (links, config, commit) => {
    const pieces = (Array.isArray(links) ? links : [links]).map((l) => { const p = parseConfiguredLink(l); return p.share || p.mk }).filter(Boolean)
    return assembleConfiguredKey(pieces, config, commit)
  }

  // Rooms the server READ-gates (email admission): carry the SEALED mk on the otherwise-keyless reads (pollsealed/blob)
  // so the server can run the email gate. Learned from the config at create/open, plus a 401 gated_read_requires_key.
  const gatedRooms = new Set()
  // ⛔ RECOGNISE A REFUSAL BY ITS OWN CODE, NOT ONLY BY THE STATUS LINE (2026-09-29, a builder: an enclave-tier gated room
  // read back EMPTY). On the confidential tier the enclave's host front forwarded only the response BODY and answered
  // 200 for everything, so `gated_read_requires_key` arrived as a 200 and this client — which learned the gate only from a
  // 401 — never retried with the key. The error code survives every hop; the status line did not.
  const gatedRefusal = (r) => !!(r && r.reason === 'gated_read_requires_key' && (r.status === 401 || r.error === 'need_identity'))
  // A SEALED READ (pollsealed, blob) — WITHOUT THE ROOM KEY whenever it can be (regular rooms read sealed; step 2, the owner,
  // 2026-11-07: "Fix it"). A VERIFIED room's server checks the sign-in against its own sealed copy of the member list
  // (agent/gateCopy.mjs), so the key need not ride. It rides ONCE, sealed, only when: the read must prove it (proveKey — the
  // change inbox's registration); the server has no copy of the room's current list yet (gated_read_requires_key — that keyed
  // read writes one); or the sign-in was refused (a member removed in place hears stale_key only from the key, and goes for
  // its grant as before). A CONFIDENTIAL verified room keeps sending it, sealed to its attested enclave.
  // `sent.keyed` (when given) is set when the key rode — pollSealed then knows a 422 was already asked WITH the key.
  const sealedRead = async (room, mk, op, fields, { proveKey = false, sent = null } = {}) => {
    // the enclave ASLEEP with no attested key here: the keyed retry cannot go (keyFields fails closed) — it threw, the poll swallowed
    // it and no banner showed until a wake (sync sweep 11-08/11-09). Answer what it is instead: the enclave is starting, nothing sent.
    const keyed = async () => { if (enclaveFor(room) && !mkPubFor(room)) return { status: 503, ok: false, error: 'enclave_warming', retry: true, reason: 'this confidential Space\'s enclave is asleep — nothing was sent' }; if (sent) sent.keyed = true; const k = await post({ op, room, ...fields, ...(await keyFields(room, op, mk)), ...(await authFor(room)), ...(await attestFor(room)) }); if (k && k.status === 200) keyedOk.add(room); return k }
    if (mk && (proveKey || (gatedRooms.has(room) && (enclaveFor(room) || keyFirstNow(room))))) return keyed()
    const r = await post({ op, room, ...fields, ...(await authFor(room)), ...(await attestFor(room)) })
    if (!enclaveFor(room)) noteTier(room, r) // a key-free read that says the tier (or answers a plain 200) spares the probe
    if (!mk) return r
    if (gatedRefusal(r)) {
      // AN OWNER-GOVERNED verified room (sweep 11-07 #5): its server never reads the gate copy (its sealed owner policy opens only
      // with the key — agent/spaceRoom.mjs), so every key-free read was refused and sent again. Refused key-free right after a
      // keyed read WORKED (which writes an ordinary room's copy) = such a room: the key rides up front for a while, then one
      // key-free read asks again (a changed room's copy is written by that keyed read).
      if (gatedRooms.has(room) && keyedOk.has(room)) keyFirst.set(room, Date.now() + KEY_FIRST_MS)
      gatedRooms.add(room); return keyed()
    }
    // refused for the sign-in: a member REMOVED in place hears stale_key only from the key (sweep 11-07 #1: also for a room this
    // client never learned was gated — a key-free read is refused that way only by a verified room's gate)
    if (r && (r.status === 403 || r.status === 200) && r.error === 'not_authorized') { gatedRooms.add(room); return keyed() }
    return r
  }
  const keyedOk = new Set() // rooms whose keyed sealed read was served (their gate copy, if any, is written)
  const keyFirst = new Map() // room → until when its reads carry the key up front (an owner-governed verified room)
  const KEY_FIRST_MS = 10 * 60_000
  const keyFirstNow = (room) => { const t = keyFirst.get(room); return t === Infinity || (typeof t === 'number' && Date.now() < t) }
  const verifiedRefusal = (r) => !!(r && r.error === 'no_verified_client' && (r.status === 403 || r.status === 200))

  // Rooms that require a VERIFIED CLIENT: attach a client-release attestation to the material reads. Learned at create
  // (config.requireVerifiedClient) or LAZILY from a 403 no_verified_client — mirrors gatedRooms/gated_read_requires_key.
  const verifiedRooms = new Set()
  // ATTESTED READS: a room that answered `attest_required` is learned here with the
  // challenge it sent; every later read of it carries a fresh proof over the newest challenge it handed back.
  const attestReadRooms = new Map() // room → the newest challenge
  // room → why its last attested read was refused, handed to the provider ONCE with the retry (the app sends Play Integrity's token
  // at once on `integrity_required` — deviceAttest.js integrityDueFor; 2026-11-20)
  const attestReadWhy = new Map()
  const takeReadWhy = (room) => { const w = attestReadWhy.get(room); attestReadWhy.delete(room); return w }
  const noteReadChal = (room, r) => { if (attestReadRooms.has(room) && r && typeof r.challenge === 'string' && r.challenge) attestReadRooms.set(room, r.challenge) }
  const attestFor = async (room) => {
    if (attestReadRooms.has(room)) {
      try { const p = readAttestProvider(); const why = takeReadWhy(room); const att = p ? await p(room, { read: true, challenge: attestReadRooms.get(room), ...(why ? { refused: why } : {}) }) : null; return att && att.read ? { readAttestation: att.read } : {} } catch { return {} }
    }
    if (!verifiedRooms.has(room)) return {}
    try { const p = attestProvider(); const att = p ? await p(room) : null; return att ? { clientAttestation: att } : {} } catch { return {} }
  }
  // Run a material-read post; on a 403 no_verified_client for a room we didn't yet know was verified, learn it and retry
  // once — the retry's attestFor now yields the attestation. `doPost` rebuilds the body each call (so the attestation is
  // picked up on the retry). Fail-closed: with no provider the retry still 403s and the caller sees the withheld read.
  const withVerified = async (room, doPost) => {
    let r = await doPost()
    if (verifiedRefusal(r) && !verifiedRooms.has(room)) { verifiedRooms.add(room); r = await doPost() }
    if (r && r.error === 'attest_required' && typeof r.challenge === 'string') { attestReadRooms.set(room, r.challenge); if (r.reason) attestReadWhy.set(room, String(r.reason)); r = await doPost() } // an attested read: sign the challenge it sent, once
    noteReadChal(room, r)
    return r
  }

  // A ROOM RE-KEYED IN PLACE (docs/key-rotation-design.md § (b)): what was written before the rotation is sealed under an
  // EARLIER key, which the room's config — sealed under the current key — carries (`keyChain`). A box the current key does
  // not open is tried with those, newest first. The chain is read once per room and key, and only when a box needs it.
  const chains = new Map() // room|commit-prefix of the key → the older keys
  const chainFor = async (room, mk) => {
    const k = room + '|' + String(mk).slice(0, 12)
    if (chains.has(k)) return chains.get(k)
    let keys = [], known = false
    try {
      const r = await policyPost(room, mk)
      const cfg = r && r.status === 200 && r.configSealed ? JSON.parse((await open(JSON.parse(r.configSealed), { mk })) || 'null') : null
      if (cfg && typeof cfg === 'object') { known = true; if (Array.isArray(cfg.keyChain)) keys = cfg.keyChain.filter((x) => x && typeof x.key === 'string' && x.key && x.key !== mk).map((x) => x.key).reverse() }
    } catch { keys = [] }
    // only a DEFINITIVE read is kept — a failed one (the enclave asleep, a network fault) cached "no older keys" for the session,
    // and the history before an in-place change stayed unreadable until a reload (sweep 10-23 #19)
    if (known) chains.set(k, keys)
    return keys
  }
  const openAny = async (room, env, mk, aad = null) => {
    const pt = await open(env, { mk, aad })
    if (pt != null || !room || !mk) return pt
    for (const k of await chainFor(room, mk)) { const o = await open(env, { mk: k, aad }); if (o != null) return o }
    return null
  }

  // ONE DECODER for a sealed poll answer (the v3 per-entry wrapper, or a whole v1/v2 blob): pollSealed runs it on the
  // network's answer, and the L1 worker runs it on an answer the service worker PREFETCHED when the push arrived
  // (prefetchPoll.js) — so a room opened from a notification shows the new message without waiting for a round trip.
  const decodeSealed = async (room, mk, sinceCount, r) => {
    const withPartial = async (o) => {
      let out = o || {}
      // WITBITZ REMOVED these messages (agent/moderation.mjs; docs/report-and-block.md §5): ids and times, plaintext, on every answer
      if (Array.isArray(r.removed)) out = { ...out, removed: r.removed.filter((x) => x && x.id != null && x.ts != null).slice(0, 500).map((x) => ({ id: String(x.id), ts: Number(x.ts) })) }
      // Both the in-progress reply (partial) AND a parked device-call ride EVERY response (from `r`); open them here so
      // every return path carries them, whichever object it built.
      if (typeof r.partial === 'string') { try { out = { ...out, partialText: await open(JSON.parse(r.partial), { mk }), partialSeq: r.partialSeq || 0 } } catch { /* unopenable partial dropped, never fatal */ } }
      out = await withTurnStatus(out, r, mk)
      out = await withStreamGrants(out, r, mk)
      if (typeof r.deviceCall === 'string') { try { out = { ...out, deviceCall: JSON.parse(await open(JSON.parse(r.deviceCall), { mk })), deviceCallSeq: r.deviceCallSeq || 0 } } catch { /* unopenable device-call → ignore */ } }
      return out
    }
    if (r.status !== 200 || !r.changed) return await withPartial(r) // 403 gate / 404 / unchanged → pass through untouched
    // v3 per-entry ledger (agent/spaceLedgerV3.mjs): r.sealed is a PLAINTEXT wrapper { v:3, boxes:[sealed…] } the server
    // ALREADY sliced to boxes[sinceCount:] — open each box individually; r.count is the new total (our next sinceCount).
    // Distinguished by the `boxes` array (a whole-blob envelope has no `boxes`), so v1/v2 fall through to the path below.
    let wrap = null
    try { wrap = JSON.parse(r.sealed) } catch { wrap = null }
    if (wrap && wrap.v === 3 && Array.isArray(wrap.boxes)) {
      const entries = []
      // M4: the server sliced to boxes[sinceCount:], so box j is at ABSOLUTE index base+j — the aad a bound box needs.
      // wrap.from (sliceRawV3) is authoritative when present; else it's exactly sinceCount. A legacy box ignores the aad.
      const base = Number.isInteger(wrap.from) ? wrap.from : sinceCount
      let unopenable = 0
      for (let j = 0; j < wrap.boxes.length; j++) {
        // open() answers NULL for a wrong key (it never throws) — and JSON.parse(null) is null, so this used to push a null
        // ENTRY per box and report "N entries": a blank room, a green badge, no banner (the owner's screenshot, 2026-10-03).
        try { const pt = await openAny(room, JSON.parse(wrap.boxes[j]), mk, ledgerAad(room, base + j)); if (pt == null) { unopenable++; continue } entries.push(JSON.parse(pt)) } catch { unopenable++ /* skip an unopenable box, keep the rest */ }
      }
      // EVERY box refused = this is not an empty room, it is the WRONG KEY (the owner's screenshot, 2026-10-03: a confidential
      // room with ten entries drawn as a blank page under a green ENCLAVE badge — the content-blind read swallowed each
      // box and answered "nothing new"). Say so, the way the server's own path does: 422 lifts the couldn't-unlock banner.
      if (wrap.boxes.length && !entries.length && unopenable === wrap.boxes.length) return await withPartial({ status: 422, etag: r.etag, changed: true, reason: 'undecodable', boxes: wrap.boxes.length, challenge: r.challenge })
      const total = Number.isInteger(r.count) ? r.count : sinceCount + entries.length
      // `done` — entries that have been through a COMPLETED turn (agent/spaceLedgerV3.mjs). Plaintext on the
      // wrapper, so it costs no key. A turn the agent answers with SILENCE appends nothing, so this
      // advancing is the ONLY event it produces, and it is what lets a peer stop showing "thinking".
      // `more`: another page follows from `version` (ledgerView.readAllPages; sync sweep, 2026-10-10)
      return await withPartial({ status: 200, etag: r.etag, changed: true, version: total, entries, ...(r.more ? { more: true } : {}), challenge: r.challenge, done: r.done, partial: r.partial, partialSeq: r.partialSeq, boxes: wrap.boxes.length, ...(unopenable ? { refused: unopenable } : {}) })
    }
    let all = null
    try { all = JSON.parse(await openAny(room, JSON.parse(r.sealed), mk)) } catch { all = null }
    // LEDGER FORMAT (agent/sessionStore.mjs): v1 is a bare array — everything written to date. v2+ is
    // { v, entries }. Accepting both HERE, before anything writes v2, is what makes that change possible
    // later: this runs in the browser behind a service worker, so a client that cannot read v2 lingers in
    // the field for days after the server flips. Reader-first, always.
    if (all && !Array.isArray(all) && Array.isArray(all.entries)) all = all.entries
    if (!Array.isArray(all)) return { status: 422, etag: r.etag, changed: true, reason: 'undecodable', challenge: r.challenge }
    const from = Number.isInteger(sinceCount) && sinceCount > 0 ? Math.min(sinceCount, all.length) : 0
    return await withPartial({ status: 200, etag: r.etag, changed: true, version: all.length, entries: all.slice(from), challenge: r.challenge, partial: r.partial, partialSeq: r.partialSeq })
  }
  const api = {
    _openAny: openAny, // internal: a box opened with the room's key or, after an in-place change, an earlier one (tests)
    /** Mint a Space from a config, register its PUBLIC record (commit + config) with the server, and return
     *  { room, mk, commit, links, keyModel }. `mk` is reconstructed locally from the minted pieces — it is NEVER sent
     *  to the server (only its commitment is). The `links` are what you hand to members. */
    async create(config = {}, { base = originBase(), gk, enclave: enclaveOpt, split = false, via = null, lapseDays } = {}) {
      const space = await createConfiguredSpace(config, { base })
      const mk = await mkFromLinks(space.links, config, space.commit)
      // Prepare the email allow-list for sealing. Co-members hold mk and can decrypt the config, so HIDDEN addresses are
      // stored as OPAQUE room-bound memberHash values (salted by the room id, kibitz-compatible); the server gate hashes
      // the verified email the same way. ADVERTISED addresses stay plaintext in `emails` (the gate already matches those)
      // so co-members can see who's on the list. Domains stay plaintext (a domain isn't a person). `allow` doesn't feed
      // mk/commit and the room id exists now (space.room), so transforming it here is safe.
      if (config && config.admission === 'email' && config.allow) {
        const a = config.allow
        const dom = Array.isArray(a.domains) ? a.domains.filter(Boolean) : []
        // @usernames (the owner, 2026-10-11: "The allow list should only be by email. The username is just for the other
        // users … just a redirect"): an @username is resolved ONCE, at invite, to its account's HANDLE — a server-keyed hash
        // of the email — and the list stores only a room-bound hash of it, like a hidden email. No username is stored, and
        // nothing matches or moves by one. `handles` = such entries (a legacy room's advertised { handle } carried by a move).
        const handles = (Array.isArray(a.handles) ? a.handles : []).filter((h) => typeof h === 'string' && h)
        const hashOf = async (list) => { const mh = []; for (const em of (list || [])) { const h = await memberHash(em, space.room); if (h && !mh.includes(h)) mh.push(h) } return mh }
        const shown = Array.isArray(a.hidden) ? (Array.isArray(a.emails) ? a.emails : []).filter(Boolean) : [] // show-aware: `emails` = ADVERTISED (plaintext), `hidden` = HIDDEN
        const toHash = [...(Array.isArray(a.hidden) ? a.hidden : (Array.isArray(a.emails) ? a.emails : [])), ...handles] // no show info → every email hashed: private by default
        const mh = await hashOf(toHash)
        // ★ @USERNAMES AS TAGS (docs/spaces-usernames.md §12, 2026-10-20): `tagUsers` = the names the creator added; each is
        //   stored as the server's tag for THIS room — bound to the account like a handle hash, but no guessed email can be
        //   compared with it. A name that does not tag refuses the create: a person must never silently drop off the list.
        for (const u of (Array.isArray(a.tagUsers) ? a.tagUsers : [])) {
          const r = await post({ op: 'user', mode: 'tag', username: u, room: space.room })
          if (!r || r.status !== 200 || typeof r.tag !== 'string' || !r.tag) throw Object.assign(new Error('@' + u + ' could not be added (' + ((r && (r.error || r.status)) || 'no answer') + ')'), { status: (r && r.status) || 0, code: 'user_tag' })
          if (!mh.includes(r.tag)) mh.push(r.tag)
        }
        if (shown.length || mh.length || dom.length) config = { ...config, allow: { ...(shown.length ? { emails: shown } : {}), ...(mh.length ? { mh } : {}), ...(dom.length ? { domains: dom } : {}) } }
      }
      // AN ATTESTED ROOM (`requireApp: 'app'` — the Witbitz app on iPhone, Android or Mac): Witbitz's own owner key signs a policy
      // requiring that app and a room-auth for THIS room id (op 'owner-policy') — sealed into the config, sent with the create.
      // (Retired 2026-11-22, "We dont need any emulation rooms": the Witbitz-served level `served` / `emulated` and a builder's own
      // signed rule, `ownerFor` — a web page vouching for itself.)
      let ownerFields = {}
      if (config && (config.requireApp === 'served' || config.requireApp === 'emulated' || typeof config.ownerFor === 'function')) throw Object.assign(new Error('a Space only a web page served as an app may use is retired — attested Spaces are made in the Witbitz app on iPhone, Android or Mac'), { status: 410, code: 'level_retired' })
      if (config && (config.requireApp === 'android' || config.requireApp === 'app' || config.requireApp === 'windows')) { // app: the Witbitz app on iPhone, Android or Mac (2026-11-19; a 'windows' ask is refused by the server now) // windows: the Windows app's TPM key (docs/windows-attestation.md) // android: the native app (agent/witbitzOwnerPolicy.mjs) // emulated: the emulated attested room (docs/emulated-attested-rooms.md)
        // CONFIDENTIAL + ATTESTED (docs/confidential-attested-rooms.md): the enclave verifies the app level itself (it checks the signed
        // rule at create and the relayed device evidence on every read).
        // windows in a CONFIDENTIAL room (the owner, 2026-11-09: "do confidential rooms"): the enclave trusts the Windows key by its OWN
        // activation of it (agent/winActivation.mjs) — deviceAttest.js runs that once, before the first confidential proof
        const g = await post({ op: 'owner-policy', room: space.room, level: config.requireApp })
        if (!g || g.status !== 200 || !g.ownerPolicy || !g.roomAuth) throw Object.assign(new Error('the Witbitz app requirement could not be set (' + ((g && (g.error || g.status)) || 'no answer') + ')'), { status: (g && g.status) || 503 })
        const { requireApp: _r, requireAppId: _ra, attestAccept: acc, ...rest } = config // attestAccept: the versions it takes — the record's, not the sealed config's
        config = { ...rest, ownerPolicy: g.ownerPolicy }
        ownerFields = { ownerPolicy: g.ownerPolicy, roomAuth: g.roomAuth, ...(acc ? { attestAccept: acc } : {}) }
      }
      // `gk` (the room invite PUBLIC key, JWK) is registered so per-member turns can be attribution-verified in-render.
      // Public → storing it doesn't dent blindness. Omit → the Space stays capability-only (unsigned turns).
      const configSealed = await sealConfig(config, mk)
      // SPLIT (docs/sdk-split-key.md): mk = userShare ⊕ appShare. The RAW app half rides this create once; the server seals
      // it under the page's tenant's K_eco (platform custody) and never stores it in the clear. userShare goes back to the
      // caller for the room's #us= link and is never sent.
      const sp = split ? splitKey(mk) : null
      // `via` (2026-10-02): a BUILDER-HOSTED app-half function. The create goes to the builder's own function, which seals
      // the half under ITS K_eco and registers the room through the tenant door with its tenant key — the same path our
      // vault's /api/appshare takes. Witbitz then stores a half it cannot open. Absent ⇒ this endpoint, as before.
      const send = typeof via === 'function' ? via : post
      const dc = typeof delCommit === 'function' ? await delCommit(space.room).catch(() => null) : null // only the creating account can later delete this room (docs/user-erasure.md)
      const r = await send({ op: 'create', ...(app ? { app } : {}), room: space.room, commit: space.commit, configSealed, invite: invitePad(), ...(Number.isInteger(lapseDays) && lapseDays >= 1 && lapseDays <= 7 ? { lapseDays } : {}) /* a temporary room kept days after its last question (docs/visitor-limits.md) — beside the sealed config, never in it */, ...ownerFields, ...(dc ? { delCommit: dc } : {}), ...(sp ? { appShare: sp.shareB } : {}), ...embedAttribution(), ...tenantHint, ...(config.admission === 'email' ? { gated: true } : {}), ...(config.requireVerifiedClient ? { requireVerifiedClient: true } : {}), ...(gk ? { gk } : {}), ...(enclaveOpt ? { enclave: true } : {}), ...(config.help === true && config.install === true ? { installHelp: true } : {}) }) // installHelp: the front marks the room's record — its turns get the front's ticket (docs/install-help.md)
      if (r.status !== 200) throw Object.assign(new Error(`create failed: ${r.status} ${r.error || ''}${r.reason ? ' — ' + r.reason : ''}`), { status: r.status, ...(r.error ? { code: String(r.error) } : {}), ...(r.reason ? { reason: r.reason } : {}) }) // the server's code on the error (config_too_large, tenant_required, …) — sync sweep, 2026-10-10
      if (config.admission === 'email') { gatedRooms.add(space.room); if (config.ownerPolicy) keyFirst.set(space.room, Infinity) } // owner-governed: its reads carry the key (sweep 11-07 #5)
      if (config.requireVerifiedClient) verifiedRooms.add(space.room)
      // ⚑ configSealed rides back so an ENCLAVE-tier caller can hand the SAME sealed config to the enclave's own store
      // before the first turn (the enclave keeps only the mk-commitment otherwise, and the turn falls back to a default
      // agent). The app does this inline; the SDK needs it too, and re-sealing outside would be a second source of truth.
      // `enclaveCreated`: the CONFIDENTIAL create was answered `created: true` — by the enclave, whose create keeps configSealed in
      // the room's record (agent/spaceRoom.mjs). The SDK then skips handing it over a second time (witbitz-sdk _encSealConfig).
      return { room: space.room, mk, commit: space.commit, links: space.links, keyModel: space.keyModel, configSealed, ...(sp ? { userShare: sp.shareA } : {}), ...(enclaveOpt && r.created === true ? { enclaveCreated: true } : {}) }
    },
    /** The app half of a SPLIT room, for a page on an origin the room's tenant declared (op:'appshare-page'). → { status, appShare, commit } */
    appSharePage: async (room) => post({ op: 'appshare-page', room }),

    /** Open a Space from the member link(s) this client actually holds → { room, mk }. `mk` is null below the key
     *  threshold (e.g. one partner's link alone in a 2-of-2 Space — the other share must be combined first). */
    async open(links, config = {}, commit) {
      const arr = Array.isArray(links) ? links : [links]
      const room = parseConfiguredLink(arr[0] || '').room
      if (config && config.admission === 'email' && room) gatedRooms.add(room)
      return { room, mk: await mkFromLinks(arr, config, commit) }
    },

    // ── 2-of-2 (couple), async code-sealed handshake ──────────────────────────────────────────────────────────────
    /** Create a 2-of-2 Space. Returns { room, mk, partnerLink, code, commit }. The creator holds `mk`; hand the partner
     *  `partnerLink` (their share) + `code` (out of band). shareA is SEALED under the code and registered as the room's
     *  invite — the server only ever stores ciphertext. */
    async createCouple(config = {}, { base = originBase(), gk } = {}) {
      const cfg = { ...config, keyModel: '2-of-2' }
      const space = await createConfiguredSpace(cfg, { base })
      const shareA = parseConfiguredLink(space.links[0]).share
      const partnerLink = space.links[1]
      const code = newCode()
      const invite = await sealUnderCode(shareA, code)
      const mk = await assembleConfiguredKey([shareA, parseConfiguredLink(partnerLink).share], cfg, space.commit)
      const r = await post({ op: 'create', ...(app ? { app } : {}), ...tenantHint, room: space.room, commit: space.commit, invite, configSealed: await sealConfig(config, mk), ...(gk ? { gk } : {}) })
      if (r.status !== 200) throw Object.assign(new Error(`create failed: ${r.status} ${r.error || ''}${r.reason ? ' — ' + r.reason : ''}`), { status: r.status, ...(r.error ? { code: String(r.error) } : {}), ...(r.reason ? { reason: r.reason } : {}) }) // the server's code on the error (config_too_large, tenant_required, …) — sync sweep, 2026-10-10
      return { room: space.room, mk, partnerLink, code, commit: space.commit }
    },

    /** Join a 2-of-2 Space from a partner's share-link + the code → { room, mk }. Fetches the sealed shareA, unseals it
     *  with the code, and combines with this link's share. `mk` is null on a wrong code or a commitment mismatch. */
    async joinWithCode(link, code) {
      const p = parseConfiguredLink(link)
      if (!p.room || !p.share) return { room: p.room || '', mk: null, error: 'bad_link' }
      const r = await post({ op: 'invite', room: p.room })
      if (r.status !== 200 || !r.invite) return { room: p.room, mk: null, error: 'no_invite' }
      const shareA = await openUnderCode(r.invite, code)
      if (!shareA) return { room: p.room, mk: null, error: 'bad_code' }
      const mk = await assembleConfiguredKey([shareA, p.share], { keyModel: '2-of-2' }, r.mkCommit)
      return { room: p.room, mk, error: mk ? undefined : 'mismatch' }
    },

    /** Post a turn. `identity` SIGNS it (the entry is signed over its core; the server verifies in-render). Two shapes:
     *   • EMAIL gate: `{ email, sign:{priv,pub}, googleIdToken }` → sends `{ from:email, ts, id, kind, sig, spk, idToken }`.
     *     The Google token proves the email (bound to `spk` via its nonce); the server checks it against the sealed
     *     allow-list and DISCARDS it.
     *   • INVITE gate: `{ name, sign:{priv}, grant }` → sends `{ from:name, ts, id, kind, sig, grant }` (Kibitz invite).
     *   • ATTESTED-ROOM KEY: `{ name, sign:{priv,pub}, attestKey:true }` → sends `{ from:name, ts, id, kind, sig, spk }` — a
     *     member who joined an attested room through its box holds no grant; the server checks the signature against `spk`.
     *  Omit `identity` → an unsigned turn (open/legacy rooms), unchanged.
     *  `bridgeMk` (private-lane turns only, docs/spaces-private-lane.md): the SHARED room's key, so the runtime can
     *  fold the shared negotiation into the agent's context (it OBSERVES the shared room). Ignored by normal rooms. */
    // ONE SIGN-IN PER TURN (2026-11-21): a lane's turn whose message carries its own sign-in sends no second one for the Space it
    // reads (otherAuth) — the server checks the shared room with the message's (spaceService otherRoomAdmits: req.idToken ||
    // m.idToken), and the room pass's psig binds ONE sign-in key: with two (one per room) it covered the top-level one while the
    // turn was checked with the message's, and every first message in a private assistant of a verified group was refused
    // `pass: psig_signature` ("Your sign-in expired").
    async turn(room, mk, message, identity, { bridgeMk, bridgeRoom, mode, links, context, instructions, clientTools, clientGuidance, call, stopKey, model, receipt, showPrompt, run, schema } = {}) {
      let m = message
      const text = String((message && message.text) || '')
      if (identity && identity.googleIdToken && identity.sign && identity.sign.priv && identity.sign.pub) {
        const ts = Date.now()
        const id = `c:${ts}:${Math.random().toString(36).slice(2, 8)}`
        const { sig } = await signEntry(identity.sign.priv, { room, author: identity.email, ts, kind: 'text', id, text, ...(message && message.chal ? { chal: message.chal } : {}) }) // chal: the room's fresh challenge rides in the signed core when the turn carries one (deviceAttest.js; the server folds it the same way)
        m = { ...message, from: identity.email, ts, id, kind: 'text', sig, spk: identity.sign.pub, idToken: identity.googleIdToken }
      } else if (identity && identity.grant && identity.sign && identity.sign.priv) {
        const ts = Date.now()
        const id = `c:${ts}:${Math.random().toString(36).slice(2, 8)}` // client nonce → the signed core's id (anti-replay)
        const { sig } = await signEntry(identity.sign.priv, { room, author: identity.name, ts, kind: 'text', id, text, ...(message && message.chal ? { chal: message.chal } : {}) })
        m = { ...message, from: identity.name, ts, id, kind: 'text', sig, grant: identity.grant }
      } else if (identity && identity.attestKey === true && identity.sign && identity.sign.priv && identity.sign.pub) {
        const ts = Date.now()
        const id = `c:${ts}:${Math.random().toString(36).slice(2, 8)}`
        const { sig } = await signEntry(identity.sign.priv, { room, author: identity.name, ts, kind: 'text', id, text, ...(message && message.chal ? { chal: message.chal } : {}) })
        m = { ...message, from: identity.name, ts, id, kind: 'text', sig, spk: identity.sign.pub }
      }
      return post({ op: 'turn', room, ...(await keyFields(room, 'turn', mk)), message: m, ...(pushSelf() ? { pushSelf: pushSelf() } : {}), ...(await pushAcctField(room)), ...(bridgeMk ? await bridgeFields(room, 'turn', bridgeMk) : {}), ...(bridgeRoom ? { bridgeRoom } : {}), ...(m && m.idToken ? {} : await otherAuth([bridgeRoom, ...(Array.isArray(links) ? links.map((l) => l && l.room) : [])])), ...(mode ? { mode } : {}), ...(Array.isArray(links) && links.length ? await linksFields(room, 'turn', links) : {}), ...(context ? { context } : {}), ...(instructions ? { instructions: String(instructions) } : {}), ...(Array.isArray(clientTools) && clientTools.length ? { clientTools } : {}), ...(clientGuidance ? { clientGuidance } : {}), ...(call ? { call: 1 } : {}), ...(stopKey ? { stopKey } : {}), ...(model ? { model } : {}), ...(receipt && receipt.drop ? { receipt } : {}), ...(showPrompt === true ? { showPrompt: true } : {}), ...(run === true ? { run: true } : {}), ...(run === true && schema ? { schema } : {}) }) // model: the composer's per-room pick ({catalog, wire}), taken over the create-time model server-side // clientTools/clientGuidance: the device's on-device tools for this turn (calendar, …); call:1 flags a "started a call" turn so the room tickle opens the meeting link; stopKey: the prompter's per-turn cancel nonce (op:'stop' matches it — docs/spaces-stop-turn.md)
    },
    // USAGE RECEIPTS (docs/usage-receipts.md): this account's sealed receipts in a room, at its per-room drop, and the trim
    // once they are folded into the account's sidecar. Keyless: the drop is the capability; every box is sealed to us.
    receipts: async (room, drop, since = 0) => post({ op: 'receipts', room, drop, sinceCount: since }),
    receiptsAck: async (room, drop, upTo) => post({ op: 'receiptsack', room, drop, upTo }),
    // STRAY NOTIFICATIONS (strayPush.js, agent/pushDrop.mjs): this device has no key for the room; ask for its own push
    // address to come off the room's list. Keyless — the address is the capability, and only its hash is kept.
    pushDrop: async (room, subscription) => post({ op: 'pushdrop', room, subscription: { endpoint: subscription && subscription.endpoint } }),
    // MEMBERSHIP MARK (docs/user-erasure.md § Authority): this account opened the room — a creator's delete then sees it was shared
    mark: async (room, mk, drop) => post({ op: 'mark', room, ...(await keyFields(room, 'mark', mk)), drop, ...(await authFor(room)) }),
    /** LEAVE A VERIFIED ROOM (agent/roomLeave.mjs): hands over this account's marks ({drops}) and delete secrets ({dels}) → { status, left, last, drops?, dels? } — `last`: no one who joined is left, delete it with what came back. */
    leave: async (room, mk, leave) => post({ op: 'leave', room, ...(await keyFields(room, 'leave', mk)), leave: { drops: [...((leave && leave.drops) || [])].slice(0, 16), dels: [...((leave && leave.dels) || [])].slice(0, 8) }, ...(await authFor(room)) }),
    // Seed the Space from a PUBLIC ChatGPT share link → continue a one-on-one chat together. The Lambda fetches +
    // parses it (SSRF-guarded) and seals the history into the ledger; the URL is public so this carries no secret.
    importChat: async (room, mk, chatgptUrl) => post({ op: 'import', room, ...(await keyFields(room, 'import', mk)), chatgptUrl, ...(await authFor(room)) }),
    importWhatsApp: async (room, mk, whatsappText) => post({ op: 'import', room, ...(await keyFields(room, 'import', mk)), whatsappText, ...(await authFor(room)) }), // WhatsApp export: client unzipped the _chat.txt → server parses + seals
    // MIRROR — append entries this device copied from a LINKED room (docs/spaces-private-lane.md) into THIS room's ledger,
    // no agent turn. Deduped by entry id server-side. Files/images ride along so the assistant reads them natively.
    mirror: async (room, mk, entries) => {
      const kf = await keyFields(room, 'mirror', mk) // fail-closed for an enclave room with no key
      // Enclave lane → seal the shared room's plaintext messages to the enclave; otherwise send them as before.
      const ef = enclaveFor(room) ? await sealField(room, 'mirror:entries', JSON.stringify(entries || []), 'mirror') : { entries }
      return post({ op: 'mirror', room, ...kf, ...ef, ...(await authFor(room)) })
    },
    // CARRY — a verified room's MOVE: the SERVER copies the old room's history into this one (minted with forkedFrom = that
    // room), keeping each entry's verified mark as `carried` (agent/spaceService.mjs op 'carry'). One page per call → { carried,
    // next, total }; loop while `next` is a number. The old room's key rides like a lane's bridge key: sealed to the
    // enclave on a confidential room (AAD op 'carry:bridge'), and filled in by the room worker when only bridgeRoom is given.
    carry: async (room, mk, { bridgeRoom, bridgeMk, cursor = 0 } = {}) => post({ op: 'carry', room, ...(await keyFields(room, 'carry', mk)), ...(bridgeMk ? await bridgeFields(room, 'carry', bridgeMk) : {}), bridgeRoom, ...(Number.isInteger(cursor) && cursor > 0 ? { sinceCount: cursor } : {}), ...(await authFor(room)) }),
    // Generate (or fetch) a real one-line conversation title, sealed to the room so both members share it.
    // `set` = { title, by }: a member RENAMES the room — the server appends it to the room's log (spaces/public/roomName.js).
    title: async (room, mk, recheck, set) => post({ op: 'title', room, ...(await keyFields(room, 'title', mk)), ...(recheck ? { recheck: true } : {}), ...(set && set.title ? { set: String(set.title), ...(set.by ? { by: String(set.by).slice(0, 80) } : {}), ...(pushSelf() ? { pushSelf: pushSelf() } : {}), ...(await pushAcctField(room)) } : {}), ...(await authFor(room)) }),
    // The DEFAULT loop. Opens the in-progress reply the same way pollSealed does — the server passes it through
    // sealed on both paths, so the two stay drop-in interchangeable mid-session.
    decodeSealed,
    poll: async (room, mk, sinceEtag, sinceCount = 0, opts = {}) => {
      // opts.changeInbox — THE CHANGE INBOX (docs/change-inbox.md): this device's inbox id rides the room's first poll of a
      // session, and the server follows the room for it only if this poll succeeds and proves the key. Plain, outside
      // the sealed fields — a confidential room's relaying Lambda needs it, and it names no content.
      const ci = opts && typeof opts.changeInbox === 'string' ? { changeInbox: opts.changeInbox } : {}
      // ⛔ A CONFIDENTIAL ROOM IS NEVER READ IN PLAINTEXT (docs/confidential-path-sweep-2026-11-05.md, finding B): the server
      //   answers `poll` with the whole DECRYPTED history, and that answer crosses the Lambda and the enclave's parent host in
      //   the clear. Read it sealed and open it here. Every caller (the room loop, the unread sweep, lanes, mail, pins…) comes
      //   through this one function, so none can send the readable read by accident. Same answer shape (pollSealed's contract).
      if (enclaveFor(room)) return api.pollSealed(room, mk, sinceEtag, sinceCount, ci)
      // …AND A REGULAR ROOM IS READ SEALED TOO (the owner, 2026-11-06: "Do then regular rooms read sealed too"): `poll` sent the
      //   room key about every 600 ms and the Lambda decrypted the whole history to answer it. The sealed read is opened here; the
      //   key rides only the read that registers this device's CHANGE INBOX (the first of a session — inboxForPoll), because the
      //   server follows the room for it only once that read proves the key (spaceHandler pollProvedKey). A verified room's sealed
      //   read carries no key either: its server checks the sign-in against its sealed copy of the list (sealedRead). Older apps keep `poll`.
      // (a room re-keyed in place: pollSealed asks once more WITH the key when the boxes do not open — see there)
      return api.pollSealed(room, mk, sinceEtag, sinceCount, { ...ci, proveKey: !!ci.changeInbox })
    },

    /** CONTENT-BLIND poll — the same contract as `poll`, but `mk` NEVER leaves this device. The server returns the
     *  sealed ledger and we open it here, so the hot loop (a poll every ~600ms while the Space is on screen) stops
     *  carrying the room key; only `turn` still does, because the agent genuinely needs plaintext.
     *  Returns the IDENTICAL shape to `poll` — { status, etag, changed, version, entries } — so it is a drop-in swap
     *  and the caller's render path is unchanged. A key that doesn't fit surfaces as the same 422/'undecodable' the
     *  server used to return, except now the CLIENT proves it rather than being told. */
    async pollSealed(room, mk, sinceEtag, sinceCount = 0, opts = {}) {
      const ci = opts && typeof opts.changeInbox === 'string' ? { changeInbox: opts.changeInbox } : {} // ONLY the inbox id: a plain op carries nothing a caller hands it by mistake (confidentialWire.test.mjs) // ci: { changeInbox } when poll() reads a confidential room sealed — the drawer's follow rides it (agent/changeFeed.mjs pollSubscribeIntent takes both ops)
      // the key rides only as sealedRead says (proveKey: a regular room's read that registers the change inbox)
      const sent = { keyed: false }
      const send = async () => sealedRead(room, mk, 'pollsealed', { sinceEtag, sinceCount, ...ci }, { proveKey: !!(opts && opts.proveKey && mk && !enclaveFor(room)), sent })
      const r = await withVerified(room, send) // + attach a client-release attestation for a verified room (learned lazily)
      // The IN-PROGRESS reply, opened here like everything else — the server passed it through sealed. It rides EVERY
      // response including the unchanged one, which is the whole point: while a reply is still being written the
      // ledger has not moved, so this is the only thing arriving.
      const out = await decodeSealed(room, mk, sinceCount, r)
      // A ROOM RE-KEYED IN PLACE (rekeyMembers): a device on the old key used to learn it from its next read — the key rode it
      //   and the server answered stale_key, which sends the device for its grant. A key-free read cannot be told stale, so the
      //   new boxes simply do not open (422 undecodable). Ask that once more WITH the key (sealed to the enclave in a
      //   confidential room): the server says stale_key and the device follows the change as before. The key leaves only in
      //   this case (linkMembers.test.mjs caught it). HERE, not in poll(): the SDK and a vault read with pollSealed, and an
      //   open confidential room's poll() came straight here — neither ever asked (sweep 11-07 #1, #2).
      if (out && out.status === 422 && out.reason === 'undecodable' && mk && !sent.keyed) {
        const r2 = await withVerified(room, async () => sealedRead(room, mk, 'pollsealed', { sinceEtag, sinceCount, ...ci }, { proveKey: true })) // ci kept: this keyed read is the one that can register the inbox (state machines pass 7, T#3)
        return decodeSealed(room, mk, sinceCount, r2)
      }
      return out
    },
    // Full SEALED ledger (ciphertext) for a durable LOCAL backup — the raw stored blob (v1/v2 whole, or the v3
    // { v:3, boxes:[…] } wrapper), NOT opened here. sinceCount:0 ⇒ everything. Same gated-retry as pollSealed. The
    // downloaded file carries no plaintext — it is only readable with the room key, via the offline decryptor
    // (/decrypt.html). Returns { status, sealed, count, etag }.
    exportSealed: async (room, mk) => withVerified(room, async () => sealedRead(room, mk, 'pollsealed', { sinceCount: 0 })),
    pending: async (room, mk) => post({ op: 'pending', room, ...(await keyFields(room, 'pending', mk)), ...(await authFor(room)) }),
    /** APPROVAL REMINDERS for Code (agent/approvalRemind.mjs): this device's push address, signed by the server, for the
     *  computer to name when an approval waits there → { status, grant }. `endpointUrl` = where the computer sends it. */
    /** OPTION B: fetch this sign-in's hints ahead of need (at sign-in, on launch), so the fetch is not tied to a room request. */
    prefetchIdentity: async (idToken) => { try { if (typeof idToken === 'string' && idToken) await extrasFor(idToken) } catch { /* the next sealed request fetches them */ } },
    remindGrant: async (subscription, others) => post({ op: 'remindgrant', subscription, ...(Array.isArray(others) && others.length ? { subscriptions: others.slice(0, 16) } : {}) }), // others: the account's other devices (approvalRemind.makeGrant)
    endpointUrl: () => { try { return new URL(endpoint, typeof location !== 'undefined' ? location.href : undefined).href } catch { return '' } },
    /** Fetch an OUT-OF-LINE image blob by its ledger pointer and open it here → { status, b64, mime }.
     *  The request carries no key (the bytes are sealed; serving ciphertext reveals nothing) — `mk` is used locally to
     *  open the envelope, exactly like pollSealed. Blobs are content-addressed and immutable, so a caller may cache the
     *  result against `ref` forever without revalidating. */
    /** A connection's TOOL BOOK (agent/toolBook.mjs): its full tool list sealed once into the room → { status, ref, sha256, n }. */
    // carries the member's sign-in like setConfig (authFor): a verified Space refuses it without — the app then saved the whole list (2026-11-17)
    toolBook: async (room, mk, tools) => post({ op: 'toolbook', room, ...(await keyFields(room, 'toolbook', mk)), toolbook: { tools: Array.isArray(tools) ? tools.slice(0, 400) : [] }, ...(await authFor(room)) }),
    async blob(room, mk, ref) { // arg order (room, mk, …) matches the l1 façade convention so blob can route through the worker (A2c)
      const r = await withVerified(room, async () => sealedRead(room, mk, 'blob', { ref }))
      if (r.status !== 200 || !r.sealed) return r
      try {
        const o = JSON.parse(await openAny(room, r.sealed, mk)) // a photo sent before a rotation: an earlier key (openAny)
        if (!o || typeof o.b64 !== 'string') return { status: 422, reason: 'undecodable' }
        return { status: 200, ref, b64: o.b64, mime: o.mime || 'image/jpeg' }
      } catch { return { status: 422, reason: 'undecodable' } }
    },

    /** Register this device for push. The subscription is sealed into the room's doc server-side (it is room metadata:
     *  which devices care about this room), so it needs mk like any other sealed write. */
    // mk goes through keyFields() like every other material op (turn/import/mirror/title/poll) — so on an ENCLAVE room it
    // is SEALED to the enclave key and the parent relay never sees the raw key (fail-closed for an enclave room with no
    // key). Default tier: keyFields is the identity function → raw {mk}, unchanged. (Was: raw mk in the body — the one
    // material op that skipped the seal, leaking the room key to the parent relay on enclave rooms. Security review #2.)
    subscribe: async (room, mk, subscription, by, quiet) => post({ op: 'subscribe', room, ...(await keyFields(room, 'subscribe', mk)), subscription, by, ...(await pushAcctField(room)), ...(quiet ? { quiet: true } : {}), ...(await authFor(room)) }), // quiet: a bulk or automatic registration — store it, no confirmation push

    /** Turn notifications off for this device. Sends the subscription so the server can drop it by endpoint. */
    unsubscribe: async (room, mk, subscription) => post({ op: 'unsubscribe', room, ...(await keyFields(room, 'unsubscribe', mk)), subscription, ...(await authFor(room)) }),

    // Content-blind transparency read (the "trust receipt"): the EXACT ciphertext the server stores for this room +
    // its recipients. No mk sent — reading ciphertext reveals nothing. → { alg, bytes, sha256, recipients, sealed }.
    sealed: async (room) => post({ op: 'sealed', room }),

    // VERIFIED-CLIENT capability blob (spaces/public/capLink.js). vcput MINTS: store the OPAQUE {mk}-sealed-under-token
    // ciphertext under a one-way capId — mk-commit gated server-side (only an mk-holder may write it), content-blind
    // (the server sees only id + ciphertext, never the token or mk). vcget RESOLVES: fetch it, ATTESTATION-gated (the
    // gateway withholds without a fresh, approved client-release attestation); carries NO mk — the token off the ?vc=
    // link (never sent to the server with the extension) is what opens the blob, unsealed by L1 locally.
    vcput: async (room, mk, capId, capSealed) => post({ op: 'vcput', room, capId, capSealed, ...(await keyFields(room, 'vcput', mk)), ...(await authFor(room)) }), // email-gated like every keyed write
    vcget: async (room, capId, attestation) => post({ op: 'vcget', room, capId, ...(attestation ? { clientAttestation: attestation } : {}) }),
    // The attested client's DEVICE enrollment (docs/the-attested-client.md § The wire; deviceAttest.js): a new hardware key's
    // platform attestation, bound to THIS room's fresh challenge and the member's signing key. Account-level — no mk.
    attestEnroll: async ({ room, chal, spk, enroll }) => post({ op: 'attest-enroll', room, chal, ...(spk ? { spk } : {}), enroll }),
    // A WINDOWS DEVICE'S ACTIVATION BY AN ENCLAVE (agent/winActivation.mjs): `to` 'turn' (confidential rooms) | 'sentinel' (the backup's
    // K_att); `start` → { activate, ticket }, `finish` (the TPM's answer + the ticket) → { ok }. The front keeps the sealed record.
    winAct: async ({ to, step, keyId, activation, ticket }) => post({ op: 'winact', winact: { to, step, keyId, ...(activation ? { activation } : {}), ...(ticket ? { ticket } : {}) } }),
    // "Verify this device" (agent/deviceVerify.mjs, docs/device-verify.md): the hardware key's signature over a CHECKER's nonce.
    // The answer is only the key code — the verdict is collected and checked by the checker, never shown here.
    // Witbitz Mail's receive prototype (agent/mailIntake.mjs): a mail address that drops into this Space's intake.
    mailRoute: async (intake, space) => post({ op: 'mail-route', mail: { intake, space } }),
    mailRevoke: async (intake, space) => post({ op: 'mail-revoke', mail: { intake, space } }), // stop receiving: the enclave ends the address (agent/mailIntake.mjs revokeOp)
    deviceVerify: async ({ platform, keyId, nonce, assertion, sig, integrity }) => post({ op: 'device-verify', device: { platform, keyId, nonce, ...(assertion ? { assertion } : {}), ...(sig ? { sig } : {}), ...(integrity ? { integrity } : {}) } }),
    // the ATTESTED BACKUP (agent/attestedBackup.mjs): op 'attested-chal' | 'attested-get' | 'attested-put', the fields in `attested`
    attestedOp: async (op, attested, chal) => post({ op, attested, ...(chal ? { chal } : {}) }),
    // K_att (infra/cloud-computer/sentinel/attkey.mjs): `mode` chal | get — the standing Sentinel's challenge, then the secret sealed to
    // the device's one-time key (attested.epk), after the attestation it verifies itself. The Space Lambda only relays.
    attkeyOp: async (mode, attested, chal) => post({ op: 'attkey', ...(mode === 'chal' ? { mode: 'chal' } : {}), attested, ...(chal ? { chal } : {}) }),

    // DEVICE tool result — return a client-executed tool's answer (e.g. a calendar read the agent asked for) to the
    // blocked turn. The result is SEALED HERE under mk (content-blind at rest, opened only by the turn); mk never leaves.
    // `{ claim }` instead of a result: claim the call for this device before a tool with a side effect (G#3) — no result,
    // nothing sealed; → { ok, claimed } (claimed false: another device runs it).
    toolResult: async (room, mk, callId, result, opts = {}) => {
      if (opts && opts.claim) return post({ op: 'toolresult', room, callId, toolClaim: String(opts.claim) })
      const resBox = JSON.stringify(await seal(typeof result === 'string' ? result : JSON.stringify(result), { room: mk }))
      return post({ op: 'toolresult', room, callId, resBox })
    },

    // KEEP-ALIVE (docs user-data-lifecycle): extend the idle-expiry of rooms THIS device holds. Called once per open
    // with room ids from the device's OWN recents list — no mk, no content — so the server never learns which rooms are
    // whose (the client does the fan-out; the server just pushes each `lapsesAt` out). Bounded here and again server-side;
    // best-effort by contract → a Space's life must never hinge on this succeeding. → { ok, rooms }.
    touch: async (rooms) => post({ op: 'touch', rooms: (Array.isArray(rooms) ? rooms : [rooms]).filter((r) => typeof r === 'string' && r).slice(0, 200) }),

    // §APP STORE Stage 2: the PUBLIC registry-backed app catalog (no room/mk/auth) → { status, apps:[…] }.
    apps: async () => post({ op: 'apps' }),

    // The create-screen capability probe (model catalog + whether temporary Spaces are supported) — same keyless shape
    // as `apps` above, and it belongs here for the same reason: `post` is the transport that actually works everywhere.
    // The picker used to call `fetch(endpoint, …)` directly, which (a) is not the path a VAULT-framed tenant app uses,
    // so the Model row silently never appeared there while the App row — routed through here — did, and (b) bypasses
    // the OHTTP relay, so with "Hide my IP" on, merely opening New Space leaked the device IP to the API.
    models: async () => post({ op: 'models' }),

    // Stop a running turn (docs/spaces-stop-turn.md). Keyless — the per-turn nonce IS the authorization — but it must
    // still go through `post` for the same two reasons as `models`: it has to work in a vault-framed tenant app, and a
    // direct fetch would step outside the OHTTP relay (leaking the IP on the very op that says "stop reading me").
    stop: async (room, key) => post({ op: 'stop', room, key }),

    // Tier-2 server-blind email invites (docs/spaces-email-invite.md) — identity-plane, no room/mk.
    // oprf: evaluate a blinded point → { z, proof, kpub } (the client verifies the DLEQ + unblinds to a handle).
    // dirGet: public lookup of a handle → { entry:{ boxPub, inbox } } or 404. dirPut: publish/rotate this user's own
    // slot, authenticated by the email-login idToken (the server checks OPRF(email)==handle so nobody can squat a slot).
    oprf: async (blinded) => post({ op: 'oprf', blinded }),
    // dirGet: public lookup of a handle → { entry:{ boxPub, inbox } } or 404. A member who closed the EMAIL door (Settings →
    // "People can find me by my email address", off) answers 404 like an unknown address — except to THEMSELF: pass the
    // sign-in `idToken` (+ the tenant `scope`, as dirPut does) and the row answers its owner (sign-in's "welcome back",
    // recovery's duplicate guard). dirDiscoverable: that switch — the row is named by the token, not a handle.
    dirGet: async (handle, { idToken, scope, app } = {}) => post({ op: 'dir', mode: 'get', handle, ...(idToken ? { idToken } : {}), ...(scope ? { dirScope: scope } : {}), ...(app ? { app } : {}) }), // app: another slot of the account (an attested box, attestedBox.js)
    dirDiscoverable: async (discoverable, idToken, scope) => post({ op: 'dir', mode: 'discoverable', discoverable: discoverable !== false, idToken, ...(scope ? { dirScope: scope } : {}) }),
    dirPut: async (handle, entry, idToken, scope, app) => post({ op: 'dir', mode: 'put', handle, entry, idToken, ...(scope ? { dirScope: scope } : {}), ...(app ? { app } : {}) }), // dirScope: the per-tenant handle namespace — the server re-derives OPRF(scope·email) to match (else a scoped account's put is handle_mismatch)
    // USERNAMES (docs/spaces-usernames.md §4): a public "@name" → the account's directory HANDLE (never its email).
    // resolve is public; whoami/claim/release prove the account with the same sign-in token the directory put uses.
    userResolve: async (username, app) => post({ op: 'user', mode: 'resolve', username, ...(app ? { app } : {}) }), // app: which of the account's slots comes back with the handle
    // A member by @username, as the room-bound TAG no guessed email can be linked to (docs/spaces-usernames.md §12)
    userTag: async (username, room) => call(endpoint, { op: 'user', mode: 'tag', username, room }, f), // a DIRECTORY op (the room is only its salt): the Lambda answers it for a room of either tier — through post() a confidential room's went to the enclave, which has no directory (sync sweep 10-21 #5)
    userWhoami: async (idToken) => post({ op: 'user', mode: 'whoami', idToken }),
    userClaim: async (username, idToken, { name, publish } = {}) => extrasCache.clear() || post({ op: 'user', mode: 'claim', username, idToken, ...(publish ? { publish: true, ...(name ? { name } : {}) } : {}) }),
    userRelease: async (idToken) => extrasCache.clear() || post({ op: 'user', mode: 'release', idToken }),
    dirErase: async (idToken, scope) => post({ op: 'dir', mode: 'erase', idToken, ...(scope ? { dirScope: scope } : {}) }), // DELETE MY ACCOUNT (docs/user-erasure.md): the token's own directory row + inboxes
    // The invite inbox: drop a sealed box into a recipient's mailbox; inboxFetch reads YOUR mailbox (openBox with boxPriv).
    drop: async (inbox, box) => post({ op: 'drop', inbox, box }),
    inboxFetch: async (inbox, since) => post({ op: 'inbox', inbox, ...(since ? { since } : {}) }),
    // "Which of my rooms changed since `since`?" — the change inbox, standard tier (docs/change-inbox.md). Keyless.
    changes: async (inbox, since = 0) => post({ op: 'changes', inbox, since }),
    inboxSubscribe: async (inbox, subscription) => post({ op: 'inboxsub', inbox, subscription }), // register this device for a real-time invite tickle
    decide: async (room, mk, id, approve, by, { bridgeMk, bridgeRoom, editText, deviceExec, recordResult } = {}) => post({ op: 'decide', room, ...(await keyFields(room, 'decide', mk)), id, approve, by, ...(await otherAuth([bridgeRoom])), ...(await authFor(room)), ...(bridgeMk ? await bridgeFields(room, 'decide', bridgeMk) : {}), ...(bridgeRoom ? { bridgeRoom } : {}), ...(editText ? { editText } : {}), ...(deviceExec ? { deviceExec } : {}), ...(recordResult === false ? { recordResult: false } : {}) }), // editText: the approver's edit of the pending crossing // bridgeMk: approving a cross_to_shared posts into the linked shared room // deviceExec: a client-executed action (calendar write) — the server must skip its executor

    // Shared WIDGET state (co-edited by members; the agent reads its `summary` on turns). SET with a `patch` (+ a short
    // `summary`); READ with no patch → { v, state, summary }. The blob is mk-sealed server-side — never sent in clear.
    /** THE ROOM AS A STORE — write rows: ONE sealed ledger entry carrying put/delete ops, ordered by the server without
     *  reading it. `ops` = [{ op:'put', collection, id?, row } | { op:'del', collection, id }]; `by` names the writer in
     *  the system line every member sees. → { status, id, ops:[{op,collection,id}], text, entries } */
    // `file` (optional, ONE beside one put — a mail's attachment): { b64, mime, name } — the server stores it out of line
    // and the row's `file` field names it (agent/spaceService.mjs op data).
    data: async (room, mk, ops, by, file) =>
      post({ op: 'data', room, ...(await keyFields(room, 'data', mk)), ops: Array.isArray(ops) ? ops.slice(0, 50) : [], ...(by ? { by: String(by).slice(0, 80) } : {}), ...(file && file.b64 ? { file: { b64: String(file.b64), mime: String(file.mime || ''), name: String(file.name || 'file').slice(0, 120) } } : {}), ...(await authFor(room)) }),
    // `ifV` (optional): the version this write was built on — the server writes only if the doc is still there (409
    // version_conflict otherwise, with the current `v`), so two devices cannot silently overwrite each other.
    state: async (room, mk, name, patch, summary, by, ifV) =>
      post({ op: 'state', room, ...(await keyFields(room, 'state', mk)), name, ...(patch !== undefined ? { patch, summary, by, ...(Number.isInteger(ifV) ? { ifV } : {}) } : {}), ...(await authFor(room)) }),

    // An emoji on one message. `react` is {target, emoji, off} — target is the entryKey the server recomputes from the
    // ledger, so a client cannot react to something that is not there. Never a turn: the assistant stays quiet.
    /** PURGE a purgeable room's handled rows (docs/room-messages.md § Retention) — `ids` = row ids no collection still
     *  holds. → { status, purged, live } */
    purge: async (room, mk, ids) =>
      post({ op: 'purge', room, ...(await keyFields(room, 'purge', mk)), ops: Array.isArray(ids) ? ids.slice(0, 50).map(String) : [], ...(await authFor(room)) }),
    /** DELETE FORWARDED MAIL FOR REAL (agent/mailPurge.mjs): the `mail`/`mailfile` rows named — already deleted with `data` —
     *  leave the ledger and their files are overwritten. Only in a solo verified Space, by its member. → { status, purged, files, live } */
    mailPurge: async (room, mk, ids) =>
      post({ op: 'mailpurge', room, ...(await keyFields(room, 'mailpurge', mk)), ops: Array.isArray(ids) ? ids.slice(0, 50).map(String) : [], ...(await authFor(room)) }),
    /** THE MESSAGE INTAKE (docs/message-intake.md, roomIntake.js). `intakeDrop` is a PRODUCER's call — keyless: a drop
     *  token and a box sealed to the intake's public key. The rest are the account's devices (keyed). */
    intakeDrop: async (room, drop, box) => post({ op: 'intakedrop', room, drop, box }),
    intakeReg: async (room, mk, ops) => post({ op: 'intakereg', room, ...(await keyFields(room, 'intakereg', mk)), ops: Array.isArray(ops) ? ops.slice(0, 50) : [] }),
    intakePush: async (room, mk, subscription, remove = false) => post({ op: 'intakepush', room, ...(await keyFields(room, 'intakepush', mk)), subscription, ...(remove ? { remove: true } : {}) }), // this device on the intake's wake list (messageIntake.mjs)
    intakeDeviceWake: async (room, mk, remove = false) => post({ op: 'intakepush', room, ...(await keyFields(room, 'intakepush', mk)), cloudDevice: true, ...(remove ? { remove: true } : {}) }), // the cloud device on the wake list (docs/cloud-device.md § 12)
    intake: async (room, mk) => post({ op: 'intake', room, ...(await keyFields(room, 'intake', mk)) }),
    intakeAck: async (room, mk, items) => post({ op: 'intakeack', room, ...(await keyFields(room, 'intakeack', mk)), ops: Array.isArray(items) ? items.slice(0, 50) : [] }),
    // SAFE MEDIA (docs/safe-media.md § 5): the safe copy a device made of a photo or PDF in the room → stored beside it (agent/safeCopy.mjs)
    safeCopy: async (room, mk, safe, by) => post({ op: 'safe', room, ...(await keyFields(room, 'safe', mk)), safe, ...(by ? { by: String(by).slice(0, 80) } : {}), ...(await authFor(room)) }),
    react: async (room, mk, react, by) =>
      post({ op: 'react', room, ...(await keyFields(room, 'react', mk)), react, ...(by ? { by: String(by).slice(0, 80) } : {}), ...(await authFor(room)) }),

    // OWNER RULE (docs/the-owner-rule.md) — the JOIN-flow peer check. `policyOf` fetches the room's cleartext marker +
    // sealed config (op:'policy', public). `verifyGovernance` opens the config with mk and verifies the owner-signed
    // policy against the PINNED owner key (from /space-config) — so the client trusts a governed room only if it's a
    // genuine room of that owner, not the server's word. Called only when a key is pinned (single-owner deployment);
    // the generic multi-tenant PWA passes no key ⇒ { ok:true, governed:false }.
    // op:'policy' carries the room key and the member's sign-in: an EMAIL-GATED room serves its sealed config only to an
    // allowed member (agent/spaceService.mjs, 2026-10-02) and otherwise answers just { gated: true }.
    policyOf: (room, mk) => policyPost(room, mk),
    /** Does this room require an attested app? (a refusal already said so, or op 'policy' does) → boolean. */
    // a read that FAILED throws — never 'not attested' (sync sweep 11-08: the SDK and the vault made an open lane of an attested Space on a failed read)
    // …and neither is the FRONT'S answer for a confidential room this client had not marked (sync sweep 2026-11-12 #4): a keyless ask
    // then reaches the front, which answers from its mirror row — the tier, never the enclave's `attested` mark (agent/tierGuard.mjs).
    // "No" from there was remembered and an ordinary lane made of an attested confidential Space. Only "yes", or the answer of the
    // tier the room is on, counts; the page marks the room from the tier this answer carries and the next ask goes to its enclave.
    attestedRoom: async (room, mk) => {
      if (attestReadRooms.has(room)) return true
      const marked = enclaveFor(room)
      const r = await policyPost(room, mk)
      if (!r || r.status !== 200) throw Object.assign(new Error('policy read failed' + (r && r.status ? ' (HTTP ' + r.status + ')' : '')), { code: 'policy_unreadable' })
      if (r.attested === true) return true
      if (!marked && r.tier === 'enclave') throw Object.assign(new Error('policy read: a confidential room answered by the front — its enclave was not asked'), { code: 'policy_unreadable' })
      return false
    },
    /** The room's PUBLIC key commitment (op 'invite', keyless) → string | null (none) | undefined (could not ask). Lets a device
     *  check a key it was handed before keeping it (emailInvites.js keyOpens). */
    roomCommit: async (room) => { const r = await post({ op: 'invite', room }); return r && r.status === 200 ? (r.mkCommit || null) : undefined },
    // Fetch + decrypt this room's sealed agent CONFIG (persona/tools/agentName/admission/allow/agentKeys/model/…) with
    // mk → the plaintext config, or null. The config ciphertext is content-blind (sealed under mk, served by op:'policy'
    // which already returns it for governance). A membership fork uses this to carry the agent's behavior into the new
    // room (spaceFork.js) — the forking client holds the OLD mk, so it can decrypt without exposing the new key.
    // `{ plainMark: true }`: a PLAIN room (a read that worked, nothing sealed, no lanes bit) answers `{ plain: true }`, so null
    // means only that the read failed — a private lane waits on that, never inherits "nothing" (sync sweep 2026-11-03)
    getConfig: async (room, mk, o) => {
      const r = await policyPost(room, mk)
      if (!r || r.status !== 200 || r.error || r.ok === false) return null // a refusal is not a plain room (sweep 11-06 #1: an envelope refusal read as { plain: true } → an OPEN lane)
      if (!r.configSealed && r.gated === true) { gatedRooms.add(room); return { admission: 'email', gated: true } } // a gated room before sign-in: that it is gated, and nothing else
      if (!r.configSealed) { const h = await healEnclaveConfig(room, mk); if (h) return h.cfg }
      if (!r.configSealed) return r.lanes === true ? { lanes: true } : (o && o.plainMark === true ? { plain: true } : null) // PLAIN room: no sealed config to open — the server hands the lanes bit back directly
      let cfg = null
      try { cfg = JSON.parse(await open(JSON.parse(r.configSealed), { mk })) } catch { return null }
      // a VERIFIED room learned from its settings too (sweep 11-07 #1: only create/open/a keyless read taught it, so a removed
      // member's key-free reads never asked with the key); an owner-governed one reads with the key up front (#5)
      if (cfg && typeof cfg === 'object' && cfg.admission === 'email') { gatedRooms.add(room); if (cfg.ownerPolicy) keyFirst.set(room, Infinity) }
      return cfg
    },
    /** Change the assistant IN PLACE — its name, instructions (persona) and model — visibly: the server appends a system
     *  line to the ledger ("⚙️ Dana changed the assistant's instructions") that every member sees. Only those three
     *  fields move; the sealed config is re-sealed WHOLE with them applied, so tools, admission, the owner policy and the
     *  enclave block travel byte-identical (the server opens both versions and refuses anything else — those stay
     *  fork-and-replay). `by` is the display name for the line. → { status, changed:[…], recorded } */
    /** The standing Sentinel's door (docs/standing-sentinel.md §2): attest / credgrant / credlist / credrevoke, as the
     *  signed-in account (the token's email — the server never reads an account the page names). A pipe: the grant
     *  inside is sealed to the Sentinel's attested key. → the Sentinel's answer, or { error }. */
    sentinel: async (sentinel, idToken) => post({ op: 'sentinel', sentinel, idToken }),
    /** The cloud device through the API (agent/cloudDeviceRoute.mjs): `cd` = { t, … }, the account = the verified idToken's. */
    cloudDevice: async (cd, idToken) => (await import('./cloudDeviceSeal.js')).cloudDeviceCall(post, cd, idToken), // sealed to its enclave once pinned
    // press-to-talk's cloud engine (agent/sttKey.mjs): a short-lived, capped Tinfoil key for this signed-in account
    // SAFE MEDIA (docs/safe-media.md): the tools enclave's attestation for a nonce, then a sealed box to make a file safe
    safeMedia: async (idToken, safemedia) => post({ op: 'safemedia', idToken, safemedia }),
    stt: async (idToken, userToken) => post({ op: 'stt', ...(idToken ? { idToken } : {}), ...(userToken ? { userToken } : {}) }), // userToken: the SDK's tenant-vouched user (wb.dictation)
    // Report (docs/report-and-block.md §3): what the member chose to show Witbitz — the front stores and mails it (agent/reportOp.mjs)
    report: async (idToken, body, memberToken) => post({ op: 'report', idToken, room: body.room, report: body, ...(memberToken ? { memberToken } : {}) }),
    // a MEMBER's token for a report (agent/spaceService.mjs op membertoken): issued only to the room's CURRENT key and, in a verified
    // room, to a sign-in its gate admits (it rides with the request) — sealed to the turn enclave for a confidential room, like any
    // keyed op, so the key never reaches the Lambda
    memberToken: async (room, mk) => post({ op: 'membertoken', room, ...(await keyFields(room, 'membertoken', mk)), ...(await authFor(room)) }), // the sign-in: a verified room issues it only past its email gate (sync sweep 11-11 #2)
    tts: async (idToken, userToken) => post({ op: 'tts', ...(idToken ? { idToken } : {}), ...(userToken ? { userToken } : {}) }), // "Play aloud": a capped Tinfoil key for speech OUTPUT (agent/sttKey.mjs § SPEECH OUTPUT)
    /** Witbitz's signed rule + room signature for a NEW room that requires an app (op owner-policy, agent/witbitzOwnerPolicy.mjs) — for
     *  a create that is not this client's own (the hosted app's split create, space.js createSplitLocal). */
    ownerPolicyFor: async (room, _mk, level) => post({ op: 'owner-policy', room, level }),
    setConfig: async (room, mk, patch, by) => {
      let r = await policyPost(room, mk)
      if (!r || r.status !== 200) return { status: (r && r.status) || 502, error: (r && r.error) || 'policy_unavailable' }
      if (!r.configSealed && r.gated !== true) { const h = await healEnclaveConfig(room, mk); if (h && h.saved) r = { ...r, configSealed: h.configSealed } } // edit the healed config, never a config of only the edited fields
      let cur = {}
      if (r.configSealed) { // a config that does not open with THIS key is not ours to rewrite — refuse here, before anything is posted
        let pt = null
        try { pt = await open(JSON.parse(r.configSealed), { mk }) } catch { pt = null }
        if (pt == null) return { status: 409, error: 'config_unreadable' }
        try { cur = JSON.parse(pt) || {} } catch { return { status: 409, error: 'config_unreadable' } }
      }
      const p = patch && typeof patch === 'object' ? patch : {}
      const next = { ...cur }
      if ('persona' in p) next.persona = p.persona == null ? undefined : String(p.persona).slice(0, 4000)
      if ('agentName' in p) next.agentName = p.agentName == null ? undefined : String(p.agentName).slice(0, 80)
      if ('model' in p) next.model = p.model == null ? undefined : p.model
      if ('funding' in p) next.funding = p.funding && typeof p.funding.grant === 'string' ? { grant: p.funding.grant.slice(0, 1200), perMemberUsd: Number(p.funding.perMemberUsd) || undefined } : undefined // an admin's grant (agent/roomFunding.mjs) — the server lets only an admin change it
      if ('dataSchema' in p) next.dataSchema = p.dataSchema == null ? undefined : p.dataSchema // the room's declared collections — data, not governance
      if ('platformTools' in p) next.platformTools = p.platformTools === false || Array.isArray(p.platformTools) ? p.platformTools : undefined // which platform tools the assistant gets; null/true = all again
      if ('framing' in p) next.framing = p.framing === 'builder' ? 'builder' : undefined // builder mode: the app's prompt only; null = the Spaces framing again
      // WHO RUNS IT (a role change in place — no new key; the server checks who may: agent/roomRekey.mayChangeRoles)
      for (const k of ['admins', 'owners']) if (k in p) next[k] = { emails: [...new Set(((p[k] && p[k].emails) || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))] }
      if ('dataWrites' in p) next.dataWrites = p.dataWrites === false ? false : undefined // false = data_query only; null/true = writes offered again
      if ('safeMedia' in p) next.safeMedia = p.safeMedia === true ? true : undefined // SAFE MEDIA on/off (docs/safe-media.md): the admins', any member's where there are none
      // connections (docs/standing-sentinel.md §3): the API keys members attached, as { account, id, callKey, label, host } —
      // never a secret. The patch is DECLARATIVE — { add: entry } | { remove: id } | a whole list — because it crosses
      // the L1 façade by structured clone (a function would not), and it is applied to the room's CURRENT list, read
      // under its own key at write time, so two members attaching at once do not overwrite each other from a stale read.
      if ('connections' in p) {
        next.connections = applyConnectionsPatch(next.connections, p.connections) // connectionEntry.js: bounded; an MCP server's chosen tools + auto list ride too ({ update: { id, mcp } })
      }
      const configSealed = JSON.stringify(await seal(JSON.stringify(next), { room: mk })) // the `room` recipient — what sealConfig and the server's open expect
      return post({ op: 'config', room, ...(await keyFields(room, 'config', mk)), configSealed, ...(by ? { by: String(by).slice(0, 80) } : {}), ...(await authFor(room)) })
    },
    /** A VERIFIED ROOM RE-KEYED IN PLACE (docs/key-rotation-design.md § (b); agent/roomRekey.mjs has the server's rules).
     *  `members` = the new { allow, owners, admins } (absent = a pure rotation, "Rotate keys now"); `recipients` = one
     *  { mh: memberHash(email, room), boxPub } per member who stays (the caller included). Here, in the realm that holds the
     *  key: a NEW key is minted; the config is read under the current key, its members replaced, the current key appended
     *  to its chain, and it is sealed under the new key; the new key is sealed to each recipient's invite key; one request.
     *  → the server's answer, plus `newMk` on success (the caller keeps it — the worker: l1-worker op 'rekey'). */
    // A SPLIT room (mk = userShare ⊕ appShare; the hosted app): `split.userShare` is the share held now. Only the USER half
    // rotates (§ Split-key rooms): appShare = mk ⊕ userShare, a fresh random userShare', mk' = userShare' ⊕ appShare — the
    // builder's half and its seal stay as they are. The grants carry userShare' (never mk'); the answer carries newShare.
    rekey: async (room, mk, { members = null, recipients = [], pending = [], by = '', split = null, creatorPriv = null, link = null, expectEpoch: wantEpoch = null } = {}) => { // link: { roster, gk } — a LINK Space (linkMembers.js): its roster and new invite key; recipients then carry `id` (keyGrantId) and `extra` (their fresh gk grant)
      const r = await policyPost(room, mk)
      if (!r || r.status !== 200 || !r.configSealed) return { status: (r && r.status) || 502, error: (r && r.error) || 'policy_unavailable' }
      let cur = null
      try { cur = JSON.parse((await open(JSON.parse(r.configSealed), { mk })) || 'null') } catch { cur = null }
      if (!cur || typeof cur !== 'object') return { status: 409, error: 'config_unreadable' }
      const chain = Array.isArray(cur.keyChain) ? cur.keyChain : []
      const epoch = chain.length // each rotation appends the key it retires: the chain's length IS the room's epoch
      if (Number.isInteger(wantEpoch) && wantEpoch !== epoch) return { status: 409, error: 'stale_epoch' } // the members were computed at another epoch (V#5): a retry with a key adopted meanwhile must not apply them to the newer config
      let newMk = newKey(), newShare = null
      if (split && split.userShare) { const app = combineShares(mk, split.userShare); if (!app) return { status: 400, error: 'bad_split', reason: 'the held share does not pair with this key' }; const s2 = splitKey(app); newShare = s2.shareA; newMk = s2.shareB } // shareB = app ⊕ shareA = userShare' ⊕ appShare
      const newCommit = await keyCommit(newMk)
      const next = { ...cur, ...(members ? { allow: members.allow, owners: members.owners, admins: members.admins } : {}), ...(link ? { admission: 'invite', roster: link.roster, gk: link.gk } : {}), keyChain: [...chain, { epoch, commit: await keyCommit(mk), key: mk }] }
      for (const k of ['owners', 'admins']) if (next[k] === undefined) delete next[k]
      if (next.direct === true && members && !staysDirect(next.allow)) delete next.direct // a third member makes a direct chat a group (roomName.js)
      const configSealed = JSON.stringify(await seal(JSON.stringify(next), { room: newMk }))
      const grant = JSON.stringify(newShare ? { v: 1, kind: 'room-split-key', room, epoch: epoch + 1, userShare: newShare, commit: newCommit } : { v: 1, kind: 'room-key', room, epoch: epoch + 1, mk: newMk })
      const grants = {}
      for (const x of recipients || []) {
        const id = x && (x.mh || x.id) // an account (mh) — or a LINK Space's member key (id: keyGrantId), whose box also carries its fresh invite grant
        if (id && x.boxPub && !grants[id]) grants[id] = JSON.stringify(await sealTo(x.extra ? JSON.stringify({ ...JSON.parse(grant), ...x.extra }) : grant, x.boxPub))
      }
      for (const mh of pending || []) { if (typeof mh === 'string' && mh && !grants[mh]) grants[mh] = 'pending' } // on the list, no invite key yet: told to ask for a fresh link, not that the room went on without them
      const kf = await keyFields(room, 'rekey', mk)
      let nf = { newMk }
      if (kf.mkSealed) { const pub = mkPubFor(room); nf = { newMkSealed: await sealMk(newMk, pub, mkAad({ room, op: 'rekey:new', ts: kf.mkTs, nonce: kf.mkNonce })) } } // sealed like the current key, bound to the same request
      const creatorSig = creatorPriv ? (await signEntry(creatorPriv, { room, kind: 'rekey', id: newCommit, text: String(epoch), ts: 0, author: '' })).sig : undefined // a room with no owners or admins: its creator's key over this change
      const out = await post({ op: 'rekey', room, ...kf, ...nf, newCommit, expectEpoch: epoch, configSealed, grants, ...(creatorSig ? { creatorSig } : {}), ...(by ? { by: String(by).slice(0, 80) } : {}), ...(await authFor(room)) })
      return out && out.status === 200 ? { ...out, newMk, newCommit, ...(newShare ? { newShare } : {}) } : out
    },
    /** This member's new key after a rotation: the grant sealed to their account's invite key (op 'grant'), asked with the
     *  sign-in alone — the old key opens nothing now. → { status:200, grant, epoch, commit } | { status:404, error:'no_grant' } */
    grant: async (room, _mk, keyProof = null) => post({ op: 'grant', room, ...(keyProof && keyProof.spk && keyProof.keySig ? { spk: keyProof.spk, keySig: keyProof.keySig } : await authFor(room)) }), // keyProof: a LINK Space's member proves its signing key (no account)
    verifyGovernance: (room, mk, ownerKey, member) =>
      verifyRoomGovernance({ room, mk, ownerKey, member, fetchPolicy: (r) => policyPost(r, r === room ? mk : null), openConfig: async (ct, m) => JSON.parse(await open(JSON.parse(ct), { mk: m })) }),

  }
  return api
}
function cryptoRandom(n) { const u = new Uint8Array(n); (globalThis.crypto || require('crypto').webcrypto).getRandomValues(u); return u }
function b64url(u) { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
