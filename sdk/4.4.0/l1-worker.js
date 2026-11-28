// spaces/public/l1-worker.js — A2a of the thin-L1 migration (docs/verified-client-l1-interface.md):
// the mk-CUSTODY KERNEL as a Web Worker. It hosts the sealed-ledger client, holds the room mk, and does
// all mk-crypto (keyFields) + entry signing (turn's identity JWK). The main thread posts SEMANTIC ops
// ({op, room, args}); mk NEVER posts back out — a main-thread (L3) compromise cannot read this realm's
// memory. spaceClient + its whole dep chain (e2ee/entrySig/mkseal/ownerPolicy/rosterHash/spaceConfig/
// invite) are localStorage/DOM-free, so they run here unmodified.
//
// FLAG-GATED: only used when the page is opened with ?l1worker=1 (l1.js). Default OFF → the A1 direct
// façade runs and this worker is never spawned. Ships safe; validate behind the flag before enabling.
//
// Auth stays on the main thread (localStorage-backed cachedEmailAuth): when the client needs auth for a
// room, `auth(room)` round-trips to the main thread via {authReq}. The enclave tier (mkPub/enclave) is
// read SYNCHRONOUSLY by keyFields, so we keep a pushed snapshot {enclaveKey, enclaveRooms} and read it
// locally rather than round-trip.
import { routingIndex } from './opRouting.js'
import { prefetchUsable, positionOf, prefetchAnswer, prefetchHashKey } from './prefetchPoll.js'
import { makeSpaceClient, setAttestProvider, setPushSelf, setPushAcct, pushAcctSecretOf, viewingTag } from './spaceClient.js'
import { idb } from './idb.js'
import { armIdbNaming, setIdbNaming } from './idbSeal.js' // §NAMES (docs/desktop-protection.md phase 2): this realm's store keeps opaque names on a protected device
import { _hasGzip, _jsonBytes, gunzipB64, gzipB64 } from './compress.js' // Atlas index docs: gzip/absorb/inject worker-side
import { combineShares, commit as commitMk } from './e2ee.js' // §9 split-key: reconstruct mk = userShare ⊕ appShare inside the worker (confinement mode)
import { deriveNotifKey } from './notifKey.js'
import { importRaw as importSealKey, sealIf, open as openSealed, isSealed } from './deviceSeal.js' // DEVICE STORAGE PROTECTION (docs/device-storage-protection.md): with the switch on, every key this worker persists is ciphertext under a key held only HERE, in memory
import { sealDoc, openDoc, isSealedDoc, rawSealKey } from './accountSeal.js' // acctSeal / acctOpen: room messages sealed under the account key (roomMail.js); rawSealKey: the temp index's own seal key
import { editTempList, addToTempList, removeFromTempList, keylessTempList, isTempRoomId } from './tempList.js' // the temporary-Spaces list, kept HERE for the hosted app (op tempList)
import { makeAccountStore } from './accountStores.js' // the account's sync docs SEALED on the device (docs/sdk-convergence.md § The account stores)
import { openRoomStream } from './roomStreamClient.js' // ROOM STREAMS: the socket lives HERE, beside the key it derives from (docs/change-inbox.md § Room streams)
import { roomRegion, DEFAULT_REGION } from './regions.js' // a room's region is in its id — its enclave's key seals it
import { opensEnvelopes, sealsIdentity } from './reqEnvelope.js' // does a live enclave open the sealed request envelope
import { gatedKey } from './enclaveAccept.js' // the user's accepted builds: the SAME seal gate as enclave.js, run here because mk is sealed HERE // §Phase-4: mirror NK=HKDF(mk,'notif') to idb HERE (the confined kernel) so vault-sw.js gets a preview key for SPLIT rooms — whose mk only ever materializes in this worker, never the main-thread loader (that's why split rooms showed the generic nudge)
import { signInOf, SIGNIN_RENEW_AUTH } from './roomPass.js' // the room pass: which sign-in a request carries (the page answers for it)
// One room's stream socket here (the key never leaves): events go up to the page; `tag` names this device as viewing it.
// A CARRIED ENTRY (roomStreamClient `tail`): kept here, beside the key, for the poll the event asks for — the page gets the event
// without the box. room → { count, box, at }; used once, for a poll from count-1, within FRAME_TAIL_MS.
const frameTails = new Map()
const FRAME_TAIL_MS = 30000
function openStreamHere (room, mk, grants, tag) {
  return openRoomStream({ mk, grants: Array.isArray(grants) ? grants : null, tag, onEvent: (ev) => {
    if (ev && ev.tail) { frameTails.set(room, { ...ev.tail, at: Date.now() }); const { tail, ...rest } = ev; ev = rest }
    self.postMessage({ t: 'stream', room, ev })
  }, onState: (up) => self.postMessage({ t: 'stream', room, up }) })
}

