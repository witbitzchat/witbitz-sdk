// sdkRekey.js — A VERIFIED ROOM CHANGES ITS MEMBERS IN PLACE, in a builder's app (https://witbitz.chat/docs/sdk-people.md#members;
// docs/key-rotation-design.md § (b)). The Spaces app's rule (rekeyMembers.js), with the key held by the Space itself:
//   • wb.invite — the account's INVITE KEY for this app: an ECDH box whose public half is in the directory under the app's own
//     scope ('app:<origin>', the sign-in's app — the server refuses any other app writing it). A member change seals the room's
//     new key to it. The builder keeps `wb.invite.state` as it keeps `wb.a2a.state` (it holds a private key) and hands it back
//     as `new Witbitz({ invite })`; a second device without it never takes over the slot (it would cut the first one off).
//   • space.changeMembers({ emails, … }) / space.rotateKey() — a new key, the config with the old key in its chain, one grant
//     per remaining member (spaceClient.rekey); the same room, link, history and lanes.
//   • a device holding the old key meets `stale_key` → fetches its grant (op 'grant'), opens it with the invite key, checks it
//     against the room's commitment, takes it → 'rekeyed'. No grant → 'removed'; on the list but nothing sealed → 'pending'.
// One scope per app: a member reached only in another app (or only in the Spaces app) gets 'pending' — "ask for a fresh link".
import { enroll, resolveHandle } from './inviteEnroll.js'
import { genRecipientKey, openBox, commit, combineShares } from './e2ee.js'
import { tokenApp, tokenClaims } from './accountScope.js'
import { lc, recipientsFor, membersAfter, unseenHidden, stillOnList, dropsForUsers } from './memberChange.js'
import { ROSTER_DOC } from './roomRoster.js'
import { hide } from './sdkRedact.js'
import { memberHash } from './rosterHash.js'

const sdkError = (message, code) => Object.assign(new Error(message), { code })

/** The directory scope a sign-in enrols under: 'app:<the app it speaks for>'; '' for a first-party sign-in (the Spaces app's own). */
export function inviteScope (idToken) {
  const app = tokenApp(tokenClaims(idToken))
  return app == null ? '' : 'app:' + app
}

const validState = (s) => !!(s && typeof s === 'object' && s.boxPub && s.boxPriv && typeof s.inbox === 'string' && s.inbox)

