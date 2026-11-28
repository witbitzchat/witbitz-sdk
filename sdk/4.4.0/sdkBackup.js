import { associationTime } from './laneAssociation.js'
// spaces/public/sdkBackup.js — `wb.backup`: the ACCOUNT BACKUP for a builder's app, on the SAME vault our own app uses
// (2026-10-02, a builder: "a short recovery code instead of the restore link"; the owner: "why not use our account
// structure?"). Nothing new is invented here — it is the existing vault, reached from the SDK:
//
//   • backupVault.js: a random 32-byte MASTER SECRET seals the backup; each recovery method stores a WRAPPER of it.
//     Here the method is a RECOVERY CODE (recovery.js: 16 random bytes, typed as 44YW-572I-…).
//   • the store is `/v1/vault/*` (api.witbitz.chat) — content-blind: ids derived from the secrets, ciphertext only.
//   • a SPLIT room (https://witbitz.chat/docs/sdk-keys.md#split-key) is recorded with its assembled key as well as its half-key link (§3.4).
//   • the 2-of-2 recovery gate (design A): with an email, the gate record commits to it (an HMAC keyed by the code, so
//     the server can neither read nor guess the address). When the server enforces the gate, a restore needs the code
//     AND an emailed code (ENFORCE_GATE is on in every home since 2026-10-06); where it is off, the code alone restores. restore() handles both.
//
// SEPARATE PER APP, for free: each enable() mints its own master secret and code, so a builder's users get their own
// vault — it never mixes with the Witbitz app's, and one app's restore never touches another's. The writing origin is
// recorded beside the blob by the server (attribution, never permission).
//
// What the backup HOLDS: the rooms this client created or opened — each one's link (which carries its key), label, and
// for a lane, the Space it belongs to — enough for restore() to hand them back to openSpace / openLane.
// ⚑ The STATE (`wb.backup.state`) holds the master secret: persist it like the room links it protects, never send it.
import { newRecoveryCode, codeSecret, gateParams, emailCommit, seal, unseal } from './recovery.js'
import { recordFromRooms, roomsOfRecord, roomPin, tombOfRecord, keyInLink, vaultOwner, LEGACY_SDK_KIND, SDK_APP } from './accountRecord.js' // one account record for the app and the SDK; this module's original is LEGACY
import { applyPlan } from './backupRecord.js' // the Spaces app's restore rules, pure (docs/sdk-account-format-plan.md phase 1)
import { normUsageKey } from './usageReceipts.js'
import { indexRoomOf, mergeIndex } from './sdkAccount.js' // the account's derived index room — published in the record as the app's `indexRoom` pointer
import { newMasterSecret, backupLocation, wrapperLocation, enrollCredential, openWrapper } from './backupVault.js'

export const DEFAULT_VAULT_API = 'https://api.witbitz.chat/v1/vault'
const KIND = LEGACY_SDK_KIND
const MAX_ROOMS = 500

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
const ub64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const fail = (code, msg, extra = {}) => Object.assign(new Error('witbitz: ' + msg), { code, ...extra })
const is32 = (s) => { try { return typeof s === 'string' && ub64(s).length === 32 } catch { return false } }

// ── THE NEW ACCOUNT SERVICE (sdkBackupV2.js; the owner, 2026-11-16: "Yes. Do the sdk."): a builder's VAULT that names its tenant
//    installs it (`backup._v2`) and NEW accounts start there; a state with `v2` is an account there. Its parts, as they may be kept:
//    `svc` the service's record (acctV2App.js STATE_KEY: the account id, the service, the address), `bm` the BACKUP master (the
//    service's objects are sealed under it; a new recovery code replaces it — `master` stays the account's identity), `pending` a
//    new code's master kept before its activation, `dk` which of the vault's device keys is this account's, `checked` the last
//    status answer, `pb` the PREVIOUS backup masters (≤ 3, ≤ 30 days: a signed-out device's push address was sealed under the
//    master of its day — Codex sweep 2026-11-16 #1, as our vault's prevMasters). Anything else is dropped.
export function v2Of(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = {}
  const sv = x.svc
  if (sv && typeof sv === 'object' && typeof sv.acct === 'string' && sv.acct && sv.acct.length <= 200) {
    o.svc = { acct: sv.acct, base: String(sv.base || '').slice(0, 300), at: Number(sv.at) || 0, trust: sv.trust == null ? null : String(sv.trust).slice(0, 40),
      ...(sv.setup === 'pending' ? { setup: 'pending' } : {}), ...(typeof sv.address === 'string' && sv.address ? { address: sv.address.slice(0, 254) } : {}) }
  }
  if (is32(x.bm)) o.bm = x.bm
  if (x.pending && is32(x.pending.master)) o.pending = { master: x.pending.master, rid: typeof x.pending.rid === 'string' ? x.pending.rid.slice(0, 200) : null, at: Number(x.pending.at) || 0 }
  if (typeof x.dk === 'string' && /^[A-Za-z0-9]{8,32}$/.test(x.dk)) o.dk = x.dk
  if (Number.isFinite(x.checked) && x.checked > 0) o.checked = x.checked
  if (typeof x.erase === 'string' && x.erase.length <= 32768) o.erase = x.erase
  if (x.moving === true) { o.moving = true; if (x.moveMode === 'signed') o.moveMode = 'signed' }
  if (x.resetDraft === true) o.resetDraft = true
  if (typeof x.reset === 'string' && x.reset.length <= 4096) o.reset = x.reset
  if (typeof x.emailMove === 'string' && x.emailMove.length <= 4096) o.emailMove = x.emailMove
  const pb = keptPrevMasters(x.pb)
  if (pb.length) o.pb = pb
  return o
}
/** The previous backup masters still worth trying: ≤ 3, newest first, ≤ 30 days old (acctV2VaultWiring.js keptMasters). */
export const keptPrevMasters = (list, now = Date.now()) => (Array.isArray(list) ? list : []).filter((x) => x && is32(x.m) && Number(x.at) > 0 && now - Number(x.at) < 30 * 86400000).slice(0, 3).map((x) => ({ m: x.m, at: Number(x.at) }))
/** An account made on the service whose first recovery code is not active (or not adopted) here yet: kept, never "enabled" — the
 *  next enable() finishes it (an address with an account and no code could not start again). */