let client = null
let clientRealm = '' // the realm (endpoint · app · tenant) `client` was made for — 'open' keeps it within one (sweep 11-07 #6)
// ⛔ The account's sync docs (index, index2, pipes, …) carry every room key — sealed under acctKey before they leave
// (accountStores.js). acctKey comes from the page that owns this worker (regular app) or the vault hosting it (tenant).
let acctKey = null
let oldAcctKeys = [] // the account keys of PREVIOUS masters (accountStores.js oldKeys: documents sealed before a new master)
const unzipDoc = async (st) => (st && typeof st === 'object' && typeof st.z === 'string') ? await gunzipB64(st.z).catch(() => null) : st
const acct = makeAccountStore({ call: (...a) => client.state(...a), key: async () => acctKey, oldKeys: async () => oldAcctKeys })
// THE TEMPORARY-SPACES LIST (tempRooms.js; the owner, 2026-11-13: "Do 1+3+4"): in the hosted app the vault hands this worker the
// temp index's pointer (op tempHold — { room, sk }, its key into `mks`), and the frame reads and edits the list through op tempList,
// keyless. The list carries every temp room's key, sealed under the pointer's own random key `sk` (as the page seals it).
let tempPtr = null
const tempStore = makeAccountStore({ call: (...a) => client.state(...a), key: async () => (tempPtr && tempPtr.sk ? rawSealKey(tempPtr.sk) : null) })
const TEMP_SK = /^[A-Za-z0-9_-]{43}$/
// ROOM STREAMS: room → { s, holders }. The stream client needs mk, so it runs in this realm; only EVENTS go out — the
// reply text as it grows (the same plaintext a poll's partialText already carries out), "poll now", "the turn ended".
// Several frames can share this worker (the hoisted vault: the app + a lane panel), hence a holder count.
const grantsByRoom = new Map()
const streams = new Map()
function rekeyStream(room, mk) {
  const held = streams.get(room)
  if (!held?.s || held.mk === mk) return
  held.s.stop()
  grantsByRoom.delete(room)
  held.mk = mk
  held.grants = null
  held.s = openStreamHere(room, mk, null, held.tag)
}
const streamFeed = (room, result) => {
  const h = streams.get(room)
  if (!result || result.status !== 200) return
  if (Array.isArray(result.streamGrants)) grantsByRoom.set(room, result.streamGrants)
  if (!h) return
  if (Array.isArray(result.streamGrants)) { h.s?.setGrants(result.streamGrants); h.grants = result.streamGrants }
  h.s?.sync(typeof result.partialText === 'string' ? result.partialText : '')
}
const mks = new Map()               // room → mk — the worker's authoritative key store (A2b); mk never posts back out
// §9 SPLIT-KEY (confinement mode): a split room's key store is the user's userShare + the commit. resolveMk fetches the
// app half from the same-origin tenant backend, combines, verifies the commit, and CACHES the reconstructed mk in `mks`
// — so every mk-using op below works unchanged. The vault/worker never holds K_eco (that unwrap is the backend's job).
const splits = new Map()            // room → { userShare, commit }
// §PERSIST (2026-09-01): mirror BOTH maps to this origin's idb and reload at boot. iOS reclaims workers under memory
// pressure; the heartbeat recreates one, but everything the old worker had ABSORBED (index-doc userShares, resolved mks)
// lived only in memory — so there was a window where opens failed ('key hasn't reached this device'). A recreated worker
// now self-restores instantly. The signout/reset path wipes this store (vault-loader _idbWipe) — the audit still holds.
// §PROTECT (docs/device-storage-protection.md). `sealKey` is the device's AES key, imported from raw bytes the page derived from
// its passkey (PRF/largeBlob) and sent over postMessage — non-extractable here, never written anywhere. While it is set, every
// persisted key is sealed; at boot, sealed entries are PARKED until the page unlocks and sends the key again; `relock` drops
// the maps and the key from memory. With the switch off (no key, no sealed entries) every store is byte-identical to before.
let sealKey = null
let storageEpoch = 0, storageWiped = false
let nkClear = false                 // §PREVIEWS (opt-in under protection): the push-preview keys (nk:) are written CLEAR so a locked device's tickle still shows sender + first line; everything else stays sealed
let protectedAtRest = false         // sealed entries were seen at boot (or `seal` ran): the store is protected — NEVER write a clear key over it
const parked = new Map()            // idb key ('mk:'/'us:'/'nk:' + room) → sealed blob awaiting the device key
// A key that reaches a protected-but-locked worker (the page re-sends a room key it still holds at open) stays in memory
// only; the `unseal` that follows persists everything held, sealed. Without protection: the clear write, as always.
// VOLATILE ROOMS (docs/emulated-attested-rooms.md; "attested rooms cannot be watched offline"): an attested room's key is held in
// this map only — never written, and anything an older build wrote is removed (op `volatile`). The page names them first.
const volatile = new Set()
const postAttNk = (room, nk) => { if (!room || !nk || String(room).startsWith('tmp-')) return; try { self.postMessage({ t: 'attNk', room, nk }) } catch { /* */ } }
const roomOfKey = (k) => String(k).slice(String(k).indexOf(':') + 1)
const persist = (k, v) => {
  const epoch = storageEpoch
  return storageWiped || volatile.has(roomOfKey(k)) ? Promise.resolve() : keysReady.then(() => ((!sealKey && protectedAtRest) ? undefined : sealIf(sealKey, v).then((stored) => epoch === storageEpoch && !storageWiped ? idb.set(k, stored) : undefined))).catch(() => {})
} // a wipe also cancels keys whose asynchronous sealing was still running
// AN ATTESTED ROOM'S PREVIEW KEY (the owner, 2026-11-24: "the notification preview for attested rooms doesn't work"): its room key stays
// in this worker's memory, so the vault — whose service worker and native shell show the notification — never learned its preview key.
// The vault gets the PREVIEW KEY alone (it opens a notification's preview, never the room): `attNk`. Nothing is written here.
const persistNk = (room, nk) => storageWiped ? Promise.resolve() : volatile.has(room) ? (postAttNk(room, nk), Promise.resolve()) : (nkClear ? keysReady.then(() => storageWiped ? undefined : idb.set('nk:' + room, nk)).catch(() => {}) : protectedAtRest ? keysReady.then(() => idb.delRaw('nk:' + room)).catch(() => {}) : persist('nk:' + room, nk))
// A ROOM'S KEY EPOCH (docs/key-rotation-design.md § (b)): a verified room re-keyed in place counts its keys. Kept per room
// (not secret: a count) so a key arriving from the account index can be refused when it is OLDER than the one held — a
// device that had not yet learned the new key, writing the index, must not put the old key back (never backwards).
const eps = new Map()
const noteEp = (room, ep) => { const n = Number(ep) || 0; if (room && n > (eps.get(room) || 0)) { eps.set(room, n); if (!volatile.has(room)) idb.set('ep:' + room, n).catch(() => {}) } }
// NEVER BACKWARDS: a key for a room this worker holds a NEWER key of (a higher epoch) is refused — the hosted vault re-seeds
// every key it holds at each launch with no epoch, an old link carries its old key, the index of a device that had not yet
// learned the change carries the old one. A room never re-keyed has epoch 0 everywhere: nothing is refused (as before).
const backwards = (room, held, incoming, ep) => held !== incoming && (Number(ep) || 0) < (eps.get(room) || 0) // nothing held is no exception: a dropped old key re-seeded without an epoch must not come back
// THE VAULT LEARNS A RE-KEYED ROOM'S KEY (`keyEpoch`): the hosted vault keeps its own copy of every key (its keyring, the
// account cache) and seeds a fresh worker from it — told here, it holds the new key and its epoch (vault-loader.js), and
// never hands the frame or the next worker the old one. Only a key with an epoch, only when it changed. The vault page is
// this worker's owner and already holds every key; the regular app's page ignores the message.
const tellEpoch = (room, ep, key) => { if (volatile.has(room) || String(room).startsWith('tmp-')) return; try { self.postMessage({ t: 'keyEpoch', room, ep, ...key }) } catch { /* */ } } // never a memory-only (attested) or temporary room's key: the vault would keep it in its account cache
const keep = (room, mk, ep) => { if (backwards(room, mks.get(room), mk, ep)) return false; if ((Number(ep) || 0) > 0 && (mks.get(room) !== mk || Number(ep) > (eps.get(room) || 0))) tellEpoch(room, Number(ep), { mk }); if (ep) noteEp(room, ep); mks.set(room, mk); rekeyStream(room, mk); persist('mk:' + room, mk); deriveNotifKey(mk).then((nk) => persistNk(room, nk)).catch(() => {}) } // + NK mirror: every mk the kernel holds (normal OR reconstructed-split) yields a push-preview key, so a background notification for THIS room shows sender+text (vault-sw.js notifPreview), not the generic nudge
// WHY a room has no key, per room — the worker's own verdict rides the no_key answer (the owner's trail said only "no key on
// this device" while the index held a share for every room, 2026-10-03).
const APPSHARE_URL = (() => { try { const o = self.location && self.location.origin; return (o && o !== 'null') ? o + '/api/appshare' : '/api/appshare' } catch (e) { return '/api/appshare' } })()
const noKeyWhy = new Map()
const noKeyReason = (room) => 'no key on this device' + (noKeyWhy.has(room) ? ' — ' + noKeyWhy.get(room) : '')
// Every DIFFERENT split share seen for a room, besides the held one. The index absorb replaces a held share on every read
// (seconds apart), so a share seeded from the room's own link was shadowed by the index's copy within a breath; resolveMk
// tries them all against the server's half and promotes the one whose commitment holds.
const splitAlts = new Map()
// A NEWER SHARE MAKES THE HELD KEY OLD (the owner, 2026-10-22: "the second device did not follow"): a split room's grant is the
// new user half; the full key this worker held is the room's OLD key, and resolveMk prefers a held key — so every read went
// out with it, came back stale_key, and the device fetched its grant for ever. It is dropped; the next read rebuilds the
// key from the new share and the app's half, checked against the room's commitment (resolveMk).
// A HELD KEY THAT IS NOT THE SHARE'S (the owner's second device, 2026-10-22): an older worker kept a re-keyed split room's OLD
// key beside its new share, on disk — and the held key wins in resolveMk. For a re-keyed split room (epoch > 0) the held key
// must be the one the share's commitment names; if not, it is dropped and the key rebuilt from the share and the app half.
// Checked once per key (a hash), never for a room that was not re-keyed.
const heldOk = new Map() // room → the held key that was checked against the share's commitment
async function heldMatchesShare (room, have) {
  const sp = splits.get(room)
  if (!sp || !sp.commit || !((eps.get(room) || 0) > 0) || heldOk.get(room) === have) return true
  let ok = false
  try { ok = (await commitMk(have)) === sp.commit } catch { ok = false }
  if (ok) { heldOk.set(room, have); return true }
  dropOldKey(room); return false
}
const dropOldKey = (room) => { if (!mks.has(room)) return; const h = streams.get(room); if (h) { h.s?.stop(); h.mk = null; h.grants = null }; grantsByRoom.delete(room); mks.delete(room); keysReady.then(() => idb.del('mk:' + room)).catch(() => {}) }
const keepSplit = (room, sp, ep) => { if (backwards(room, splits.get(room) && splits.get(room).userShare, sp.userShare, ep)) return false; if ((Number(ep) || 0) > 0 && ((splits.get(room) || {}).userShare !== sp.userShare || Number(ep) > (eps.get(room) || 0))) { tellEpoch(room, Number(ep), { split: { userShare: sp.userShare, commit: sp.commit || '' } }); if (Number(ep) > (eps.get(room) || 0) || (splits.get(room) || {}).userShare !== sp.userShare) dropOldKey(room) } if (ep) noteEp(room, ep); const held = splits.get(room); if (held && held.userShare !== sp.userShare) { const alts = splitAlts.get(room) || []; if (!alts.some((a) => a.userShare === held.userShare)) splitAlts.set(room, [held, ...alts].slice(0, 4)) } splits.set(room, sp); persist('us:' + room, sp) }
// The mirror of keep/keepSplit, and the thing that makes "delete this Space" mean anything: without it the app cleared
// localStorage while the WORKER kept the key — in memory AND in idb, from which a freshly-created worker reloads it at
// boot (the idb.entries('mk:') restore below). So a deleted room's key came BACK on the next page load. Clears every
// trace: the live maps, the persisted mk, the derived notification key, and the split half.
const forget = (room) => {
  grantsByRoom.delete(room); streams.get(room)?.s?.stop(); streams.delete(room)
  mks.delete(room); splits.delete(room); eps.delete(room)
  for (const prefix of ['mk:', 'us:', 'nk:']) parked.delete(prefix + room)
  lastPos.delete(room); heldOk.delete(room); splitAlts.delete(room)
  return Promise.all(['mk:', 'nk:', 'us:', 'ep:', 'cnt:'].map(prefix => idb.delStrict(prefix + room)))
}
async function resolveMk(room) {
  // ⚑ WAIT for the idb key map. EVERY page load starts a FRESH worker (plus browsers evict them), and the map loads
  // asynchronously — so a room opened before that load finishes resolves against an EMPTY map and reports "no key". The
  // user sees "This link is missing its key" while the key sits in idb the whole time (hasMk reads false too: presence
  // hasn't published yet). Platform-independent — desktop and Android hit it as readily as iOS. keysReady settles once,
  // so this costs nothing after boot. THE cold-start race behind the recurring missing-key report.
  try { await keysReady } catch { /* load failed → fall through to the stores as they stand */ }
  const have = mks.get(room); if (have && await heldMatchesShare(room, have)) return have
  const sp = splits.get(room); if (!sp) { noKeyWhy.set(room, 'no split share held'); return undefined }
  let r = null
  try {
    // ABSOLUTE, on this worker's own origin. The vault spawns this worker from a blob: URL, and a relative URL cannot be
    // resolved against one — WebKit: "URL is not valid or contains user credentials." So the app half was NEVER fetched
    // from the hoisted worker: every room that reached a device as a split share through the index read no_key (the owner's
    // fresh install, 2026-10-03). A blob worker's origin is its creator's, so this lands on the vault's /api/appshare.
    const x = await fetch(APPSHARE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'get', room }) }) // op 'get': the builder's template (spaces/templates/appshare) needs it; Witbitz's own function reads any non-create as a get
    if (!x.ok) { noKeyWhy.set(room, 'app half: HTTP ' + x.status); return undefined }
    r = await x.json()
  } catch (e) { noKeyWhy.set(room, 'app half: ' + String((e && e.message) || e).slice(0, 60)); return undefined } // offline / tenant down → no key
  if (!r || !r.appShare) { noKeyWhy.set(room, 'app half: no share in the answer'); return undefined }
  const cands = [sp, ...(splitAlts.get(room) || [])]
  for (const c of cands) { // §6.4 commit-check, over every share seen for the room (held first)
    const mk = combineShares(c.userShare, r.appShare)
    if (mk && (!c.commit || (await commitMk(mk)) === c.commit)) { if (c !== sp) keepSplit(room, c); keep(room, mk, c === sp ? eps.get(room) : 0); noKeyWhy.delete(room); return mk } // an alternate that holds becomes the held share
  }
  noKeyWhy.set(room, 'commitment mismatch: ' + cands.length + ' share(s) tried against the server half' + (r.commit ? ' (server commit ' + String(r.commit).slice(0, 8) + '…)' : ''))
  return undefined
}
// §ID-CONFINE: the per-room SIGNING IDENTITY (the priv key that authors turns) lives HERE, not on the app main thread.
// Seeded by the vault (rememberId) from the account backup / at create+join; the turn op signs with it so the app never
// holds — or passes up — the private signing key. An invite/open room's id is {name, sign:{priv,pub?}, grant, gk}; an
// email room's is {email, sign:{priv,pub}, googleIdToken}. Never posts back out (same discipline as mk).
const ids = new Map()                // room → identity (priv included)
let encKey = null                   // pushed enclave snapshot
let encKeys = {}                    // { region: { key, attested } } — each room seals to ITS region's enclave (docs/multi-region.md)
let encAttested = null              // {pcrs, policyVersion, platform:{pcrs}} — the live attestation the room blocks are checked against
let encTrusted                      // the builds THIS USER accepted (trustedBuilds.js, pushed with the snapshot); undefined = not known yet → the gate refuses
const encRooms = new Set()
const authWaiters = new Map()
let aseq = 0
const attestWaiters = new Map()
// a create's DELETION COMMITMENT, asked of the vault that started this worker (vault-core.js) — never of a page
const delWaiters = new Map()
let dseq = 0, delAsking = 0
const askDel = (room) => new Promise((resolve) => {
  const a = ++dseq
  delWaiters.set(a, resolve)
  self.postMessage({ delReq: a, room })
  setTimeout(() => { if (delWaiters.delete(a)) resolve(null) }, 5000) // no answer: the room is made without one, as before
})
let atseq = 0