/** wb.invite — this account's invite key for this app (see the header). */
export class InviteAccount {
  constructor (wb, { state = null } = {}) {
    this._wb = wb
    this._state = validState(state) ? { ...state } : null
    this._enrolling = null
    this._waiting = new Set() // Spaces told 'pending' for want of this key (adoptGrant) — woken by restore()
    this.status = this._state ? 'held' : 'none' // 'none' | 'held' | 'enrolled' | 'held_elsewhere' | 'failed'
    hide(this, ['_wb', '_state', '_waiting'])
  }
  /** What to persist (it holds a private key — keep it as you keep the session), or null. */
  get state () { const k = this._key(); return k ? { ...k } : null }
  // the state handed in, else the account backup's (a restored device), else none
  _key () {
    if (this._state) return this._state
    const b = this._wb && this._wb.backup && this._wb.backup.invite
    if (validState(b)) { this._state = { ...b }; this.status = 'held' }
    return this._state
  }
  /** Hand back a persisted state (also `new Witbitz({ invite })`). */
  restore (state) {
    if (!validState(state)) throw sdkError('witbitz: invite.restore needs a state from wb.invite.state', 'invalid_argument')
    this._state = { ...state }; this.status = 'held'
    for (const sp of [...this._waiting]) { this._waiting.delete(sp); try { sp._keyAt = 0; sp._keyMiss = null; sp._kick() } catch { /* */ } } // a Space waiting for a key it could not open tries at once — its grant backoff too (pass 6, K#5: the kicked poll's adoption was refused by it, up to 60 s)
    try { if (typeof this._onRestore === 'function') this._onRestore() } catch { /* the vault's */ }
    return this
  }
  /** Publish this account's invite key for this app (after signIn / refreshSession — the SDK runs it). Idempotent. A slot that
   *  already holds ANOTHER key (another device of this account, without this state) is left as it is: status 'held_elsewhere'
   *  — restore that device's state here, or from the account backup. → the status. */
  async enroll () {
    if (this._enrolling) return this._enrolling
    this._enrolling = this._enroll().finally(() => { this._enrolling = null })
    return this._enrolling
  }
  async _enroll () {
    const wb = this._wb, s = wb && wb._session
    if (!s || !s.idToken || !s.email) return this.status
    const client = wb._client
    if (!client || typeof client.dirPut !== 'function' || typeof client.oprf !== 'function') return this.status
    const scope = inviteScope(s.idToken)
    const email = lc(s.email)
    try {
      // NEVER TAKE OVER ANOTHER DEVICE'S SLOT: the box published under this account's handle wins. This device publishes only when
      // the slot is empty or already holds the key this device holds (read AFTER the lookup: a restore may land meanwhile)
      const handle = await resolveHandle(email, client, scope)
      const g = handle ? await client.dirGet(handle, { idToken: s.idToken, ...(scope ? { scope } : {}) }) : null // as its owner: a slot hidden from lookups still answers
      const mine = this._key()
      const usable = mine && (mine.scope == null || mine.scope === scope) && (mine.email == null || lc(mine.email) === email)
      const published = g && g.status === 200 && g.entry && g.entry.boxPub
      const held = usable && published && JSON.stringify(g.entry.boxPub) === JSON.stringify(mine.boxPub)
      if (published && !held) { this.status = 'held_elsewhere'; return this.status }
      if (!g || (g.status !== 200 && g.status !== 404)) throw new Error('directory_unavailable: ' + ((g && (g.error || g.status)) || 'no answer')) // unknown is not empty: never mint over a slot that may exist
      const next = await enroll({ email, idToken: s.idToken, client, genRecipientKey, scope, load: () => (usable ? mine : null), save: () => {} })
      if (next) { this._state = { boxPub: next.boxPub, boxPriv: next.boxPriv, inbox: next.inbox, handle: next.handle, scope, email }; this.status = 'enrolled' }
      try { if (wb.backup && this._state) wb.backup.setInvite(this._state) } catch { /* the backup is best-effort */ }
    } catch (e) { this._error = String((e && e.message) || e); this.status = this._state ? 'held' : 'failed' }
    return this.status
  }
}

// THE LINK FOLLOWS THE KEY: `#mk=` (or a split room's `#us=…&spc=…`) is replaced; every other mark (gate, tier) stays.
export function relink (link, { mk = null, userShare = null, commit: spc = null } = {}) {
  const s = String(link || '')
  const i = s.indexOf('#')
  if (i < 0) return s
  const keep = s.slice(i + 1).split('&').filter((p) => p && !/^(mk|s|us|spc)=/.test(p))
  const key = userShare ? ['us=' + encodeURIComponent(userShare), ...(spc ? ['spc=' + encodeURIComponent(spc)] : [])] : mk ? ['mk=' + mk] : []
  return s.slice(0, i) + '#' + [...key, ...keep].join('&')
}
const fragParam = (link, k) => { const m = new RegExp('[#&]' + k + '=([^&]*)').exec(String(link)); return m ? decodeURIComponent(m[1]) : '' }

// ON THE LIST, BUT NO KEY THIS DEVICE CAN TAKE: 'pending' once per reason (the poll slows meanwhile) — send this member the link again
function waiting (space, reason) {
  const was = space._keyWait
  space._keyWait = reason
  try { if (space._wb && space._wb.invite) space._wb.invite._waiting.add(space) } catch { /* */ }
  if (was !== reason) space._emit('pending', { room: space.room, reason })
  return null
}

/** The answer to op 'grant', opened with this account's invite key and checked against the room's commitment — one reading for a
 *  Space (below) and a vault (vault-core.js, whose worker holds the key). → { mk, epoch } | { userShare, commit, epoch } (a split
 *  room's new user half) | { removed:true } | { wait: reason } */