export const halfMade = (s) => !!(s && s.v2 && (s.v2.resetDraft || !s.v2.bm || (s.v2.svc && s.v2.svc.setup === 'pending')))
const notOnService = () => fail('not_on_service', 'this call is for an account on the Witbitz account service, in a vault that names its tenant (wb.backup.service === \'account\')')

/** One room as the backup records it. `link` carries the room key (the fragment), so the whole list is sealed. */
const roomOf = (r) => (r && typeof r === 'object' && typeof r.room === 'string' && r.room && typeof r.link === 'string' && r.link
  ? { room: r.room.slice(0, 120), ...roomPin(r), ...(typeof r.mintedFor === 'string' && r.mintedFor ? { mintedFor: r.mintedFor } : r.laneOrigin === 'minted' && r.shared ? { mintedFor: r.shared } : {}), ...(r.laneOrigin === 'minted' && !r.detachedLane ? { laneOrigin: 'minted' } : {}), ...(Number(r.associationAt) > 0 ? { associationAt: Number(r.associationAt) } : {}), ...(typeof r.renamed === 'boolean' ? { renamed: r.renamed } : {}), ...(Number.isFinite(r.at) && r.at > 0 ? { at: r.at } : {}), ...(r.archived ? { archived: true } : {}), ...(r.detachedLane ? { detachedLane: true } : {}), link: r.link.slice(0, 4000), kind: !r.detachedLane && r.kind === 'lane' ? 'lane' : 'space', ...(r.label ? { label: String(r.label).slice(0, 120) } : {}), ...(!r.detachedLane && r.kind === 'lane' && r.shared ? { shared: String(r.shared).slice(0, 120) } : {}), ...(typeof r.mk === 'string' && r.mk && r.mk.length <= 200 ? { mk: r.mk } : {}) }
  : null)

function stateOf(x) {
  const o = x && typeof x === 'object' ? x : null
  if (!o || typeof o.master !== 'string') return null
  try { if (ub64(o.master).length !== 32) return null } catch { return null }
  // `tomb` + `device` belong to the LIVE index (sdkAccount.js): a forgotten room's tombstone, and this device's id in the account.
  const tomb = (Array.isArray(o.tomb) ? o.tomb : []).filter((t) => t && typeof t.room === 'string' && Number.isFinite(t.at)).map((t) => ({ room: t.room.slice(0, 120), at: t.at })).slice(-500)
  const device = o.device && typeof o.device.id === 'string' ? { id: o.device.id.slice(0, 40), name: String(o.device.name || '').slice(0, 80), ...(o.device.made ? { made: true } : {}) } : null
  const links = (Array.isArray(o.links) ? o.links : []).filter((l) => l && typeof l.a === 'string' && typeof l.b === 'string' && Number.isFinite(l.at)).map((l) => ({ a: l.a.slice(0, 120), b: l.b.slice(0, 120), at: l.at, ...(Number.isFinite(l.cap) ? { cap: l.cap } : {}), ...(l.removed ? { removed: true } : {}) })).slice(-200)
  // `outs`: sign-outs of OTHER devices this device made, kept until the index carries them (sdkAccount.js signOut; pass 6, K#7)
  const outs = o.outs && typeof o.outs === 'object' ? Object.fromEntries(Object.entries(o.outs).filter(([id, at]) => typeof id === 'string' && id.length <= 40 && Number.isFinite(at)).slice(-50)) : {}
  return { v: 1, ...(Number.isSafeInteger(o.chatLockMarkPending) && o.chatLockMarkPending > 0 ? { chatLockMarkPending: o.chatLockMarkPending } : {}), ...(o.format === 'account' ? { format: 'account' } : {}), ...(Object.keys(outs).length ? { outs } : {}), master: o.master, ...(typeof o.savedVersion === 'string' && o.savedVersion.length <= 200 ? { savedVersion: o.savedVersion } : {}), rooms: (Array.isArray(o.rooms) ? o.rooms : []).map(roomOf).filter(Boolean).slice(0, MAX_ROOMS), ...(tomb.length ? { tomb } : {}), ...(links.length ? { links } : {}), ...(device ? { device } : {}), ...(o.email ? { email: String(o.email) } : {}), ...(inviteOf(o.invite) ? { invite: inviteOf(o.invite) } : {}), ...(normUsageKey(o.usage) ? { usage: normUsageKey(o.usage) } : {}), ...(usageOldOf(o.usageOld).length ? { usageOld: usageOldOf(o.usageOld) } : {}), ...(o.erased ? { erased: true } : {}), ...(v2Of(o.v2) ? { v2: v2Of(o.v2) } : {}) }
}
// the account's USAGE key (usageReceipts.js; the owner, 2026-10-23: a builder's app records the account's usage too) and the
// ones it replaced — kept in step between the devices by the live index (sdkAccount.js)
const usageOldOf = (a) => (Array.isArray(a) ? a.map(normUsageKey).filter(Boolean).slice(-5) : [])
// the account's invite key for this app (sdkRekey.js): kept as it was given, bounded
const inviteOf = (x) => (x && typeof x === 'object' && x.boxPub && x.boxPriv && typeof x.inbox === 'string' && JSON.stringify(x).length < 4000 ? JSON.parse(JSON.stringify(x)) : null)