// Mirror WHICH rooms we hold a key for (room ids only — never the keys) so the main thread can answer
// hasMk(room) synchronously without holding mk (A2b presence mirror, feeds A2c value-eviction).
const publishPresence = () => self.postMessage({ t: 'presence', rooms: [...new Set([...mks.keys(), ...splits.keys()])], rk: 2, tl: 1 }) // tl: this worker keeps the temp-Spaces list (ops tempHold / tempList) — a hosted frame on a newer build than its vault checks it // rk: what this worker can re-key in place — 2 = split rooms (only the user's half) + never backwards + keyEpoch to its vault; a hosted frame on a newer build checks it (the vault's worker follows Official) // §9: a split room counts as "held" (userShare present; mk reconstructed on demand)

// Load the COMPLETE, persistent map from idb at boot (rememberMk mirrors every mk under 'mk:'+room).
// This makes hasMk correct across sessions without the main thread ever pushing keys.
// ⚑ keysReady: indexWrite MUST await this. The load is async, and indexWrite DROPS any room whose key this worker doesn't
// hold — so an index push that lands before the map is loaded (iOS evicts workers aggressively; a fresh one starts empty)
// would strip EVERY room's key from the shared index doc in a single write, account-wide and unrecoverable.
// §NAMES: a store already kept under opaque names (the flag, or any `p:` key) is protected: the names go on, LOCKED, before the
// scan — the scan then finds nothing until the unlock gives the key, and no clear key is ever written meanwhile.
const namesReady = Promise.all([idb.getRaw('protectedNames'), idb.keysRaw('p:')]).then(([f, ks]) => { if (f || (ks && ks.length)) { setIdbNaming({ on: true }); protectedAtRest = true } }).catch(() => {})
const keysReady = namesReady.then(() => Promise.all([
  idb.entries('mk:').then((es) => { let n = 0; for (const [k, v] of es) if (isSealed(v)) { parked.set(k, v); protectedAtRest = true } else if (v) { mks.set(k.slice(3), v); n++ } if (n) publishPresence() }).catch(() => {}), // a sealed entry waits for the device key (§PROTECT)
  idb.entries('ep:').then((es) => { for (const [k, v] of es) { const n = Number(v); if (n > 0) eps.set(k.slice(3), n) } }).catch(() => {}), // key epochs (noteEp)
  idb.entries('us:').then((es) => { let n = 0; for (const [k, v] of es) if (isSealed(v)) { parked.set(k, v); protectedAtRest = true } else if (v && v.userShare) { splits.set(k.slice(3), v); n++ } if (n) publishPresence() }).catch(() => {}), // reload the split shares too — the reclaim-window fix
]))

// auth shim → main thread (which holds the localStorage-backed cachedEmailAuth)
const AUTH_WAIT_MS = 20_000 // longer than a silent renewal (the email session's /refresh), far shorter than for ever
const auth = (room) => {
  // §ID-CONFINE: when we HOLD the room's email identity ({email, sign:{priv,pub}, googleIdToken}), resolve the gated-room
  // READ auth ({idToken, spk}) HERE — so the token never has to travel to the app (no authReq round-trip). Rooms we don't
  // hold (flag off / not yet seeded / invite rooms) fall back to the main-thread shim, unchanged. Inert until an email
  // identity is seeded (nothing does so yet — the email slice wires the vault seed).
  const id = ids.get(room)
  if (id && id.googleIdToken && id.sign && id.sign.pub) return Promise.resolve({ idToken: id.googleIdToken, spk: id.sign.pub })
  return new Promise((resolve) => {
    const a = ++aseq
    authWaiters.set(a, resolve)
    self.postMessage({ authReq: a, room })
    // A request nobody answers (the frame it went to is gone — liveFrames.js) must not hold the read for ever: after
    // AUTH_WAIT_MS it goes out unsigned, exactly as when the page answers "no sign-in", and the room says so.
    setTimeout(() => { const w = authWaiters.get(a); if (w) { authWaiters.delete(a); w({}) } }, AUTH_WAIT_MS)
  })
}

// attestation shim → main thread (which reaches the L1 vault that mints client-release attestations). A verified room's
// material read runs HERE (mk stays worker-side), so the worker's spaceClient asks the main thread for the attestation.
const attestShim = (room, o) => new Promise((resolve) => {
  const a = ++atseq
  attestWaiters.set(a, resolve)
  self.postMessage({ attestReq: a, room, ...(o && typeof o === 'object' ? { o: { read: o.read === true, challenge: typeof o.challenge === 'string' ? o.challenge : undefined } } : {}) }) // o: an attested READ (docs/emulated-attested-rooms.md step 2)
})
setAttestProvider(attestShim)

// The origin's small kv database, shared with the service worker (sw-notif-core.js uses the same name/store): the
// push handler leaves a PREFETCHED poll answer here and reads the room's position from here. Every call is bounded —
// a hung database must never hold a poll.
const IDB_WAIT = 2500
const idbOpen = () => new Promise((res) => { const t = setTimeout(() => res(null), IDB_WAIT); try { const r = indexedDB.open('spaces', 1); r.onupgradeneeded = () => { try { r.result.createObjectStore('kv') } catch { /* */ } }; r.onsuccess = () => { clearTimeout(t); const db = r.result; db.onversionchange = () => db.close(); res(db) }; r.onerror = () => { clearTimeout(t); res(null) } } catch { clearTimeout(t); res(null) } })
const idbGet = async (k) => { try { const db = await idbOpen(); if (!db) return null; return await new Promise((res) => { const t = setTimeout(() => res(null), IDB_WAIT); const q = db.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = () => { clearTimeout(t); res(q.result || null) }; q.onerror = () => { clearTimeout(t); res(null) } }) } catch { return null } }
const idbSet = async (k, v) => { try { const db = await idbOpen(); if (!db) return false; return await new Promise((res) => { const t = setTimeout(() => res(false), IDB_WAIT); const q = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); q.onsuccess = () => { clearTimeout(t); res(true) }; q.onerror = () => { clearTimeout(t); res(false) } }) } catch { return false } }
const idbDel = async (k) => { try { const db = await idbOpen(); if (!db) return false; return await new Promise((res) => { const t = setTimeout(() => res(false), IDB_WAIT); const q = db.transaction('kv', 'readwrite').objectStore('kv').delete(k); q.onsuccess = () => { clearTimeout(t); res(true) }; q.onerror = () => { clearTimeout(t); res(false) } }) } catch { return false } }
const lastPos = new Map()          // room → the position last written to cnt:<room> (write only on change)
const prefetchChecked = new Set()  // rooms whose prefetch slot this worker has looked at
const prefetchFlag = new Set()     // rooms the service worker announced a fresh prefetch for
let prefetchLookUntil = 0          // after a 'wakeup' (the page came to the foreground) every poll looks, for a few seconds: the first poll of a resumed page is already on its way before any tap message, and the push's announcement is lost while iOS holds the page suspended
try { const pfc = new BroadcastChannel('wb-prefetch'); pfc.onmessage = (e) => { const r = e && e.data && e.data.room; if (typeof r === 'string') prefetchFlag.add(r) } } catch { /* no BroadcastChannel: the first-poll check still runs */ }

