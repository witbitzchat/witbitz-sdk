// attestedRooms.js — WHICH ROOMS REQUIRE AN ATTESTED APP, and so must never leave this device in the regular backup or the
// account's room list (docs/the-attested-client.md § The attested backup, step 1; the owner, 2026-10-12: "we should have an
// attested backup blob separate from the regular blob" → "Yes" to step 1).
//
// A room is attested when its owner-signed policy carries `requireAttestation` (agent/attestation.mjs) — learned here when
// the app verifies the room's governance (spaceClient.governance → ownerPolicy.verifyRoomGovernance). From then on its key
// is kept OUT of: the regular backup (backup.js gatherBackup, and the merged blob before a push), the account's room list
// (roomSync.js pushIndexRoom), so a browser restoring the account — even with the recovery code and the email — never gets
// it. Until the attested backup exists (step 2: released by the enclave / the Space Lambda after a fresh attestation) such a
// key lives on this device only. No attested room can exist yet (no owner may require it on the hosted service, and there
// is no attested app), so nothing is lost by that.
//
// The list holds room ids only (like space:enclaveRooms), and only ever grows: a room never stops being attested here.

// KINDS (the owner, 2026-10-18: "Do this code general so we can reuse it as is for the attested rooms"). One code path for every
// attested room; the KIND says which client proves it and which attested backup holds its key:
//   attested — the Witbitz app on iPhone, Android or Mac: the attested backup, released to the device's fresh attestation;
// Every kind stays out of the regular backup and the account's room list (isAttestedRoom covers them all).
//   windows  — the Windows app (windows/attested-client; level `windows`): a key in a genuine TPM, never an app — ITS OWN backup
//              (agent/attestedBackup.mjs KINDS.windows; the owner, 2026-11-09: "Its own Windows backup"), so a Windows proof never
//              opens the phones' keys. Listed FIRST: a room made before the kind existed sits in 'attested' too, and is a Windows room.
export const KINDS = Object.freeze(['windows', 'attested'])
// RETIRED (the owner, 2026-11-22: "We dont need any emulation rooms"): the emulated kind — a browser vouching for itself. A room a
// device marked as one stays out of the regular backup and the room list (a room never stops being attested here), but nothing
// proves it any more: it has no kind, no bridge and no backup.
const KEYS = { windows: 'space:winAttestedRooms', attested: 'space:attestedRooms', retired: 'space:emuAttestedRooms' }
// Read from storage EVERY time — no module-level copy: three modules ask (space.js marks, backup.js and roomSync.js leave
// out), and a stale copy in one of them is a key in the backup.
const load = (kind) => { try { const a = JSON.parse(localStorage.getItem(KEYS[kind]) || '[]'); return new Set(Array.isArray(a) ? a.filter((r) => typeof r === 'string' && r) : []) } catch { return new Set() } }

/** The room's kind, or null for an ordinary room. */
export const attestedKindOf = (room) => (room ? KINDS.find((k) => load(k).has(room)) || null : null)
export const isAttestedRoom = (room) => !!attestedKindOf(room) || (!!room && load('retired').has(room)) // any kind, a retired one too: never in the regular backup or the room list
export const attestedRooms = (kind = 'attested') => (KEYS[kind] ? [...load(kind)].filter((r) => attestedKindOf(r) === kind) : []) // a room in two lists is the first kind's
/** Every room whose key the key worker keeps in memory only: each kind's, and the retired ones a device learned before
 *  (space.js l1.volatile — a retired room's key, if it ever comes back, must stay off the disk as before). */
export const volatileAttestedRooms = () => [...new Set([...KINDS.flatMap((k) => attestedRooms(k)), ...load('retired')])]
// THE OFFLINE COPY MAY INCLUDE AN ATTESTED ROOM — only when the person says so (owner, 2026-11-09: "Offer to include it"). Its key
// lives in the page's memory alone (space.js _attMk / _attSplit); space.js hands this module a reader so offlineExport.js can
// ask for it without importing space.js. → { mk } | { userShare, commit } | null.
let _attKeyOf = null
export const setAttestedKeyReader = (fn) => { _attKeyOf = typeof fn === 'function' ? fn : null }
export const attestedKeyOf = (room) => { try { return (_attKeyOf && room && isAttestedRoom(room) && _attKeyOf(room)) || null } catch { return null } }
export function markAttestedRoom(room, kind = 'attested') {
  if (!room || typeof room !== 'string' || !KEYS[kind]) return false
  const rooms = load(kind); if (rooms.has(room)) return false
  rooms.add(room)
  try { localStorage.setItem(KEYS[kind], JSON.stringify([...rooms])) } catch { /* private mode */ }
  try { globalThis.dispatchEvent && globalThis.dispatchEvent(new CustomEvent('wb-attested-room', { detail: { room, kind } })) } catch { /* no events here */ } // SYNCHRONOUS: the app tells its key worker before any key of this room can reach it
  return true
}
/** Does this VERIFIED owner policy require an attested app? (agent/attestation.mjs reads the same field.) */
export const policyRequiresAttestation = (policy) => !!(policy && policy.requireAttestation && typeof policy.requireAttestation === 'object')
/** Which kind a VERIFIED policy makes: ONLY windows → 'windows'; ONLY the retired emulation → 'retired' (kept out, never proved); any
 *  phone or Mac → 'attested'; none → null. */
export function policyAttestKind (policy) {
  if (!policyRequiresAttestation(policy)) return null
  const pl = Array.isArray(policy.requireAttestation.platforms) ? policy.requireAttestation.platforms : []
  return pl.length > 0 && pl.every((p) => p === 'emulated') ? 'retired' : pl.length > 0 && pl.every((p) => p === 'windows') ? 'windows' : 'attested'
}
/** The bridge platform that answers for a kind: the Windows app for 'windows', the iPhone / Android / Mac app (any other) for 'attested'. */
export const bridgeServesKind = (platform, kind) => (kind === 'windows' ? platform === 'windows' : kind === 'attested' ? !!platform && platform !== 'emulated' && platform !== 'windows' : false)

/** THE SIGNED RULE FOR A CREATE THAT BUILDS ITS OWN REQUEST (space.js createSplitLocal — the hosted app's Spaces and lanes;
 *  spaceClient.create does the same for the regular app). `config.requireApp` = the level (Witbitz signs its own apps' rule; no
 *  app is named), `config.attestAccept` = the versions the room takes (optional). `ask(room, level, app)` → the server's op
 *  owner-policy. → { config, owner }: the rule sealed with the settings and the request flags gone; the rule + this room's
 *  signature (+ the versions) to send with the create. null when the config requires no app. No signed rule → throws
 *  `attested_not_set`: nothing may be created (the room would come out ordinary while this device marked it attested). */
export async function withSignedAppRule (config, room, ask) {
  if (!config || !config.requireApp) return null
  const level = String(config.requireApp)
  let g
  try { g = await ask(room, level) } catch (e) { g = { error: String((e && e.message) || e) } }
  if (!g || g.status !== 200 || !g.ownerPolicy || !g.roomAuth) throw Object.assign(new Error('The app requirement could not be set (' + ((g && (g.error || g.status)) || 'no answer') + ') — nothing was created.'), { code: 'attested_not_set' })
  const { requireApp: _r, requireAppId: _a, attestAccept: acc, ...rest } = config // requireAppId: dropped (retired 2026-11-22)
  return { config: { ...rest, ownerPolicy: g.ownerPolicy }, owner: { ownerPolicy: g.ownerPolicy, roomAuth: g.roomAuth, ...(acc ? { attestAccept: acc } : {}) } }
}