export async function openGrant (r, room, invite, { gated: markGated = true } = {}) {
  const gated = (r && r.gated === true) || markGated // the server says so (spaceRoom op grant, only ever true); else the link's mark
  // A LINK SPACE (not email-gated) changed in place seals its key to its members' SIGNING keys, which only the Spaces app holds
  // (rekeyMembers linkProof) — an account has no grant there, so "no grant" is not "removed": ask for the link again
  // (sweep 10-23 #17: the SDK and the vault said 'removed', or waited for ever)
  if (!gated && (!r || r.status === 404 || r.status === 401)) return { wait: 'link_changed' }
  // a VERIFIED room answering 401: the sign-in lapsed — say so (the app asks for one, rekeyMembers.js signInNeeded); it was a silent
  // 'grant_unavailable' (sync sweep 2026-11-14 #6)
  if (gated && r && r.status === 401) return { wait: 'sign_in_required' }
  if (!r || r.status !== 200 || !r.grant) return r && r.status === 404 ? { removed: true } : { wait: 'grant_unavailable' }
  if (r.grant === 'pending') return { wait: 'pending' }
  if (!invite || !invite.boxPriv) return { wait: 'no_invite_key' }
  let g = null
  try { g = JSON.parse(await openBox(JSON.parse(r.grant), invite.boxPriv)) } catch { g = null }
  if (!g || g.room !== room) return { wait: 'grant_unopenable' }
  const epoch = Number(r.epoch) || Number(g.epoch) || 0
  if (g.kind === 'room-split-key' && typeof g.userShare === 'string' && g.userShare && g.commit === r.commit) return { userShare: g.userShare, commit: g.commit, epoch }
  if (g.kind !== 'room-key' || typeof g.mk !== 'string' || (await commit(g.mk)) !== r.commit) return { wait: 'grant_not_current' }
  return { mk: g.mk, epoch }
}

/** This Space met its room's new key: fetch the grant sealed to this account, open it, take it. → { mk } | null (and 'removed' /
 *  'pending' is emitted). */
export async function adoptGrant (space) {
  const wb = space._wb
  const r = await space._client.grant(space.room).catch(() => null)
  const o = await openGrant(r, space.room, wb && wb.invite && wb.invite._key(), { gated: !!space._gated })
  if (o.removed) { if (space._keyWait !== 'removed') { space._keyWait = 'removed'; space._emit('removed', { room: space.room }) } return null }
  if (o.wait) return o.wait === 'grant_unavailable' ? null : waiting(space, o.wait)
  if (o.userShare) {
    // a split room: the grant is the new USER half; the app's half did not change — mk ⊕ old user half
    const oldShare = fragParam(space.shareLink, 'us')
    const app = oldShare && space._mk ? combineShares(space._mk, oldShare) : null
    const mk = app ? combineShares(o.userShare, app) : null
    if (!mk || (await commit(mk)) !== o.commit) return waiting(space, 'split_unpaired')
    space._setKey(mk, o.epoch, { userShare: o.userShare, commit: o.commit })
    return { mk }
  }
  space._setKey(o.mk, o.epoch)
  return { mk: o.mk }
}

// Who the room has now: the advertised addresses, and the members whose email the guest book shows (a hidden address is only
// its hash in the config — the book is where a removed hidden member can still be named)
async function currentMembers (space, cfg) {
  const al = (cfg && cfg.allow) || {}
  // ⛔ A FAILED READ IS NOT AN EMPTY BOOK (state machines pass 7, F#6; the app's V#6): read as "nobody has joined", a member the
  //   book alone names (a hidden address, a domain, an @username) fell out of the list — a change removed them with no word, and
  //   rotateKey left them out of the new key while it reported success. The read failing fails the call; nothing changes.
  const book = await space._client.state(space.room, space._mk, ROSTER_DOC).catch(() => null)
  if (!book || (book.status !== undefined && book.status !== 200)) throw sdkError('witbitz: who has joined this Space could not be read — nothing has changed; try again', 'book_unavailable')
  const seen0 = Object.values(book.seen || {}).map((x) => x && x.email).filter((e) => typeof e === 'string' && e)
  // a room changed in place keeps its guest book — those already removed are still in it; only the people on the list count
  // (the app's rule, memberChange.stillOnList; sweep 10-23 #5: the SDK gave them the new key back)
  const onList = await stillOnList(cfg, space.room, seen0).catch(() => null)
  const seen = onList ? seen0.filter((e) => onList(e, '')) : seen0
  const emails = [...new Set([...(Array.isArray(al.emails) ? al.emails : []), ...seen].map(lc))]
  return { emails, owners: ((cfg.owners && cfg.owners.emails) || []).map(lc), admins: ((cfg.admins && cfg.admins.emails) || []).map(lc) }
}