self.onmessage = async (e) => {
  const m = e.data || {}
  switch (m.t) {
    case 'delRes': {
      const w = delWaiters.get(m.a)
      if (w) { delWaiters.delete(m.a); w(typeof m.v === 'string' ? m.v : null) }
      return
    }
    case 'authRes': {
      const w = authWaiters.get(m.a)
      if (w) { authWaiters.delete(m.a); w(m.v || {}) }
      return
    }
    case 'attestRes': {
      const w = attestWaiters.get(m.a)
      if (w) { attestWaiters.delete(m.a); w(m.v || null) }
      return
    }
    case 'enclave': {                // main pushes {key, attested, acceptance, rooms} at open + on wake/re-attest
      encKey = m.key || null
      encAttested = m.attested || null
      encKeys = (m.keys && typeof m.keys === 'object') ? m.keys : {}
      const snap = (m.acceptance && typeof m.acceptance === 'object') ? m.acceptance : {}
      encTrusted = Array.isArray(snap.trusted) ? snap.trusted : undefined
      encRooms.clear()
      for (const r of (m.rooms || [])) encRooms.add(r)
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    // ── §PROTECT (docs/device-storage-protection.md): the device key arrives as 32 raw bytes, is imported non-extractable, and lives only here.
    case 'seal': {                   // {id, key} → switch ON: hold the key, rewrite every persisted key sealed
      try {
        sealKey = await importSealKey(m.key); protectedAtRest = true; nkClear = !!m.previews
        await keysReady
        // Sealed entries parked at boot while protection was OFF are an earlier setup's leftovers: no lock names their key,
        // so nothing can open them — and the next unlock would throw on the first one and stay locked. They go.
        for (const k of parked.keys()) { try { await idb.delRaw(k) } catch { /* */ } }
        parked.clear()
        // …and a leftover sealed nk: — the boot scan parks only mk:/us:, so it stayed, and an unlock with no other sealed key
        // re-reads the store and throws on it (the vault drops all three, vault-loader dropStaleKeys; sync sweep backlog P6)
        for (const [k, v] of await idb.entries('nk:')) if (isSealed(v)) { try { await idb.delRaw(k) } catch { /* */ } }
        await armIdbNaming(m.key)
        let n = 0
        for (const [room, mk] of mks) { await persist('mk:' + room, mk); n++; try { await persistNk(room, await deriveNotifKey(mk)) } catch { /* no nk → no sealed nk */ } }
        for (const [room, sp] of splits) { await persist('us:' + room, sp); n++ }
        self.postMessage({ id: m.id, result: { sealed: n } })
      } catch (err) { sealKey = null; self.postMessage({ id: m.id, error: 'seal: ' + String((err && err.message) || err) }) }
      return
    }
    case 'unseal': {                 // {id, key} → unlock: open every parked (or persisted) sealed entry into the maps
      try {
        const t0 = performance.now(), ms = {} // where the unlock's time goes (spaceAtRest.js prints it): the owner's iPhone, 96 ms here
        const key = await importSealKey(m.key); nkClear = !!m.previews
        await keysReady; ms.ready = performance.now() - t0; await armIdbNaming(m.key); ms.names = performance.now() - t0
        if ((await idb.keysRaw('p:')).length && !(await idb.nameIndex()).length) { setIdbNaming({ on: true }); throw new Error('this key opens nothing here') } // §NAMES: a wrong key reads no name — refuse, and stay locked (never write under its names)
        ms.check = performance.now() - t0
        if (!parked.size) for (const pfx of ['mk:', 'us:', 'nk:']) for (const [k, v] of await idb.entries(pfx)) if (isSealed(v)) parked.set(k, v) // after a relock the maps are empty: re-read the sealed store
        ms.read = performance.now() - t0; ms.n = parked.size
        let n = 0
        // ALL AT ONCE, then into the maps (2026-11-17: one by one, WebKit's WebCrypto costs a thread hop per key — ~450 rooms on the
        // owner's iPhone): a wrong key THROWS → nothing opened, the page shows the lock again
        const all = [...parked], vals = await Promise.all(all.map(([, blob]) => openSealed(key, blob)))
        all.forEach(([k], i) => {
          const v = vals[i]
          if (k.startsWith('mk:')) { mks.set(k.slice(3), v); n++ } else if (k.startsWith('us:')) { if (v && v.userShare) { splits.set(k.slice(3), v); n++ } } // nk: is derived from mk at keep(); nothing to hold in memory
        })
        parked.clear(); sealKey = key; protectedAtRest = true
        for (const [room, mk] of mks) { persist('mk:' + room, mk); deriveNotifKey(mk).then((nk) => persistNk(room, nk)).catch(() => {}) } // keys that reached the locked worker (the page re-sent them at open) are persisted sealed now
        for (const [room, sp] of splits) persist('us:' + room, sp)
        ms.open = performance.now() - t0
        if (n) publishPresence()
        self.postMessage({ id: m.id, result: { opened: n, ms } })
      } catch (err) { self.postMessage({ id: m.id, error: 'unseal: ' + String((err && err.message) || err) }) }
      return
    }
    case 'previews': {               // {id, on} → §PREVIEWS toggled while unlocked: rewrite every nk: clear (on) or sealed (off)
      nkClear = !!m.on
      try { if (sealKey) for (const [room, mk] of mks) { try { await persistNk(room, await deriveNotifKey(mk)) } catch { /* */ } } } catch { /* */ }
      if (m.id != null) self.postMessage({ id: m.id, result: { previews: nkClear } })
      return
    }
    case 'memoryOnly': {             // {id} → a room link on an unsecured computer: keys stay in memory, persist() writes nothing
      protectedAtRest = true; sealKey = null; setIdbNaming({ on: true }) // names on, no key: every write is dropped
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'relock': {                 // {id} → the lock engaged: nothing usable stays in memory
      if (sealKey) { mks.clear(); splits.clear(); parked.clear(); sealKey = null; setIdbNaming({ on: true }); publishPresence() } // unprotected devices keep their maps — a relock means nothing to them
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'unprotect': {              // {id, key} → switch OFF: open everything and write it back in the clear
      try {
        const key = await importSealKey(m.key)
        await keysReady; await armIdbNaming(m.key)
        // §NAMES: take every key from under its opaque name (or its real name, if the page moved it back first), then names off
        const held = []
        for (const pfx of ['mk:', 'us:']) for (const [k, v] of await idb.entries(pfx)) { held.push([k, v]); await idb.del(k) }
        setIdbNaming({ on: false })
        for (const [k, v] of await idb.entries('nk:')) if (isSealed(v)) held.push([k, v])
        for (const [k, v] of held) { const clear = isSealed(v) ? await openSealed(key, v) : v; await idb.set(k, clear); if (k.startsWith('mk:')) mks.set(k.slice(3), clear); else if (k.startsWith('us:') && clear && clear.userShare) splits.set(k.slice(3), clear) }
        parked.clear(); sealKey = null; protectedAtRest = false; nkClear = false; publishPresence()
        for (const [room, mk] of mks) deriveNotifKey(mk).then((nk) => persistNk(room, nk)).catch(() => {}) // the preview keys a protected device did not keep
        self.postMessage({ id: m.id, result: true })
      } catch (err) { self.postMessage({ id: m.id, error: 'unprotect: ' + String((err && err.message) || err) }) }
      return
    }
    case 'presenceQuery': {          // say which keys are held now, once the stored ones are in (a late frame asks: the tenant launch, 2026-10-16)
      await keysReady; publishPresence()
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'wipeKeys': { // root-vault only: parked/opaque keys count even when no room list can name them
      storageWiped = true; storageEpoch++
      await keysReady
      for (const h of streams.values()) h.s?.stop()
      streams.clear(); grantsByRoom.clear()
      mks.clear(); splits.clear(); parked.clear(); splitAlts.clear(); eps.clear(); heldOk.clear(); lastPos.clear()
      ids.clear()
      try { await idb.clearStrict(); self.postMessage({ id: m.id, result: true }) }
      catch (error) { self.postMessage({ id: m.id, error: String(error?.message || error) }) }
      finally { publishPresence() }
      return
    }
    case 'volatile': {               // {rooms} → these rooms' keys are memory-only from now on: drop what is stored, write nothing
      for (const r of (Array.isArray(m.rooms) ? m.rooms : [])) if (typeof r === 'string' && r && !volatile.has(r)) { volatile.add(r); keysReady.then(() => Promise.all([idb.del('mk:' + r), idb.del('us:' + r)])).catch(() => {}) } // its preview key stays (attNk): the room key never did
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'remember': {               // {room, mk} → store a key in the map (the worker becomes the mk store)
      // AFTER the boot scan: the stored key and its epoch are loaded first, so a launch's re-seed (no epoch) is judged against
      // them — before, the scan put the new key back in memory and the re-seed's queued write put the old one on disk
      keysReady.then(() => { if (m.room && m.mk) { keep(m.room, m.mk, m.ep); publishPresence() } if (m.id != null) self.postMessage({ id: m.id, result: true }) }) // m.ep: a re-keyed room's epoch (space.js adoptRoomKey)
      return
    }
    case 'create': {                 // {id, cfg, base} → mint a Space HERE (vault-core.js, docs/sdk-vault-mode.md): its key is born in
      // this worker and kept here; the reply carries the room and its share link (the vault keeps the link — it is the
      // key — and hands its page only the room id). The client must be open (endpoint/app) first.
      try {
        if (!client) throw new Error('l1-worker: create before open')
        // a SPLIT room is made through the builder's app-half function on this worker's own origin (the same one resolveMk asks)
        const via = m.split ? async (body) => { const x = await fetch(APPSHARE_URL, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await x.json().catch(() => ({})); return { ...(j && typeof j === 'object' ? j : {}), status: x.status } } : null
        if (m.delAsk) delAsking++
        let r
        try { r = await client.create(m.cfg || {}, { base: m.base || undefined, ...(m.enclave ? { enclave: true } : {}), ...(via ? { split: true, via } : {}) }) } finally { if (m.delAsk) delAsking-- }
        if (!r || !r.room || !r.mk) throw new Error('create: ' + String((r && (r.error || r.status)) || 'no room'))
        if (m.split) { if (!r.userShare) throw new Error('create: the app-half function gave no share'); keepSplit(r.room, { userShare: r.userShare, commit: r.commit || '' }) }
        keep(r.room, r.mk); publishPresence()
        const link0 = (r.links && r.links[0]) || null
        // a split room's link is the user's HALF (#us=…&spc=…), never the key; a confidential room's sealed config (ciphertext) rides back for the enclave's own copy
        const link = m.split && link0 ? String(link0).split('#')[0] + '#us=' + encodeURIComponent(r.userShare) + (r.commit ? '&spc=' + encodeURIComponent(r.commit) : '') : link0
        self.postMessage({ id: m.id, result: { room: r.room, link, ...(r.enclaveCreated === true ? { enclaveCreated: true } : {}), commit: r.commit || null, ...(r.configSealed ? { configSealed: r.configSealed } : {}), ...(m.returnMk ? { mk: r.mk } : {}) } }) // returnMk: the vault's own move needs the new key for its notice
      } catch (err) { self.postMessage({ id: m.id, error: String((err && err.message) || err) }) }
      return
    }
    case 'forget': {                 // {room} → DROP the key. AWAITS the idb deletes before replying: the caller holds
      // navigation until it resolves, and a dedicated worker dies with its page — a fire-and-forget delete could be
      // cut off mid-write, leaving the key in idb for the next worker to reload.
      try {
        await keysReady
        if (m.room) await forget(m.room)
        if (m.id != null) self.postMessage({ id: m.id, result: true })
      } catch (error) {
        if (m.id != null) self.postMessage({ id: m.id, error: String(error?.message || error) })
      } finally { publishPresence() }
      return
    }
    case 'setPushAcct': {            // {room} = the account's INDEX room → derive the account push secret from ITS key, here,
      // where the key lives (the page holds only the room id). Turns and subscriptions then carry the account tag, so the
      // server skips the poster's OTHER devices too (spaceClient pushAcctField).
      // {secret}: the secret itself (a one-way derivation, never a key), from a page that holds the index key on its own thread —
      // the builders' vault (vault-core.js; sync sweep 11-16 #14). '' clears it (signed out).
      try {
        if (typeof m.secret === 'string') { if (m.secret === '' || /^[A-Za-z0-9_-]{43}$/.test(m.secret)) setPushAcct(m.secret) }
        else { const mk = m.room ? (mks.get(m.room) || await resolveMk(m.room)) : ''; setPushAcct(await pushAcctSecretOf(mk || '')) }
      } catch { /* */ }
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'prefetchIdentity': {      // {token} → this worker's client fetches the sign-in's hints now (option B; sweep 11-06 #9)
      try { if (client && typeof client.prefetchIdentity === 'function') await client.prefetchIdentity(String(m.token || '')) } catch { /* */ }
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'setPushSelf': {            // {endpoint} → set THIS worker's spaceClient pushSelf. Turns are composed + POSTed
      // HERE (the worker's own spaceClient instance), so the main-thread setPushSelf never reached the POST — the turn
      // went out with no endpoint and the server fell back to the coarse author-NAME rule, skipping every device sharing
      // the sender's name. With the endpoint, the server skips only THIS device (mode=endpoint) and tickles the others.
      try { setPushSelf(m.endpoint || '') } catch { /* */ }
      // A stream opened before the endpoint arrived carries no viewing tag: reopen it with one (the server then skips this
      // device's tickle for the room on screen). Same room, same key; only the socket's name changes.
      for (const [room, h] of streams) {
        try { const tag = await viewingTag(room); if (tag && tag !== h.tag && h.mk) { h.s?.stop(); h.s = openStreamHere(room, h.mk, h.grants || null, tag); h.tag = tag } } catch { /* the old socket stays */ }
      }
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'serveKeyPort': {           // {room} + a transferred MessagePort → send this room's mk DOWN the port so a SIBLING
      // realm's worker (a same-origin docked lane panel) can adopt it WITHOUT the key ever crossing either main thread.
      // Fire-and-forget: no RPC reply — the port carries the answer ({mk:null} if we don't hold it → the caller falls back).
      const sp = e.ports && e.ports[0]
      if (sp && m.room) { try { const mk = mks.get(m.room) || await resolveMk(m.room); sp.postMessage({ room: m.room, mk: mk || null }) } catch { try { sp.postMessage({ room: m.room, mk: null }) } catch { /* */ } } }
      return
    }
    case 'adoptKeyPort': {           // {id, room} + a transferred MessagePort → RECEIVE this room's mk over the port (sent by a
      // sibling realm's worker) and store it in the key map. The main thread only relayed an opaque port; the key never
      // touches L2. Reply {ok} on the RPC channel once stored (false on a null answer / timeout) so the caller can fall back.
      const { id: aid, room: aroom } = m; const ap = e.ports && e.ports[0]
      if (!ap || !aroom) { if (aid != null) self.postMessage({ id: aid, result: { ok: false } }); return }
      let settled = false
      const settle = (ok) => { if (settled) return; settled = true; try { ap.close() } catch { /* */ } if (aid != null) self.postMessage({ id: aid, result: { ok } }) }
      ap.onmessage = (ev) => { const d = (ev && ev.data) || {}; if (d.mk && d.room === aroom) { keep(aroom, d.mk); publishPresence(); settle(true) } else settle(false) }
      setTimeout(() => settle(false), m.timeoutMs > 0 ? m.timeoutMs : 8000) // the SERVING side may need a live appshare fetch to reconstruct a split mk (resolveMk) — 1.5s lost that race on cellular and read as 'parent:no'
      return
    }
    case 'wakeup': { prefetchLookUntil = Date.now() + 8000; return } // the page came to the foreground (vault-loader.js / space.js onVisibility): look for a push-time prefetch on the polls that follow
    case 'ping': { self.postMessage({ t: 'pong', n: m.n | 0 }); return } // liveness heartbeat — the vault detects a RECLAIMED worker (iOS memory pressure) and recreates it; without this a dead handle ate every message silently and rooms stopped opening
    case 'rememberSplit': {          // {room, userShare, commit} → hold the user's HALF here (the confined split store); mk reconstructs on demand via resolveMk. The main thread never keeps the userShare in a live variable.
      keysReady.then(() => { if (m.room && m.userShare) { keepSplit(m.room, { userShare: m.userShare, commit: m.commit || '' }, m.ep); publishPresence() } if (m.id != null) self.postMessage({ id: m.id, result: true }) }) // after the boot scan, as `remember`
      return
    }
    case 'rememberId': {             // {room, identity} → hold the room's SIGNING IDENTITY here (the confined identity store). The turn op signs with it; the private signing key never crosses back to the app. Seeded by the vault at create/join and from the account backup. NB the identity travels as `identity` (not `id` — `id` is the RPC sequence field).
      if (m.room && m.identity && m.identity.sign && m.identity.sign.priv) ids.set(m.room, m.identity)
      if (m.id != null) self.postMessage({ id: m.id, result: true })
      return
    }
    case 'ensureMk': {               // {id, room} → reconstruct the room's mk HERE (fetch appShare ⊕ combine, commit-checked) + cache it; return only a BOOLEAN availability. mk never crosses back to the main thread — this is the split-room OPEN check without de-confining the key.
      const { id, room } = m
      try { const mk = await resolveMk(room); self.postMessage({ id, result: { ok: !!mk } }) }
      catch (err) { self.postMessage({ id, error: 'ensureMk: ' + String((err && err.message) || err) }) }
      return
    }
    case 'inviteLink': {             // {id, room, base, suffix} → the invite link, with the split key fragment (#us=…&spc=…) INJECTED here from the confined store. Main thread supplies only the non-secret base/suffix; it never sees the userShare. null if we hold no split for the room.
      const { id, room, base, suffix } = m
      try {
        const sp = splits.get(room)
        const link = (sp && sp.userShare)
          ? (base + '#us=' + encodeURIComponent(sp.userShare) + (sp.commit ? '&spc=' + encodeURIComponent(sp.commit) : '') + (suffix || ''))
          : null
        self.postMessage({ id, result: { link } })
      } catch (err) { self.postMessage({ id, error: 'inviteLink: ' + String((err && err.message) || err) }) }
      return
    }
    case 'open': {                   // capture the room's mk here; (re)create the client bound to this realm
      try {
        if (m.room && m.mk) keep(m.room, m.mk)
        // ONE CLIENT PER REALM (sync sweep 2026-11-07 #6): a room open in the SAME realm (endpoint · app · tenant) keeps the client
        // it has — what it learned (option B's prefetched `idextras` hints, gated/verified rooms, older key chains) is the
        // sign-in's and the rooms', not this open's. A new client on every open threw the hints away, so the first sealed request
        // after each open fetched them inline — the timing option B rules out. Every other option reads this worker's state live.
        const realm = JSON.stringify([m.endpoint || '/space', m.app || '', m.tenant || ''])
        if (client && clientRealm === realm) { publishPresence(); self.postMessage({ id: m.id, result: true }); return }
        clientRealm = '' // set again only once the new client is made
        client = makeSpaceClient({
          endpoint: m.endpoint || '/space',
          app: m.app,
          ...(m.tenant ? { tenant: m.tenant } : {}), // a builder's vault (vault-core.js): the Spaces it creates are its tenant's
          auth,
          mkPub: (r) => (encRooms.has(r) ? (() => { const e = encKeys[roomRegion(r)] || (roomRegion(r) === DEFAULT_REGION ? { key: encKey, attested: encAttested } : {}); return gatedKey({ key: e.key || null, trusted: encTrusted, attested: e.attested || null, platform: e.attested && e.attested.platform, room: r }) })() : null), // r's OWN region's key; another region's is never borrowed // trusted undefined until the account's list is known → the gate refuses
          enclave: (r) => encRooms.has(r),
          envelope: (r) => { if (!encRooms.has(r)) return false; const e = encKeys[roomRegion(r)] || (roomRegion(r) === DEFAULT_REGION ? { attested: encAttested } : {}); return opensEnvelopes(e.attested) }, // the sealed request envelope (reqEnvelope.js): this room's live enclave opens it
          identity: (r) => { if (!encRooms.has(r)) return false; const e = encKeys[roomRegion(r)] || (roomRegion(r) === DEFAULT_REGION ? { attested: encAttested } : {}); return sealsIdentity(e.attested) }, // option B: it takes the sign-in from inside
          // A Spaces ACCOUNT's turn token (accountBilling.js) — asked of the page through the auth channel under a reserved
          // name, only when an op can spend. No answer / no session ⇒ '' ⇒ the turn bills as before.
          userToken: async () => { const v = await auth('#account-billing'); return (v && typeof v.userToken === 'string') ? v.userToken : '' },
          // A builder's VAULT (vault-core.js) with an account backup: a create carries the deletion commitment, which only the
          // vault can make (it holds the erase key — sdkErase.js). Asked only while a create that said `delAsk` runs.
          delCommit: (r) => (delAsking > 0 ? askDel(r) : Promise.resolve(null)), // a promise either way: spaceClient .catch()es it
          // THE ROOM PASS (docs/device-gate-design.md): the page holds it (roomPassWiring.js) — asked under the reserved name
          // '#room-pass' with this request's op, room and sign-in (its email and key, never the token); {} = none (off)
          roomPass: {
            fieldsFor: async (body, o) => { const si = signInOf(body); if (!si) return {}; const v = await auth('#room-pass:' + JSON.stringify({ op: body.op, room: body.room, email: si.email, spk: si.spk, ...(o && Number.isFinite(o.ts) ? { ts: o.ts } : {}) })); return v && v.pass && v.psig ? { pass: v.pass, psig: v.psig } : {} }, // ts: this realm's sealNow — the server's clock as learned here
            renew: async (body) => { const si = signInOf(body); if (si) return auth('#room-pass:' + JSON.stringify({ renew: true, email: si.email })) },
          },
          // A SIGN-IN THAT NAMES NO APP (docs/device-gate-design.md § 12.1, `pass: app_unnamed`): renewed by whoever holds it — the
          // page, or the vault for an identity it seeded here — and, when it is one held here, kept here renewed too
          renewSignIn: async (body) => {
            const room = body && body.room
            if (!room || !signInOf(body)) return null
            const v = await auth(SIGNIN_RENEW_AUTH + ':' + room)
            if (v?.retryable) return { retryable: true }
            if (!v || typeof v.idToken !== 'string' || !v.spk) return null
            const id = ids.get(room)
            if (id && id.sign && JSON.stringify(id.sign.pub) === JSON.stringify(v.spk)) ids.set(room, { ...id, googleIdToken: v.idToken })
            return { idToken: v.idToken, spk: v.spk }
          },
        })
        clientRealm = realm
        publishPresence()
        self.postMessage({ id: m.id, result: true })
      } catch (err) {
        self.postMessage({ id: m.id, error: 'open: ' + String((err && err.message) || err) })
      }
      return
    }
    case 'acctSeal':                 // {obj} → a doc sealed under the ACCOUNT key (the server never holds it) · null without the key
    case 'acctOpen': {               // {doc} → its object · null when it will not open here
      ;(async () => {
        try {
          if (!acctKey) return self.postMessage({ id: m.id, result: null })
          const result = m.t === 'acctSeal' ? await sealDoc(acctKey, m.obj) : (isSealedDoc(m.doc) ? await openDoc(acctKey, m.doc) : null)
          self.postMessage({ id: m.id, result })
        } catch { self.postMessage({ id: m.id, result: null }) }
      })()
      return
    }
    case 'acctKey': {                // the account-store key (accountSeal.appStoreKey) — from the page's backup master, or the hosting vault's
      acctKey = m.key || null
      oldAcctKeys = Array.isArray(m.old) ? m.old.filter(Boolean) : []
      if (m.id != null) self.postMessage({ id: m.id, result: { ok: !!acctKey } })
      return
    }
    case 'indexRead': {              // Atlas: read an index doc, ABSORB room→mk pointers into the key store, return KEYLESS
      const { id, indexRoom, indexMk, name } = m
      // ⛔ keyless: the caller does not own this worker — the hosted app frame, through its vault (§HOIST; the vault
      // sets it on every relayed read of a frame that says so). It gets NO key back: no mkeys mirror, only which rooms are split
      // (`splits`: room → its commit, which is not secret — roomState isSplitRoom reads it) (the owner, 2026-11-13; docs/sdk-convergence.md)
      const keylessAsk = !!m.keyless
      try {
        if (!client) throw new Error('l1-worker: indexRead before open')
        await keysReady // so hasMk/presence reflect the FULL map right after an absorb (a half-loaded map reads as "no key")
        if (indexMk && !mks.get(indexRoom)) { keep(indexRoom, indexMk); publishPresence() } // the app passes the index ROOM's key so we can open the doc even when it was adopted from a backup
        const r = await acct.get(indexRoom, mks.get(indexRoom) || indexMk, name, { plainOpen: unzipDoc }) // SEALED on the device (accountStores.js); the plain doc read through until it moves
        if (!(r && r.status === 200 && r.state)) { self.postMessage({ id, result: { status: (r && r.status) || 0, state: null } }); return }
        let st = r.state
        const mirror = {} // → the main thread's localStorage cache (see below); `rooms` itself stays KEYLESS as before
        const splitRooms = {} // room → commit: which listed rooms are split, with no share (what a keyless caller is told)
        if (st && typeof st === 'object' && st.rooms && typeof st.rooms === 'object') {
          const keyless = {}; let replaced = 0 // held split shares the doc's copy differs from (see keepSplit / splitAlts)
          for (const rm of Object.keys(st.rooms)) { const e = st.rooms[rm] || {}; if (e.deleted) { const { mk: _dmk, ep: _dep, split: _ds, userShare: _du, commit: _dc, ...rest } = e; keyless[rm] = rest; continue } /* a DELETED Space's key is never taken back (2026-11-12: it returned on every sync and the delete ran again) */ if (e.split && e.userShare) { const held = splits.get(rm); if (keepSplit(rm, { userShare: e.userShare, commit: e.commit || '' }, e.ep) !== false) { if (held && held.userShare !== e.userShare) replaced++; mirror[rm] = { split: true, userShare: e.userShare, commit: e.commit || '' } } splitRooms[rm] = String(((splits.get(rm) || {}).commit) || e.commit || ''); const { split: _s, userShare: _u, commit: _c, ep: _sep, ...rest } = e; keyless[rm] = rest } else { if (e.mk && (mks.get(rm) === e.mk || (Number(e.ep) || 0) >= (eps.get(rm) || 0))) { keep(rm, e.mk, e.ep); mirror[rm] = { mk: e.mk } } const { mk, ep: _ep, ...rest } = e; keyless[rm] = rest } } // ABSORB — never a key OLDER than the one held (noteEp) → strip the key (mk, or a split room's userShare+commit)
          publishPresence()
          { const all = Object.keys(st.rooms); const bare = all.filter((rm) => { const e = st.rooms[rm] || {}; return !e.deleted && !(e.split && e.userShare) && !e.mk && !mks.has(rm) && !splits.has(rm) }); self.postMessage({ t: 'note', line: 'index read: ' + all.length + ' rooms · ' + (all.length - bare.length) + ' with a key here · ' + (bare.length ? 'NO KEY for ' + bare.map((rm) => rm.slice(0, 10)).join(' ') : 'none keyless') + (replaced ? ' · ' + replaced + ' held share(s) differ from the index copy' : '') }) } // the trail says which listed rooms this device cannot open — a fresh device's rooms read 401/422 for a day and nothing said why (2026-10-03)
          st = { ...st, rooms: keyless }
        }
        // ⚑ MIRROR the absorbed keys back to the main thread so it can cache them in localStorage, exactly as a room you
        // CREATE or JOIN here already does (space.js rememberMk writes both stores). Without this, an index-synced room's
        // key lived ONLY in the worker: the open path's synchronous first check missed it and every open had to round-trip
        // the worker (~600ms) while every other room opened instantly — the same key, two storage paths, two speeds.
        // This is a deliberate step AWAY from mk-confinement, chosen knowingly: the device already holds every
        // create/join key in localStorage, so confining only index-synced keys bought no real protection while costing
        // consistency. Real confinement means moving ALL keys into the worker (l1 `evictmk` / confineExistingLaneKeys),
        // not leaving one arrival path out.
        // ⛔ …but NEVER to a keyless caller (above): in the hosted app this answer crossed into the app frame and carried every
        // room key and split share of the account on every index sync. It gets `splits` alone.
        if (name === 'index' && st && typeof st === 'object') {
          for (const field of ['pipesRoom', 'msgsRoom']) {
            const ptr = st[field]
            if (!ptr?.room) continue
            if (ptr.mk) keep(ptr.room, ptr.mk)
            if (keylessAsk) st = { ...st, [field]: { room: ptr.room } }
          }
          publishPresence()
        }
        self.postMessage({ id, result: { status: 200, state: st, splits: splitRooms, ...(keylessAsk ? {} : { mkeys: mirror }), ...(Number.isInteger(r.v) ? { v: r.v } : {}) } }) // v: the version a write names (accountStores put ifV)
      } catch (err) { self.postMessage({ id, error: 'indexRead: ' + String((err && err.message) || err) }) }
      return
    }
    case 'indexWrite': {             // Atlas: build the index doc INJECTING each room's mk from the key store; gzip if large
      const { id, indexRoom, indexMk, name, patch, summary, by, ifV } = m
      try {
        if (!client) throw new Error('l1-worker: indexWrite before open')
        await keysReady // NEVER write the index from a half-loaded key map — an empty `mks` would strip every room's key (below)
        if (indexMk && !mks.get(indexRoom)) { keep(indexRoom, indexMk); publishPresence() } // index ROOM key passed by the app (adopted-from-backup case)
        let p = { ...(patch || {}) }
        let previousIndex
        if (p.rooms && typeof p.rooms === 'object') {
          // PRESERVE keys we don't hold. The patch arrives KEYLESS (indexRead strips keys before handing it up), so a room
          // whose key is missing from THIS worker used to be dropped outright — silently deleting that key from the shared
          // doc for every device, with no way back. Read the CURRENT doc first and carry its key material over verbatim
          // (and absorb it, self-healing this worker). Only a room whose key exists NOWHERE is dropped, as before.
          let cur = {}
          try {
            let s = null; const rr = await acct.get(indexRoom, mks.get(indexRoom) || indexMk, name, { plainOpen: unzipDoc })
            if (rr && rr.status === 200 && rr.state) s = rr.state
            previousIndex = s
            if (s && s.rooms && typeof s.rooms === 'object') cur = s.rooms
          } catch { /* read failed → fall back to inject-what-we-hold (the pre-existing behaviour) */ }
          const rooms = {}
          for (const rm of Object.keys(p.rooms)) {
            const e = p.rooms[rm] || {}
            if (e.deleted) { const { mk: _dmk, ep: _dep, split: _ds, userShare: _du, commit: _dc, ...rest } = e; rooms[rm] = rest; continue } // a deleted Space's entry carries no key (2026-11-12): the doc stops handing it back
            if (splits.has(rm)) { const sp = splits.get(rm); rooms[rm] = { ...e, split: true, userShare: sp.userShare, ...(sp.commit ? { commit: sp.commit } : {}), ...(eps.get(rm) ? { ep: eps.get(rm) } : {}) }; continue }
            const mk = mks.get(rm)
            if (mk) { rooms[rm] = { ...e, mk, ...(eps.get(rm) ? { ep: eps.get(rm) } : {}) }; continue } // + the key's epoch (noteEp)
            const prev = cur[rm] // we hold no key — keep whatever the doc already carries, and absorb it
            if (prev && prev.split && prev.userShare) { keepSplit(rm, { userShare: prev.userShare, commit: prev.commit || '' }, prev.ep); rooms[rm] = { ...e, split: true, userShare: prev.userShare, ...(prev.commit ? { commit: prev.commit } : {}), ...(prev.ep ? { ep: prev.ep } : {}) }; continue }
            if (prev && prev.mk) { keep(rm, prev.mk, prev.ep); rooms[rm] = { ...e, mk: prev.mk, ...(prev.ep ? { ep: prev.ep } : {}) }; continue }
            // no key here and none in the doc → drop (unchanged)
          }
          p.rooms = rooms
          publishPresence()
        }
        // ⛔ SEALED on the device — the doc carries every room key (accountStores.js); without the account key nothing is written
        if (name === 'index') for (const field of ['pipesRoom', 'msgsRoom']) {
          const ptr = p[field]
          if (!ptr?.room || ptr.mk) continue
          const saved = previousIndex?.[field]
          const mk = (saved?.room === ptr.room && saved.mk) || mks.get(ptr.room)
          if (!mk) throw new Error('The account room key is unavailable. Retry sync.')
          p[field] = { room: ptr.room, mk }
        }
        const r = await acct.put(indexRoom, mks.get(indexRoom) || indexMk, name, p, summary, by, { ifV }) // ifV: only over the version the app merged
        self.postMessage({ id, result: { status: (r && r.status) || 0, bytes: _jsonBytes(p), z: true, ...(r && r.error ? { error: r.error } : {}) } })
      } catch (err) { self.postMessage({ id, error: 'indexWrite: ' + String((err && err.message) || err) }) }
      return
    }
    case 'pipesRead': {              // Atlas pipes: read the pipes doc, ABSORB each pipe's shared+lane room→mk into the store, return KEYLESS
      const { id, pipesRoom, pipesMk, name } = m
      try {
        if (!client) throw new Error('l1-worker: pipesRead before open')
        if (pipesMk && !mks.get(pipesRoom)) { keep(pipesRoom, pipesMk); publishPresence() }
        const r = await acct.get(pipesRoom, mks.get(pipesRoom) || pipesMk, name) // SEALED on the device (accountStores.js)
        if (!(r && r.status === 200 && r.state)) { self.postMessage({ id, result: { status: (r && r.status) || 0, state: null } }); return }
        let st = r.state
        if (st && typeof st === 'object' && st.pipes && typeof st.pipes === 'object') {
          const keyless = {}
          for (const s of Object.keys(st.pipes)) { const pp = st.pipes[s] || {}; const out = { ...pp }
            if (pp.shared && pp.shared.room) { if (pp.shared.mk) keep(pp.shared.room, pp.shared.mk); const { mk, ...rest } = pp.shared; out.shared = rest }
            if (pp.lane && pp.lane.room) { if (pp.lane.mk) keep(pp.lane.room, pp.lane.mk); const { mk, ...rest } = pp.lane; out.lane = rest }
            // lane-to-lane rows (docs/spaces-linked-lanes.md): two lane endpoints, absorbed the same way
            for (const k of ['laneA', 'laneB']) { const ep = pp[k]; if (ep && ep.room) { if (ep.mk) keep(ep.room, ep.mk); const { mk, ...rest } = ep; out[k] = rest } }
            keyless[s] = out }
          publishPresence(); st = { ...st, pipes: keyless }
        }
        self.postMessage({ id, result: { status: 200, state: st, ...(Number.isInteger(r.v) ? { v: r.v } : {}) } }) // v: the version a write names (accountStores put ifV)
      } catch (err) { self.postMessage({ id, error: 'pipesRead: ' + String((err && err.message) || err) }) }
      return
    }
    case 'pipesWrite': {             // Atlas pipes: build the pipes doc INJECTING each pipe's shared+lane mk from the store
      const { id, pipesRoom, pipesMk, name, patch, summary, by, ifV } = m
      try {
        if (!client) throw new Error('l1-worker: pipesWrite before open')
        if (pipesMk && !mks.get(pipesRoom)) { keep(pipesRoom, pipesMk); publishPresence() }
        let pp = { ...(patch || {}) }
        if (pp.pipes && typeof pp.pipes === 'object') {
          const pipes = {}
          for (const s of Object.keys(pp.pipes)) { const e = pp.pipes[s] || {}; const out = { ...e }
            if (e.shared && e.shared.room) { const mk = mks.get(e.shared.room); out.shared = mk ? { ...e.shared, mk } : e.shared }
            if (e.lane && e.lane.room) { const mk = mks.get(e.lane.room); out.lane = mk ? { ...e.lane, mk } : e.lane }
            for (const k of ['laneA', 'laneB']) { const ep = e[k]; if (ep && ep.room) { const mk = mks.get(ep.room); out[k] = mk ? { ...ep, mk } : ep } } // lane-to-lane rows: both lanes' keys injected
            pipes[s] = out }
          pp.pipes = pipes
        }
        const r = await acct.put(pipesRoom, mks.get(pipesRoom) || pipesMk, name, pp, summary, by, { ifV }) // ⛔ sealed — the doc carries lane + shared keys
        self.postMessage({ id, result: { status: (r && r.status) || 0, ...(r && r.error ? { error: r.error } : {}) } })
      } catch (err) { self.postMessage({ id, error: 'pipesWrite: ' + String((err && err.message) || err) }) }
      return
    }
    case 'tempHold': {               // {ptr: {room, mk, sk}} → hold the temp index (its key memory-only, beside the others) → {ok, room}
      // From the hosted vault only in practice (its replay, its `index` answer, a frame's hand-over it relays after keeping the
      // pointer itself — vault-loader.js). No sk → refused: a list sealed under a key nobody keeps would be lost.
      const p = m.ptr || {}
      const ok = isTempRoomId(p.room) && typeof p.mk === 'string' && !!p.mk && typeof p.sk === 'string' && TEMP_SK.test(p.sk)
      keysReady.then(() => {
        if (ok) { keep(p.room, p.mk); tempPtr = { room: p.room, sk: p.sk }; publishPresence() } // kept as an opened room's key is (the frame's copy lived in the vault's app store before); the vault re-hands the pointer to a new worker
        if (m.id != null) self.postMessage({ id: m.id, result: { ok, room: ok ? p.room : null } })
      })
      return
    }
    case 'tempList': {               // {do: 'read' | 'add' | 'remove', add?: {room, title, mk?, userShare?, commit?}, rooms?, by} → {status, room, rooms (KEYLESS)}
      // Every listed room's key is ABSORBED here (as an open of the room puts it here — its preview key too); the caller gets the
      // list without them (keylessTempList) and opens the rooms through this worker.
      const { id } = m
      const answer = (result) => self.postMessage({ id, result })
      ;(async () => {
        try {
          if (!client) throw new Error('l1-worker: tempList before open')
          await keysReady
          if (!tempPtr) return answer({ status: 0, error: 'no_pointer' })
          const p = tempPtr, pmk = mks.get(p.room) || await resolveMk(p.room).catch(() => null)
          if (!pmk) return answer({ status: 0, error: 'no_key', room: p.room })
          const absorb = (list) => { for (const e of list) { if (!e || !isTempRoomId(e.room)) continue; if (e.mk) keep(e.room, e.mk); else if (e.userShare) keepSplit(e.room, { userShare: e.userShare, commit: e.commit || '' }) } publishPresence() }
          let list = null
          if (m.do === 'read') {
            const r = await tempStore.get(p.room, pmk, 'rooms')
            if (!(r && r.status === 200)) return answer({ status: (r && r.status) || 0, room: p.room })
            list = r.state && Array.isArray(r.state.rooms) ? r.state.rooms : null // null: no list there — the caller keeps what it has
          } else if (m.do === 'add') {
            const a = m.add || {}, room = a.room
            if (!isTempRoomId(room)) return answer({ status: 0, error: 'not_temp', room: p.room })
            const sp = splits.get(room)
            const fresh = a.mk ? { mk: a.mk } : a.userShare ? { userShare: a.userShare, commit: a.commit || '' } : (sp && sp.userShare) ? { userShare: sp.userShare, commit: sp.commit || '' } : mks.get(room) ? { mk: mks.get(room) } : null // the caller's material, else what this worker holds
            list = await editTempList(tempStore, p.room, pmk, (all) => addToTempList(all, { room, title: typeof a.title === 'string' ? a.title.slice(0, 120) : '', fresh }), m.by)
            if (!list) return answer({ status: 0, room: p.room })
          } else if (m.do === 'remove') {
            const rooms = (Array.isArray(m.rooms) ? m.rooms : []).filter(isTempRoomId)
            list = await editTempList(tempStore, p.room, pmk, (all) => removeFromTempList(all, rooms), m.by)
            if (!list) return answer({ status: 0, room: p.room })
          } else throw new Error('tempList: unknown ' + String(m.do))
          if (list) absorb(list)
          answer({ status: 200, room: p.room, rooms: list ? keylessTempList(list) : null })
        } catch (err) { self.postMessage({ id, error: 'tempList: ' + String((err && err.message) || err) }) }
      })()
      return
    }
    case 'streamOpen': {
      const { room } = m
      const grants = m.grants || grantsByRoom.get(room)
      let held = streams.get(room)
      if (held) {
        held.holders++
        if (Array.isArray(grants)) { held.grants = grants; held.s?.setGrants(grants) }
        return
      }
      held = { holders: 1, mk: null, s: null, tag: '', grants: Array.isArray(grants) ? grants : null }
      streams.set(room, held)
      try {
        await keysReady
        const mk = (typeof m.mk === 'string' && m.mk) || mks.get(room) || await resolveMk(room)
        if (streams.get(room) !== held) return
        if (!mk) { streams.delete(room); return }
        const tag = await viewingTag(room).catch(() => '')
        if (streams.get(room) !== held) return
        held.tag = tag; held.mk = mks.get(room) || mk
        held.s = openStreamHere(room, held.mk, held.grants, tag)
      } catch (error) { if (streams.get(room) === held) streams.delete(room) }
      return
    }
    case 'streamClose': {
      const held = streams.get(m.room)
      if (held && --held.holders <= 0) { held.s?.stop(); streams.delete(m.room) }
      return
    }
    case 'op': {                     // {id, op, room, args} → client[op](room, mks[room], …args) → {id, result}
      const { id, op, room, args } = m
      try {
        if (!client) throw new Error('l1-worker: op before open')
        try { await keysReady } catch { /* same cold-start race as resolveMk: never run an op against a half-loaded map */ }
        if (typeof client[op] !== 'function') throw new Error('l1-worker: unknown op ' + op)
        const aa = args || []
        // §ID-CONFINE: turn signature is (room, message, identity, opts). When the app sends NO identity (idconfine on),
        // sign with the identity CONFINED here (seeded by the vault) so the private signing key never leaves L1. A room we
        // hold no identity for stays unsigned (open/legacy), unchanged. Only substitutes when the arg is absent — an app
        // that still passes identity (flag off / email turn) is untouched.
        if (op === 'turn' && (aa[1] == null) && ids.has(room)) aa[1] = ids.get(room)
        const index = routingIndex(op)
        if (index >= 0 && aa[index] && typeof aa[index] === 'object') {
          const route = { ...aa[index] }
          aa[index] = route
          if (route.bridgeRoom && !route.bridgeMk) {
            const key = mks.get(route.bridgeRoom) || await resolveMk(route.bridgeRoom)
            if (key) route.bridgeMk = key
          }
          if (op === 'turn' && Array.isArray(route.links)) {
            route.links = await Promise.all(route.links.map(async link => {
              if (!link?.room || link.mk) return link
              const key = mks.get(link.room) || await resolveMk(link.room).catch(() => null)
              return key ? { ...link, mk: key } : link
            }))
          }
        }
        const mkHere = await resolveMk(room) // §9: reconstruct a split room's mk (fetch appShare + combine) on demand
        let result = null
        let pfNote = '' // what the prefetch lookup found, for the page's tap timeline ('' = not looked up)
        const afterTap = !!(aa[2] && typeof aa[2] === 'object' && aa[2].afterTap) // the page says this poll follows a notification tap
        if ((op === 'poll' || op === 'pollSealed') && mkHere && typeof client.decodeSealed === 'function' && (afterTap || Date.now() < prefetchLookUntil || prefetchFlag.has(room) || !prefetchChecked.has(room))) {
          // PREFETCHED AT PUSH TIME (prefetchPoll.js): the service worker fetched this room's new sealed entries when the
          // notification arrived. The first poll asking from that same position is answered from them at once, and the
          // network is still asked in the background — for freshness, and so the change inbox the first poll carries
          // is still registered with the server. Looked up on a room's FIRST poll in this worker's life (a cold start
          // after the tap) and whenever the service worker announced one (the worker was alive through the push).
          prefetchChecked.add(room); prefetchFlag.delete(room)
          let pfKey = 'prefetch:' + room, pf = await idbGet(pfKey)
          if (!pf) { pfKey = await prefetchHashKey(room); pf = await idbGet(pfKey) } // a TAIL, kept under a hash of the room (no position was known)
          if (!pf) pfNote = 'none stored'
          else {
            idbDel(pfKey) // once, whatever the verdict
            const why = prefetchUsable(pf, aa[1] | 0)
            if (why) pfNote = why + (why === 'position moved' ? ' (stored since ' + pf.sinceCount + ', asked since ' + (aa[1] | 0) + ')' : '')
            else {
              const pfAns = prefetchAnswer(pf, aa[1] | 0)
              if (!pfAns) pfNote = 'the tail does not reach this position'
              else try { const out = await client.decodeSealed(room, mkHere, aa[1] | 0, pfAns); if (out && out.status === 200) { result = { ...out, prefetched: true }; pfNote = pf.tail ? 'used (a tail from ' + pf.sinceCount + ')' : 'used'; client[op](room, mkHere, ...aa).catch(() => {}) } else pfNote = 'decoded to status ' + (out && out.status) } catch (e) { result = null; pfNote = 'decode failed: ' + String((e && e.message) || e).slice(0, 60) }
            }
          }
        }
        // THE ENTRY THE STREAM CARRIED (frameTails): a poll from exactly count-1 is answered from it at once — decoded with the
        // key here, the decoder the network path uses — and the network is still asked behind it (as for a prefetch).
        if (!result && (op === 'poll' || op === 'pollSealed') && mkHere && typeof client.decodeSealed === 'function' && frameTails.has(room)) {
          const ft = frameTails.get(room); frameTails.delete(room)
          if (ft && Date.now() - ft.at < FRAME_TAIL_MS && (aa[1] | 0) === ft.count - 1) {
            try {
              const out = await client.decodeSealed(room, mkHere, ft.count - 1, { status: 200, changed: true, count: ft.count, from: ft.count - 1, sealed: JSON.stringify({ v: 3, from: ft.count - 1, count: ft.count, boxes: [ft.box] }) })
              if (out && out.status === 200) { result = { ...out, fromFrame: true }; client[op](room, mkHere, ...aa).catch(() => {}) }
            } catch { /* the network answers below */ }
          }
        }
        if (!result && op === 'poll' && !mkHere) result = { status: 401, error: 'no_key', reason: noKeyReason(room) } // a keyless plaintext read: the server refuses it with a BARE 401 ({} — no error field, measured 2026-10-03), which the page could not tell from anything. Say it here, and spare the round trip.
        if (op === 'rekey' && splits.has(room)) aa[0] = { ...(aa[0] || {}), split: { userShare: splits.get(room).userShare } } // a SPLIT room rotates only the user's half (spaceClient.rekey)
        if (!result) result = await client[op](room, mkHere, ...aa)
        if (op === 'rekey' && result && result.status === 200 && result.newShare) { keepSplit(room, { userShare: result.newShare, commit: result.newCommit }, result.epoch); keep(room, result.newMk, result.epoch); publishPresence(); const { newMk: _nm, ...up } = result; result = { ...up, split: true } } // the full key stays HERE (the hosted rule: the frame never holds mk)
        else if (op === 'rekey' && result && result.status === 200 && result.newMk) { keep(room, result.newMk, result.epoch); publishPresence() } // A ROOM RE-KEYED IN PLACE (docs/key-rotation-design.md § (b)): this realm made the new key; it holds it from now on
        if (op === 'pollSealed' && !mkHere && result && result.status === 422) result = { ...result, error: 'no_key', reason: noKeyReason(room) } // the boxes came back and nothing here can open them: not a WRONG key — NO key (the owner's lock banner blamed the invite)
        // A WRONG REMEMBERED KEY IS NOT THE ROOM'S KEY. resolveMk takes the remembered plain key before the split entry, and
        // the remembered one is persisted here (idb mk:<room>) — so a wrong plain key, however it arrived, beat the correct,
        // commit-checked split key on every launch: the owner's confidential room drawn blank for weeks (2026-10-03), its
        // ten boxes opening fine with the key the split rebuilds. A read answering 422 'undecodable' from a room that HAS a
        // split entry drops the remembered key, rebuilds from the split (appShare ⊕ userShare, commit-checked) and asks once more.
        if ((op === 'poll' || op === 'pollSealed') && result && result.status === 422 && result.reason === 'undecodable' && splits.has(room) && mks.has(room)) {
          const stale = mks.get(room); mks.delete(room); idb.del('mk:' + room).catch(() => {})
          const fresh = await resolveMk(room).catch(() => undefined)
          if (fresh && fresh !== stale) { const again = await client[op](room, fresh, ...aa); if (again && typeof again === 'object') result = { ...again, rekeyed: true } }
          else if (stale) keep(room, stale) // nothing better — put it back rather than leave the room keyless
        }
        if (pfNote && result && typeof result === 'object') result = { ...result, prefetchNote: pfNote }
        if (op === 'poll' || op === 'pollSealed') { const pos = positionOf(result); const last = lastPos.get(room); if (pos && (!last || last.etag !== pos.etag || last.count !== pos.count)) { lastPos.set(room, pos); if (!protectedAtRest) idbSet('cnt:' + room, pos) /* §NAMES: a protected device keeps no room-named position (the push prefetch is off there) */ } }
        if (op === 'poll' || op === 'pollSealed') streamFeed(room, result) // a streaming room: the poll's reply text + fresh grants re-sync the stream
        try { self.postMessage({ id, result }) }        // structured-clone can throw on a non-cloneable result
        catch (ce) { self.postMessage({ id, error: 'result-clone(' + op + '): ' + String((ce && ce.message) || ce) }) }
      } catch (err) { // a tagged refusal (enclave_not_accepted) keeps its code + verdict so the app can show WHICH stage mismatched
        self.postMessage({ id, error: op + ': ' + String((err && err.message) || err), ...(err && err.code ? { code: err.code, verdict: err.verdict || null, room: err.room || null } : {}) })
      }
      return
    }
  }
}
