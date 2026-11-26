import { isAttestedRoom } from './attestedRooms.js'
// roomState.js — the per-room key/persistence custody layer (Verified-Client Phase 1, L1).
// Pure, self-contained localStorage helpers keyed by room id: the room key (mk) read, the per-member
// signing identity, the email-gate flag, and the key model. Extracted from space.js as the first TCB
// module. NOTE: rememberMk stays in space.js for now — it also mirrors mk into IndexedDB for the SW
// and enqueues a recovery backup, so it moves when those layers modularize. Everything here is dep-free.

export const mkKey = (r) => 'space:mk:' + r
export const recallMk = (r) => { try { return localStorage.getItem(mkKey(r)) } catch { return null } }
// The CURRENT room's key from state (worker-held mk lives there, not in localStorage); any other room's from the store.
export const curMk = (r = state.room) => (r === state.room ? (state.mk || recallMk(r)) : recallMk(r))
// TENANT SPLIT-KEY (docs/tenant-split-key-dualstore.md): a split room stores the user's MEMBERSHIP half (userShare) +
// the room's commit instead of `mk`. Never both — a room is normal (space:mk:) XOR split (space:us:+space:spc:).
export const usKey = (r) => 'space:us:' + r
export const spcKey = (r) => 'space:spc:' + r
export const recallUserShare = (r) => { try { return localStorage.getItem(usKey(r)) } catch { return null } }
// Room TYPE (is it split?) reads the NON-SECRET commit marker (space:spc:), not the secret userShare (space:us:). The
// commit is a public hash of mk, written alongside the userShare at every split site; keying room-type off it means the
// main thread never needs the secret to know a room is split — a prerequisite for confining the userShare to the kernel.
// (Kept `|| usKey` for the rare split entry that predates a commit; either marker means split.)
export const isSplitRoom = (r) => { try { return !!localStorage.getItem(spcKey(r)) || !!localStorage.getItem(usKey(r)) } catch { return false } }
export const modelKey = (r) => 'space:model:' + r
export const setModel = (r, m) => { try { localStorage.setItem(modelKey(r), m) } catch { /* private mode */ } }
export const getModel = (r) => { try { return localStorage.getItem(modelKey(r)) } catch { return null } }
export const idKey = (r) => 'space:id:' + r
export const rememberId = (r, id) => { try { localStorage.setItem(idKey(r), JSON.stringify(id)) } catch { /* private mode */ } }
export const recallId = (r) => { try { const s = localStorage.getItem(idKey(r)); return s ? JSON.parse(s) : null } catch { return null } }
export const gateKey = (r) => 'space:gate:' + r
export const setGate = (r, g) => { try { localStorage.setItem(gateKey(r), g) } catch { /* private mode */ } }
export const gateOf = (r) => { try { return localStorage.getItem(gateKey(r)) || '' } catch { return '' } }
// Verified-client marker (docs/verified-client-design.md): this room requires the Verified Client — its share link is a
// `?vc=` capability and it opens only in the extension. Local hint (mirrors setGate) so the share UI picks the right link.
export const vcKey = (r) => 'space:vc:' + r
export const setVerifiedClient = (r) => { try { localStorage.setItem(vcKey(r), '1') } catch { /* private mode */ } }
export const isVerifiedClient = (r) => { try { return localStorage.getItem(vcKey(r)) === '1' } catch { return false } }
export const signKey = (r) => 'space:sign:' + r
// EVERYTHING THIS DEVICE KEEPS UNDER A ROOM'S NAME (2026-10-26, the owner: "Check that there are no problems when we delete a
// space"). A delete removed the key, the model and the split shares, and left the rest — the room's private signing identity
// and keypair among them — for good, through every relaunch. space.js forgetSpace removes each of these; roomKeysOnDelete.test
// fails when a new `'space:<x>:' + room` key appears in the app without being here (or named as kept on purpose).
export const ROOM_KEY_PREFIXES = ['space:mk:', 'space:model:', 'space:us:', 'space:spc:', 'space:id:', 'space:sign:', 'space:gate:', 'space:vc:',
  'space:ak:', 'space:lanes:', 'space:nolane:', 'space:lanechk:', 'space:lanechk2:', 'space:laneup:', 'space:crossed:', 'space:epoch:', 'space:mykey:', 'space:notif:',
  'space:moved-unsent:', 'space:away-unsent:', 'space:safemedia:', 'space:inviteowed:', 'space:removed:']
export const recallSign = (r) => { try { const s = localStorage.getItem(signKey(r)); return s ? JSON.parse(s) : null } catch { return null } }
export const rememberSign = (r, kp) => { try { localStorage.setItem(signKey(r), JSON.stringify(kp)) } catch { /* private mode */ } }

// The LIVE session singleton — a mutable object so extracted TCB modules can READ and WRITE the same
// session state across module boundaries (ES imports are read-only bindings, but an object's properties
// are not). `client` is assigned at runtime in space.js (its init needs the page's auth/enclave glue).
export const state = { room: null, mk: null, etag: null, count: 0, client: null, myName: '', enclaveKey: null, enclaveClaim: null, enclaveAttested: null, apiEndpoint: '', enclaveAsleep: false, wakingEnclave: false, sessionRelease: null, lastBackupRead: null }

// A TEMPORARY room (docs: spaces-temporary-rooms) is named by its id — `tmp-` — and lives in the shreddable temp index,
// never in durable recents/backups. One definition, read by the shell and the modules alike.
export const isTempRoom = (r) => String(r || '').startsWith('tmp-')
// NOTHING OF THIS ROOM IS KEPT ON THE DEVICE: a temporary room (session-only) and an ATTESTED room of any kind (docs/emulated-
// attested-rooms.md; the owner, 2026-10-18: "attested rooms cannot be watched offline") — its key only in memory, released
// after a fresh attestation; no chat, state or image cache at rest. One rule for every cache.
export const noDeviceCopy = (r) => isTempRoom(r) || isAttestedRoom(r)