export class AccountBackup {
  /** @param {object} o { fetch, base?, state?, email?: () => string } — `email` answers the signed-in address, if any. */
  constructor({ fetch: fetchImpl, base = DEFAULT_VAULT_API, state = null, email = () => '', tenant = '' } = {}) {
    this._fetch = fetchImpl
    this._base = String(base || DEFAULT_VAULT_API).replace(/\/+$/, '')
    this._s = stateOf(state)
    this._email = email
    this._tenant = tenant
    /** Called with the new state whenever it changes (a room added, a restore) — persist it there. */
    this.onState = null
    this._timer = null
    this._v2 = null // the new account service (sdkBackupV2.js accountService), installed by a builder's vault
  }

  /** JSON-safe state to persist (it holds the master secret), or null while no backup is set up. */
  get state() { return this._s && !this._isEnabling() ? JSON.parse(JSON.stringify(this._s)) : null }
  get enabled() { return !!this._s && !this._isEnabling() && !halfMade(this._s) }
  /** Where this account is kept: 'account' (the Witbitz account service — new accounts in a vault that names its tenant),
   *  'legacy' (the backup store every account used before), or null (no backup on this client). */
  get service() { return this._s && !this._isEnabling() ? (this._s.v2 && !(this._s.v2.moving && !this._s.v2.svc) ? 'account' : 'legacy') : null }
  /** @private ENABLING (pass 6, K#4): enable() is between its first await and its answer. The state exists (a Space opened
   *  meanwhile is queued in it) but is handed to nobody — not the app (onState), not the live index — until the vault copy,
   *  the recovery code and the gate are all saved. A failed enable then leaves nothing behind that reads "enabled". */
  _isEnabling() { return !!this._enabling && this._enabling === this._s }
  /** The rooms the backup holds: [{ room, link, kind: 'space'|'lane', label?, shared?, archived? }]. */
  get rooms() { return this._s ? this._s.rooms.map(({ at, ...r }) => r) : [] } // `at` is the live index's bookkeeping

  /** Set up the backup → `{ code }`. Show the code ONCE: it is the only way back if this device is lost. With an email
   *  (default: the signed-in session's), the recovery gate is enrolled too, so a restore can also be made to need it. */
  async enable({ email, address, getCode, showCode, initialRooms = [] } = {}) {
    if (this._s?.v2?.resetDraft) throw fail('email_move_pending', 'finish or cancel this device’s email move first')
    // one set-up at a time (review 2026-11-16: a second enable() during the first one's screens ran a second flow over the same state)
    if (this._isEnabling()) throw fail('already_enabling', 'the backup is being set up already')
    // an account the new service made whose first code did not go through: finished now, never a second one
    if (this._s && !(this._v2 && halfMade(this._s))) throw fail('already_enabled', 'the backup is already set up on this client (its state is wb.backup.state)')
    // IN A VAULT THAT NAMES ITS TENANT: the new account service (sdkBackupV2.js) — the vault's screens ask for the emailed code
    // (`getCode`) and show the recovery code (`showCode`) before it is activated. null = the service refused this vault's tenant
    // before anything was made: the old store, as before. `address`: one the person TYPED for the service (no sign-in) — never enrolled
    // as the old store's email gate on the way back (a typo would lock the backup behind a code mailed elsewhere; review 2026-11-16)
    const rooms = initialRooms.map(roomOf).filter(r => r && !r.room.startsWith('tmp-'))
    if (this._v2) { const r = await this._v2.enable(this, { email: address || email, getCode, showCode, rooms }); if (r) return r }
    const code = newRecoveryCode(), cs = codeSecret(code), master = newMasterSecret()
    const s = { v: 1, format: 'account', master: b64(master), rooms } // a new backup is written in the account format (accountRecord.js)
    this._s = s; this._enabling = s; this._enablingDirty = false
    // another account's state put in place meanwhile (_adopt / _drop / restore) ends this enable: it must not finish on that one
    const mine = () => { if (this._s !== s) throw fail('cancelled', 'the backup was replaced while it was being set up') }
    try {
      await this._write() // the backup itself first: a code that opens nothing is worse than no code
      mine()
      if (!(await enrollCredential(this._transport(), cs, master))) throw fail('enroll_failed', 'the recovery code could not be saved')
      mine()
      const addr = String(email || this._email() || '').trim().toLowerCase()
      if (addr) {
        const { gid, gk } = await gateParams(cs)
        const gate = { methods: ['email'], members: [(await backupLocation(master)).id, (await wrapperLocation(cs)).id], commit_email: await emailCommit(gk, addr) }
        const r = await this._post('/gate', { gid, gate })
        if (!(r.json && (r.json.ok || r.json.reason === 'exists'))) throw fail('gate_failed', 'the recovery email could not be recorded', { status: r.status })
        mine()
        s.email = addr
      }
    } catch (e) {
      const ours = this._s === s
      if (this._enabling === s) this._enabling = null
      if (ours) { this._s = null; this._changed() } // nothing was handed out, but say so: the app persists "no backup"
      throw e
    }
    const queued = this._enablingDirty
    this._enabling = null; this._enablingDirty = false
    this._onEnabled?.(s.master); this._changed(); this._started()
    if (queued) this._schedule() // a Space recorded while it was being set up: the vault copy and the index get it now
    return { code }
  }