const epochOf = (cfg) => (Array.isArray(cfg && cfg.keyChain) ? cfg.keyChain.length : 0) // the epoch a config was read at (= the app's rekeyToWant)
async function rekeyNow (space, { members, stay, allowAfter, expectEpoch = null }) {
  const me = lc(space._wb && space._wb._session && space._wb._session.email)
  const wb = space._wb
  const scope = inviteScope(wb._session.idToken)
  if (!wb.invite._key()) await wb.invite.enroll()
  const { recipients, unreachable, pending } = await recipientsFor(space.room, stay, wb._client || space._client, { scope }) // the directory is the account's client's (in a vault, the Space's client is its key worker's)
  if (!recipients.some((x) => x.email === me)) throw sdkError('witbitz: this account has no invite key for this app yet (wb.invite.status: ' + wb.invite.status + ') — restore wb.invite.state from the device that has it', 'no_invite_key')
  const split = space._split ? { userShare: fragParam(space.shareLink, 'us') } : null
  if (space._split && !split.userShare) throw sdkError('witbitz: this split Space was not opened from its link — its user half is unknown here', 'invalid_argument')
  const r = await space._client.rekey(space.room, space._mk, { ...(members ? { members } : {}), recipients: recipients.map(({ mh, boxPub }) => ({ mh, boxPub })), pending: [...pending, ...unseenHidden(allowAfter, recipients, pending)], by: me, ...(split ? { split } : {}), ...(Number.isInteger(expectEpoch) ? { expectEpoch } : {}) }) // ONE SNAPSHOT (docs/state-machines.md V#5, the SDK's twin K#1): the change was planned at this epoch — a key adopted on the way (the healing client's retry) must not apply it to another
  if (!r || r.status !== 200 || !(r.newMk || r.newShare)) { // a split room in a vault: the worker keeps the key and answers only the new share (sweep 10-23 #3; the app's rekeyMembers takes it too)
    const code = r && r.error === 'stale_epoch' ? 'changed_meanwhile' : (r && r.error) || 'rekey_failed'
    throw Object.assign(new Error('witbitz: the key was not changed — nothing has changed' + (r && r.reason ? ` (${r.reason})` : '')), { code, status: r && r.status })
  }
  space._setKey(r.newMk || null, r.epoch, r.newShare ? { userShare: r.newShare, commit: r.newCommit } : null)
  return { epoch: r.epoch, unreachable: unreachable.filter((e) => e !== me) }
}

/** May this session change this Space (`what`: 'changeMembers' | 'rotateKey')? Throws the refusal; → { cfg, me }. Exported so a
 *  vault checks BEFORE it asks the person (sweep 10-23 #21). */