  /** Record a Space or Lane (done for you as rooms are created and opened). `label` names it in a restore. */
  add(spaceOrLane, { label } = {}) {
    if (!this._s || !spaceOrLane || !spaceOrLane.room || !spaceOrLane.shareLink) return this
    if (String(spaceOrLane.room).startsWith('tmp-')) return this // a TEMPORARY room is never backed up (it is wiped) — whichever way it was opened (sync sweep 2026-10-27 #4)
    const lane = !!spaceOrLane._sharedRoom
    // A SPLIT room's link is half a key, so the backup also keeps the assembled key — a restore never depends on the
    // app half (https://witbitz.chat/docs/sdk-keys.md#split-key). A plain room's link already is the key.
    // a lane opened as a plain Space (wb.openSpace(laneLink)) knows nothing of its Space: the record it already has as a LANE
    // stays one — a restore must not bring it back as a Space (sync sweep 2026-11-02 #5)
    const had = this._s.rooms.find((x) => x.room === spaceOrLane.room)
    if (lane && (had?.detachedLane || (had?.shared && had.shared !== spaceOrLane._sharedRoom))) return this
    const wasLane = !lane && !spaceOrLane._detachedLane && had && had.kind === 'lane' && had.shared
    const r = roomOf({ room: spaceOrLane.room, link: spaceOrLane.shareLink, mintedFor: had?.mintedFor || spaceOrLane._mintedFor, laneOrigin: spaceOrLane._laneOrigin || had?.laneOrigin, associationAt: spaceOrLane._associationAt || had?.associationAt, kind: lane || wasLane ? 'lane' : 'space', detachedLane: spaceOrLane._detachedLane || had?.detachedLane, label, shared: lane ? spaceOrLane._sharedRoom : wasLane ? had.shared : undefined, mk: spaceOrLane._split ? spaceOrLane._mk : undefined })
    if (!r) return this
    const i = this._s.rooms.findIndex((x) => x.room === r.room)
    const prev = i >= 0 ? this._s.rooms[i] : null
    if (prev && prev.link === r.link && prev.kind === r.kind && prev.shared === r.shared && prev.laneOrigin === r.laneOrigin && prev.associationAt === r.associationAt && !!prev.detachedLane === !!r.detachedLane && prev.mk === r.mk && (!label || prev.label === r.label)) return this
    const next = { ...(prev ? { ...prev, ...r, ...(label ? {} : prev.label ? { label: prev.label } : {}), ...(prev.archived ? { archived: true } : {}) } : r), at: Date.now() } // `at`: the live index keeps the newer of each entry
    if (next.detachedLane) { delete next.shared; delete next.laneOrigin }
    if (i >= 0) this._s.rooms[i] = next; else { if (this._s.rooms.length >= MAX_ROOMS) return this; this._s.rooms.push(next) }
    this._schedule()
    return this
  }

  _attachLane(room, parent) {
    const entry = this._s?.rooms.find(r => r.room === room)
    if (!entry) throw Object.assign(new Error('Add the private room to the account first.'), { code: 'not_in_account' })
    if (entry.shared && entry.shared !== parent) throw Object.assign(new Error('Unlink this room from its current Space first.'), { code: 'already_linked' })
    if (entry.laneOrigin === 'minted' && entry.shared) entry.mintedFor ||= entry.shared
    if (entry.mintedFor === parent) entry.laneOrigin = 'minted'
    else delete entry.laneOrigin
    entry.kind = 'lane'
    entry.shared = parent
    delete entry.detachedLane
    entry.at = entry.associationAt = associationTime(entry)
    this._schedule()
  }

  _detachLane(room, shared) {
    const entry = this._s?.rooms.find((r) => r.room === room && r.kind === 'lane' && r.shared === shared)
    if (!entry) return
    if (entry.laneOrigin === 'minted') entry.mintedFor ||= entry.shared
    delete entry.laneOrigin
    delete entry.shared
    entry.kind = 'space'
    entry.detachedLane = true
    entry.at = entry.associationAt = associationTime(entry)
    this._schedule()
  }

  /** The account's invite key for this app, kept with the rooms (wb.invite hands it over; a restore gives it back). */
  get invite() { return this._s && this._s.invite ? { ...this._s.invite } : null }
  setInvite(state) {
    const v = inviteOf(state)
    if (!this._s || !v || JSON.stringify(this._s.invite || null) === JSON.stringify(v)) return this
    this._s.invite = v; this._schedule()
    return this
  }

  /** The whole key the backup holds for a SPLIT room, or null — so a restored device opens it without the app half. */
  // A room whose link IS its key answers null: a separate copy of it (an older SDK that restored a record carrying every room's
  // key spreads one through the index) may be stale after a change in place — the link is the one kept current.
  keyFor(room) { const r = this._s && this._s.rooms.find((x) => x.room === room); return (r && r.mk && !keyInLink(r.link) && r.mk) || null }

  /** Stop backing up one room (e.g. the user left it). It leaves a tombstone, so the account's other devices drop it too
   *  (wb.account) — opening the room again later brings it back. */
  remove(room) {
    if (!this._s) return this
    const n = this._s.rooms.length
    this._s.rooms = this._s.rooms.filter((x) => x.room !== room)
    if (this._s.rooms.length !== n) { this._s.tomb = [...(this._s.tomb || []).filter((t) => t.room !== room), { room, at: Date.now() }].slice(-500); this._schedule() }
    return this
  }

  /** The backup's record format: 'account' (the one the Spaces app uses) or 'legacy' (this SDK's original). */
  get format() { return this._s ? (this._s.format === 'account' ? 'account' : 'legacy') : null }
  /** Rewrite a LEGACY backup in the account format (the one the Spaces app uses). Same vault, code and rooms; a client
   *  on an older SDK can no longer restore it. Nothing does this for you. */
  async upgrade() {
    if (!this._s) throw fail('not_enabled', 'no backup is set up — call wb.backup.enable() first')
    if (this._s.format === 'account') return { format: 'account' }
    const was = this._s.format
    this._s.format = 'account'
    try { await this._write() } catch (e) { this._s.format = was; throw e }
    this._changed()
    return { format: 'account' }
  }

  /** Write the backup now (it is also written shortly after every change). */
  async save(verification) { clearTimeout(this._timer); this._timer = null; if (!this.enabled) throw fail('not_enabled', 'no backup is set up — call wb.backup.enable() first'); await this._write(verification); return { rooms: this._s.rooms.length } }
  /** True when enable() recorded an email gate: deleting (or restoring) this backup then needs the emailed code as well. */
  get gated() { return !!(this._s && this._s.email) }
  /** Enroll the currently signed-in address for an existing legacy backup. */
  async protectRecoveryEmail({ code } = {}) {
    const state = this._s, email = String(this._email() || '').trim().toLowerCase()
    if (!state?.master || state.v2?.svc) throw fail('legacy_required', 'open a legacy backup first')
    if (!email) throw fail('sign_in_required', 'sign in with your recovery email first')
    const cs = codeSecret(code || ''), wrapper = await wrapperLocation(cs)
    const stored = await this._get('/backup', '?id=' + wrapper.id)
    if (stored.status === 403 && stored.json?.reason === 'gated') throw fail('already_protected', 'the recovery code already has a recovery factor')
    const master = stored.json?.ok && await openWrapper(cs, stored.json.blob)
    if (!master || b64(master) !== state.master) throw fail('bad_code', 'use the recovery code for this backup')
    const { gid, gk } = await gateParams(cs)
    const gate = { methods: ['email'], members: [(await backupLocation(master)).id, wrapper.id], commit_email: await emailCommit(gk, email) }
    const guard = () => { if (this._s !== state || String(this._email() || '').trim().toLowerCase() !== email) throw fail('account_changed', 'the account changed during enrollment') }
    guard()
    const r = await this._post('/gate', { gid, gate })
    if (!r.json?.ok || r.json.reason === 'exists') throw fail(r.json?.reason === 'exists' ? 'already_protected' : 'gate_failed', 'the new recovery email could not be confirmed')
    guard()
    state.email = email
    this._changed()
    await this.save()
    return { enrolled: true }
  }
  /** @private A RELEASE TOKEN for this backup's email gate — what the server asks before it deletes a gated backup, as a
   *  gated restore (vaultBackupApi backupDelete). The first call (with the recovery `code`) mails a code and throws
   *  `email_code_required` with a `ticket`; the second (with `ticket` + `emailCode`) returns the token. */
  async _release({ code, email, ticket, emailCode } = {}) {
    if (ticket && emailCode) return this._emailVerify(ticket, emailCode)
    let cs
    try { cs = codeSecret(code) } catch { throw fail('code_required', 'this backup is protected by its email: pass its recovery code ({ code }) — a code is then emailed to it') }
    return this._emailStart(cs, String(email || (this._s && this._s.email) || this._email() || '').trim().toLowerCase())
  }
  /** @private the gate's emailed code → its release token */
  async _emailVerify(ticket, emailCode) {
    const v = await this._post('/email/verify', { ticket, code: String(emailCode).trim() })
    const token = v.json && v.json.ok ? v.json.token : null
    if (!token) throw fail('email_code_wrong', 'that email code did not verify', { status: v.status })
    return token
  }
  /** @private mail the gate's code to `addr`; always throws (email_code_required with a ticket, or why it could not) */
  async _emailStart(cs, addr) {
    if (!addr) throw fail('email_required', 'this backup needs its email as well as the code — pass `email`')
    const { gid, gk } = await gateParams(cs)
    const s = await this._post('/email/start', { gid, commit: await emailCommit(gk, addr), email: addr, gk: Array.from(gk, (b) => b.toString(16).padStart(2, '0')).join('') })
    // the server's own reason is the code when it gives one (update_required: an SDK too old for the gate's check) — a builder
    // could not tell "update the SDK" from "wrong address" (sync sweep, 10-17 #10)
    if (!(s.json && s.json.ok && s.json.ticket)) { const why = s.json && typeof s.json.reason === 'string' && /^[a-z_]{3,40}$/.test(s.json.reason) ? s.json.reason : 'email_refused'; throw fail(why, why === 'update_required' ? 'this backup\'s protection needs a newer SDK — load the latest release' : 'a code could not be sent to that address (it must be the one this backup was set up with)', { status: s.status }) }
    throw fail('email_code_required', `we emailed a code to ${addr} — call again with { code, ticket, emailCode }`, { ticket: s.json.ticket })
  }
  /** @private DELETE MY ACCOUNT (wb.erasure.deleteAccount): delete the vault copy (POST /v1/vault/backup/delete — the one
   *  route; 404 = already gone), with the gate's release token when the backup has one (sync sweep 11-08 #1: it posted to a
   *  path that does not exist and read the 404 as done). Leaves the local state — the erase drops it last. → { ok, status?, reason? } */
  async _deleteRemote(token = null) {
    if (!this._s) return { ok: true }
    if (this._s.v2) return { ok: false, status: 0, reason: 'this account is on the account service — wb.backup.deleteAccount() deletes it' }
    const loc = await backupLocation(ub64(this._s.master))
    const r = await this._post('/backup/delete', { id: loc.id, ...(token ? { token } : {}) })
    if ((r.status === 200 && r.json?.deleted === true) || r.status === 404) return { ok: true }
    return { ok: false, status: r.status, reason: (r.json && (r.json.error || (r.json.reason === 'incomplete' ? 'some old copies could not be deleted yet — run it again' : r.json.reason))) || ('backup ' + (r.status || 'unreachable')) }
  }