export async function changeable (space, what) {
  const wb = space._wb
  if (!wb || !wb._session || !wb._session.email) throw sdkError(`witbitz: ${what} needs a signed-in session (wb.signIn)`, 'sign_in_required')
  if (typeof space._client.rekey !== 'function' || typeof space._client.grant !== 'function') throw sdkError(`witbitz: ${what} is not available on this client`, 'not_supported')
  const read = () => space._client.getConfig(space.room, space._mk).catch(() => null)
  let cfg = await read()
  // A SLEEPING CONFIDENTIAL SPACE (sweep 10-24 #3): a config read does not wake its enclave, so it fails — wake it, read again
  if (!cfg && wb._enc && wb._enc.rooms && wb._enc.rooms.has(space.room) && typeof wb._encWake === 'function') {
    try { await wb._encWake(space.room, { tries: 8 }) } catch { /* the read below says it */ }
    cfg = await read()
  }
  if (!cfg) throw sdkError(`witbitz: couldn’t read this Space’s members — try ${what} again shortly`, 'config_unavailable')
  if (cfg.admission !== 'email') throw sdkError(`witbitz: only an email-gated Space changes ${what === 'rotateKey' ? 'its key' : 'its members'}`, 'invalid_argument')
  const me = lc(wb._session.email)
  const owners = ((cfg.owners && cfg.owners.emails) || []).map(lc), admins = ((cfg.admins && cfg.admins.emails) || []).map(lc)
  if (!owners.length && !admins.length) throw sdkError('witbitz: this Space has no owners or admins — only the Spaces app can change it (its creator)', 'not_admin')
  if (!owners.includes(me) && !admins.includes(me)) throw sdkError('witbitz: only an owner or an admin changes this Space', 'not_admin')
  return { cfg, me }
}

// the same people on the list (emails, hashes, domains, advertised usernames) — whatever the order
const sameList = (a, b) => { const k = (x) => JSON.stringify(['emails', 'mh', 'domains'].map((f) => [...((x && Array.isArray(x[f])) ? x[f] : [])].map(String).sort()).concat([((x && Array.isArray(x.users)) ? x.users : []).map((u) => String(u && u.handle)).sort()])); return k(a) === k(b) }
/** THE LIST A CHANGE ENDS WITH, in the config's own shape (the app's rule, rekeyMembers + memberChange; sweep 10-23 #6):
 *  membersAfter's list; someone removed who is also on it by @username loses exactly those entries — the ones the server
 *  recorded at their sign-in (roster_seen `entries`) and their tag; every other hashed entry stays (replacing `mh` with the
 *  stated emails' hashes dropped every member added by @username); a NEW hidden member (stated, not shown) is admitted by
 *  its hash. `book()` → the guest book read ({ seen }); `tagOf(username)` → its tag for this room. */
export async function listAfter (cfg, room, want, { book, tagOf } = {}) {
  let m = await membersAfter(cfg, want, room)
  if (m.removed.length) {
    const b = typeof book === 'function' ? await book() : null
    const gone = new Set(m.removed.map(lc)), recs = Object.values((b && b.seen) || {}).filter((x) => x && gone.has(lc(x.email)))
    const drop = await dropsForUsers(room, recs.map((x) => x.user).filter(Boolean), { tagOf })
    for (const x of recs) for (const k of (Array.isArray(x.entries) ? x.entries : [])) if (typeof k === 'string' && k.startsWith('mh:')) drop.mh.push(k.slice(3))
    m = await membersAfter(cfg, { ...want, drop }, room)
  }
  const shownSet = new Set((m.allow.emails || []).map(lc))
  const newHidden = await Promise.all([...new Set([...(want.emails || []), ...(want.owners || []), ...(want.admins || [])].map(lc))].filter((e) => !shownSet.has(e)).map((e) => memberHash(e, room)))
  const mh = [...new Set([...(Array.isArray(m.allow.mh) ? m.allow.mh : []), ...newHidden])]
  if (mh.length) m.allow.mh = mh; else delete m.allow.mh
  return m
}

/** WHAT changeMembers(admission) WILL DO, before it does it: the list after (listAfter — hidden members counted) and `roles`, true
 *  when nobody's access changes (only who manages it; the key stays). One rule for the SDK's change and the vault's question
 *  (sync sweep 10-26 #3: the vault compared only the shown addresses). `cfg`: the config changeable() read, else it is read. */
export async function planMembers (space, admission = {}, cfg = null) {
  if (!cfg) cfg = (await changeable(space, 'changeMembers')).cfg
  const emails = [...new Set((Array.isArray(admission.emails) ? admission.emails : []).map(lc).filter(Boolean))]
  if (!emails.length) throw sdkError('witbitz: changeMembers needs admission.emails (the whole list)', 'invalid_argument')
  const cur = await currentMembers(space, cfg)
  const want = {
    emails,
    ...(Array.isArray(admission.domains) ? { domains: admission.domains } : {}),
    owners: Array.isArray(admission.owners) ? admission.owners.map(lc) : cur.owners,
    admins: Array.isArray(admission.admins) ? admission.admins.map(lc) : cur.admins,
    shown: admission.advertise === true ? emails : Array.isArray(admission.advertise) ? admission.advertise : ((cfg.allow && cfg.allow.emails) || []).map(lc).filter((e) => emails.includes(e)),
  }
  const c = (space._wb && space._wb._client) || space._client
  const tagOf = async (u) => { const t = typeof c.userTag === 'function' ? await c.userTag(u, space.room).catch(() => null) : null; return t && t.status === 200 ? t.tag : '' }
  const m = await listAfter(cfg, space.room, { ...want, known: cur.emails }, { book: () => space._client.state(space.room, space._mk, ROSTER_DOC).catch(() => null), tagOf })
  return { emails, cur, want, m, roles: !m.removed.length && sameList(cfg.allow, m.allow) }
}

/** space.changeMembers(admission) — `admission`: { emails, domains?, admins?, owners?, advertise? }, the list stated in FULL,
 *  as fork() takes it. → { inPlace:true, epoch, link, removed, added, unreachable } */
export async function changeMembers (space, admission = {}) {
  const { cfg, me } = await changeable(space, 'changeMembers')
  const { emails, cur, want, m, roles } = await planMembers(space, admission, cfg)
  // A ROLE CHANGE NEEDS NO NEW KEY (the app's decision 4, verifiedMove.js; sweep 10-23 #16): nobody's access changes, so the
  // room keeps its key and the config changes in place (op 'config'). A server that does not take it yet answers
  // config_immutable / not_enabled: then the change is made as before, by a re-key.
  if (roles && typeof space._client.setConfig === 'function') {
    const r = await space._client.setConfig(space.room, space._mk, { admins: m.admins, owners: m.owners }, space._who ? space._who() : 'An admin').catch(() => null)
    if (r && r.status === 200) return { inPlace: true, roles: true, epoch: space.epoch, link: space.shareLink, removed: [], added: [], unreachable: [] }
    if (!(r && (r.error === 'config_immutable' || r.error === 'not_enabled'))) throw Object.assign(new Error('witbitz: the roles were not changed — nothing has changed' + (r && r.reason ? ` (${r.reason})` : '')), { code: (r && r.error) || 'config_failed', status: r && r.status })
  }
  const stay = [...new Set([...want.emails, ...want.owners, ...want.admins, me])]
  const { epoch, unreachable } = await rekeyNow(space, { members: { allow: m.allow, owners: m.owners, admins: m.admins }, stay, allowAfter: m.allow, expectEpoch: epochOf(cfg) })
  // added = on neither list before: not an address the room showed or its book knew, and not a hidden address's hash
  const hidden = new Set(Array.isArray(cfg.allow && cfg.allow.mh) ? cfg.allow.mh : [])
  const before = new Set(cur.emails)
  const added = []
  for (const e of emails) if (!before.has(e) && !hidden.has(await memberHash(e, space.room))) added.push(e)
  return { inPlace: true, epoch, link: space.shareLink, removed: m.removed, added, unreachable }
}

/** space.rotateKey() — the same members, a new key (a lost phone, a link sent to the wrong place). → { inPlace:true, rotated:true, epoch, link, unreachable } */
export async function rotateKey (space) {
  const { cfg, me } = await changeable(space, 'rotateKey')
  const cur = await currentMembers(space, cfg)
  const stay = [...new Set([...cur.emails, ...cur.owners, ...cur.admins, me])]
  const { epoch, unreachable } = await rekeyNow(space, { members: null, stay, allowAfter: cfg.allow || {}, expectEpoch: epochOf(cfg) })
  return { inPlace: true, rotated: true, epoch, link: space.shareLink, unreachable }
}