  /** Restore on a new device from the recovery code → `{ rooms }`, and this client now holds the backup.
   *  If the vault's gate requires the email, the first call mails a code and throws `code: 'email_code_required'` with
   *  a `ticket`; call again with `{ code, ticket, emailCode }`. `email` defaults to the signed-in address. */
  async restore({ code, email, ticket, emailCode, getCode, askAddress } = {}) {
    const epoch = this._restoreEpoch = (this._restoreEpoch || 0) + 1
    const owner = this._restoreIdentity?.() ?? this._email(), original = this._s
    const check = () => {
      if (epoch !== this._restoreEpoch || original !== this._s || owner !== (this._restoreIdentity?.() ?? this._email())) throw fail('account_changed', 'The account changed during recovery.')
    }
    if (this._s?.v2?.resetDraft) throw fail('email_move_pending', 'finish or cancel this device’s email move first')
    let cs
    try { cs = codeSecret(code) } catch { throw fail('bad_code', 'that is not a recovery code') }
    // THE NEW ACCOUNT SERVICE FIRST (a vault that names its tenant; `getCode` asks for its emailed code): a code that is no account
    // there (or a service that could not say) goes on to the old store below. A ticket of the old store's gate goes straight there.
    if (this._v2 && !(ticket && emailCode)) {
      const d = await this._v2.restore(this, { code, email, getCode, askAddress })
      check()
      if (d) { clearTimeout(this._timer); this._timer = null; this._s = stateOf(d); this._changed(); this._started(); return { rooms: this.rooms } }
    }
    const w = await wrapperLocation(cs)
    let token = null
    if (ticket && emailCode) token = await this._emailVerify(ticket, emailCode)
    const read = async (id) => {
      const r = token ? await this._post('/release', { token, id, builderRestore: true })
        : await this._get('/backup', '?id=' + id + '&builderRestore=1')
      if (r.json?.reason === 'other_app') throw fail('other_app', 'Open the app that created this backup to restore it.')
      if (r.json?.reason === 'backup_app_unknown' || (r.json?.ok && r.json.appVerified !== true)) {
        throw fail('backup_app_unknown', 'The backup service cannot verify which app created this recovery code.')
      }
      return r
    }
    let r = await read(w.id)
    if (r.status === 403 && r.json && r.json.reason === 'gated') await this._emailStart(cs, String(email || this._email() || '').trim().toLowerCase()) // throws: email_code_required (with a ticket) or why not
    if (r.status === 404) throw fail('not_found', 'no backup was found for that recovery code')
    const master = r.json && r.json.ok ? await openWrapper(cs, r.json.blob) : null
    if (!master) throw fail('unopenable', 'the backup for that code could not be opened', { status: r.status })
    const loc = await backupLocation(master)
    const b = await read(loc.id)
    if (!(b.json && b.json.ok)) throw fail(b.status === 404 ? 'not_found' : 'unreadable', 'the backup could not be read', { status: b.status })
    let doc
    try { doc = await unseal(loc.key, b.json.blob) } catch { throw fail('unopenable', 'the backup could not be opened') }
    // ⛔ This app's vault only — never a Witbitz account's (it would hold the key to every Space the person has).
    if (vaultOwner(doc) !== 'sdk') throw fail('not_sdk_backup', 'that code opens a backup made by a different app')
    // THROUGH THE SPACES APP'S RESTORE (backupRecord.js applyPlan) where its rule is the SDK's too: which rows come back — never
    // one the record itself marks deleted in `tombstones` (the SDK writes there only rooms it no longer holds, so a record from
    // any SDK loses nothing) — and the invite key (whole, or none). The SDK's own forget (`tomb`) is NOT applied: it is
    // re-openable, a room opened again after one comes back. A fresh state: nothing on this client to keep. A LEGACY record
    // is not in the account format: no plan, read as before.
    const plan = applyPlan(doc, {}, { app: SDK_APP })
    const invite = plan ? plan.inviteKey : doc.inviteKey
    check()
    this._s = stateOf({ master: b64(master), savedVersion: b.json.ver, rooms: roomsOfRecord(plan ? { ...doc, recents: plan.add } : doc), tomb: tombOfRecord(doc), ...(doc.email ? { email: doc.email } : {}), ...(invite ? { invite } : {}), ...(doc.kind === KIND ? {} : { format: 'account' }) })
    this._changed(); this._started()
    return { rooms: this.rooms }
  }

  // ── THE ACCOUNT SERVICE'S OWN CALLS (an account with service === 'account'; a builder's vault runs them, its screens asking
  //    the person for the emailed code — `getCode` — and showing a new code — `showCode`).
  /** Sign out every OTHER device of this account: each one forgets the account at its next status check. */
  async signOutOthers({ getCode } = {}) { if (!this._v2) throw notOnService(); return this._v2.signOutOthers(this, { getCode }) }
  /** A new recovery code (shown before it is activated): the old code stops working and every other device is signed out. */
  async newRecoveryCode({ getCode, showCode } = {}) { if (!this._v2) throw notOnService(); return this._v2.newRecoveryCode(this, { getCode, showCode }) }
  /** Delete this account on the account service (every device signed out, the address freed, the backup gone); this client then
   *  holds no account. The Spaces themselves are not deleted by this call. */
  async deleteAccount({ getCode } = {}) { if (!this._v2) throw notOnService(); return this._v2.deleteAccount(this, { getCode }) }
  async manageSecurityKeys() { throw fail('vault_required', 'manage account security keys in the account’s vault') }
  async migrate({ code, getCode, silent = false } = {}) { if (!this._v2) throw notOnService(); return this._v2.migrate(this, { code, getCode, silent }) }
  async beginEmailMove(opts = {}) { if (!this._v2) throw notOnService(); return this._v2.beginEmailMove(this, opts) }
  async pendingEmailMove() { if (!this._v2) throw notOnService(); return this._v2.pendingEmailMove(this) }
  async finishEmailMove(opts = {}) { if (!this._v2) throw notOnService(); return this._v2.finishEmailMove(this, opts) }
  async cancelPendingEmailMove(opts = {}) { if (!this._v2) throw notOnService(); return this._v2.cancelPendingEmailMove(this, opts) }
  async emailMove() { if (!this._v2) throw notOnService(); return this._v2.emailMove(this) }
  async requestMoveTime() { if (!this._v2) throw notOnService(); return this._v2.requestMoveTime(this) }
  async cancelEmailMove({ getCode } = {}) { if (!this._v2) throw notOnService(); return this._v2.cancelEmailMove(this, { getCode }) }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────
  _schedule() { if (this._isEnabling()) { this._enablingDirty = true; return } this._persist(); if (typeof this._onLocal === 'function') { try { this._onLocal() } catch { /* the live index */ } } }
  /** Write the vault copy soon and hand the app the new state — without telling the live index (it is the caller). */
  _persist() { if (this._isEnabling()) { this._enablingDirty = true; return } if (this._s && this._s.erased) { this._changed(); return } clearTimeout(this._timer); this._timer = setTimeout(() => { this._timer = null; if (this._s) this._write().catch((e) => { this.lastError = e }) }, 400); this._changed() }
  /** This device was signed out of the account (wb.account): forget it here, and tell the app to persist that. */
  _drop() { this._restoreEpoch = (this._restoreEpoch || 0) + 1; clearTimeout(this._timer); this._timer = null; this._s = null; this._changed() }
  /** @private take another persisted state in place (a vault switching accounts keeps one backup per account) */
  _adopt(state) { this._restoreEpoch = (this._restoreEpoch || 0) + 1; clearTimeout(this._timer); this._timer = null; this._s = stateOf(state); this._changed() }
  _started() { if (typeof this._onStart === 'function') { try { this._onStart() } catch { /* the live index */ } } }
  _changed() { if (this._isEnabling()) return; if (typeof this.onState === 'function') { try { this.onState(this.state) } catch { /* the app's callback must not break the backup */ } } }
  async _write(verification) {
    if (this._migrating) return // the move pins the old head; its completion writes all rooms to the new service
    if (this._s && this._s.v2 && this._s.v2.moving && !this._s.v2.svc) throw fail('migration_pending', 'retry migration to learn whether the service committed; no backup was overwritten')
    // ★ THE STATE IT BEGAN WITH (pass 6, K#2): `master` and the location were this account's, but the rooms, email and invite key
    //   were read again after the awaits — an account switch meanwhile sealed the next account's rooms into this one's backup.
    const s0 = this._s
    if (!s0) return
    if (s0.erased) throw fail('deleted', 'this backup was deleted with its account')
    // an account on the NEW SERVICE is written there, and only there — never to the old store
    if (s0.v2) { if (!this._v2) throw fail('service_unavailable', 'this account is on the Witbitz account service — only its vault can write it'); return this._v2.write(this, s0) }
    const master = ub64(s0.master)
    const loc = await backupLocation(master)
    // ★ ONLY OVER THE VERSION WE READ (sync sweep 2026-11-09, 11-08 #32; the app's backup.js pushBackup since the 10-05 review):
    // two devices of one backup each wrote their own list whole, so the room one added vanished at the other's next save. Each
    // write reads the backup first, keeps the rooms another device added (never one this device forgot — its tombstone), and
    // A gated read supplies only a version. Reuse our complete local copy
    // only when the service identifies it as the last version we saved.
    let releaseToken
    for (let attempt = 0; attempt < 4; attempt++) {
      let cur = await this._get('/backup', '?id=' + loc.id)
      if (this._s !== s0) return // another account's state is in place now: its own write follows
      if (cur.status === 404 && cur.json && cur.json.deleted === true) { s0.erased = true; this.lastError = null; this._changed(); return } // pass 7, F#2/F#10: deleted with its account
      if (cur.status === 403 && cur.json?.reason === 'gated' && (!s0.savedVersion || s0.savedVersion !== cur.json.ver)) {
        if (!verification) throw fail('backup_verification_required', 'Verify the recovery email to merge the latest backup before saving')
        releaseToken ||= await this._release(verification)
        if (this._s !== s0) return
        cur = await this._post('/release', { token: releaseToken, id: loc.id })
        if (this._s !== s0) return
        if (cur.status !== 200) throw fail('backup_unreadable', 'The verified backup could not be read before saving')
      }
      const ver = cur.json && typeof cur.json.ver === 'string' && cur.json.ver ? cur.json.ver : undefined
      let remote = { rooms: [], tomb: [] }
      const absent = cur.status === 404 && cur.json?.reason === 'not_found'
      const ownGatedVersion = cur.status === 403 && cur.json?.reason === 'gated' && ver && ver === s0.savedVersion
      if (!absent && !ownGatedVersion) {
        if (cur.status !== 200 || !cur.json?.ok || typeof cur.json.blob !== 'string' || !ver) throw fail('backup_unreadable', 'Could not read the current backup before saving')
        const doc = await unseal(loc.key, cur.json.blob)
        if (vaultOwner(doc) !== 'sdk') throw fail('backup_unreadable', 'The existing backup could not be opened as this account')
        remote = { rooms: roomsOfRecord(doc).map(roomOf).filter(Boolean), tomb: tombOfRecord(doc) }
      }
      const { rooms, tomb } = mergeIndex({ rooms: s0.rooms, tomb: s0.tomb }, remote, MAX_ROOMS)
      // The format this backup already has: the account record (accountRecord.js), or the LEGACY one it was made with —
      // never changed under the builder's feet (upgrade() does it on request).
      // The account record also names the account's index room (phase 2: the app's `indexRoom` pointer, derived from the master
      // — the same room sdkAccount.js syncs; a legacy record stays as it was written).
      const doc = s0.format === 'account'
        ? recordFromRooms({ rooms, tomb, email: s0.email, inviteKey: s0.invite, indexRoom: await indexRoomOf(s0.master) })
        : { kind: KIND, v: 1, at: Date.now(), rooms, ...(tomb.length ? { tomb } : {}), ...(s0.email ? { email: s0.email } : {}), ...(s0.invite ? { inviteKey: s0.invite } : {}) }
      const blob = await seal(loc.key, doc)
      if (this._s !== s0) return
      const bindBuilder = this._enabling === s0
      const r = await this._post('/backup', { id: loc.id, blob, ifVer: ver ?? null, returnVersion: true, ...(bindBuilder ? { bindBuilder: true } : {}) })
      if (bindBuilder && r.json?.ok && r.json.appVerified !== true) throw fail('app_binding_unavailable', 'The backup service must support app-specific recovery before a new code can be created.')
      if (r.status === 409) { await new Promise((res) => setTimeout(res, 100 + Math.floor(Math.random() * 300))); continue } // another device wrote since our read
      // ⛔ DELETED WITH ITS ACCOUNT (state machines pass 7, F#2): an erase that stopped half way (or ran on another device) left
      //   this client writing it; the server refuses to bring it back (410). Final: the state says so (the app persists it) and
      //   no later change schedules a write — quietly, the backup is gone on purpose.
      if (r.status === 410) { if (this._s === s0) { s0.erased = true; this.lastError = null; this._changed() } return }
      if (!(r.json && r.json.ok)) throw fail('save_failed', 'the backup could not be saved', { status: r.status, reason: r.json && r.json.reason })
      if (this._s !== s0) return
      const adopted = mergeIndex({ rooms: s0.rooms, tomb: s0.tomb }, { rooms, tomb }, MAX_ROOMS)
      s0.rooms = adopted.rooms
      s0.tomb = adopted.tomb
      s0.savedVersion = r.json.ver || undefined
      this._changed()
      this.lastError = null
      return
    }
    throw fail('save_failed', 'the backup kept changing under this save (another device writing) — the next change tries again', { status: 409 })
  }
  /** @private Was this backup deleted with its account — by an erase on another device (state machines pass 7, F#10)? The server
   *  says so on a read (404 `deleted`); the state then says so too (the app persists it), and nothing writes it again. */
  async _checkErased() {
    const s0 = this._s
    if (!s0) return false
    if (s0.erased) return true
    if (s0.v2) return false // the account service signs a deleted account's devices out: the vault's status check
    const loc = await backupLocation(ub64(s0.master))
    const r = await this._get('/backup', '?id=' + loc.id)
    if (!(r.status === 404 && r.json && r.json.deleted === true) || this._s !== s0) return false
    s0.erased = true; clearTimeout(this._timer); this._timer = null; this._changed()
    return true
  }
  _transport() {
    return {
      put: async (id, blob) => { const r = await this._post('/backup', { id, blob, bindBuilder: true }); return !!(r.json?.ok && r.json.appVerified === true) },
      get: async (id) => { const r = await this._get('/backup', '?id=' + id); return r.json && r.json.ok ? r.json.blob : null },
    }
  }
  async _get(path, qs = '') { return this._req('GET', path + qs) }
  async _post(path, body) { return this._req('POST', path, body) }
  async _req(method, path, body) {
    try {
      if (this._tenant) {
        if (body) body = { ...body, builderTenant: this._tenant }
        else path += (path.includes('?') ? '&' : '?') + 'builderTenant=' + encodeURIComponent(this._tenant)
      }
      const res = await this._fetch(this._base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
      let json = null; try { json = await res.json() } catch { json = null }
      return { status: res.status, json }
    } catch { return { status: 0, json: null } }
  }
}
