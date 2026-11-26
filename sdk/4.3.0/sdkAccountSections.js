// sdkAccountSections.js — THE SPACES APP'S OPTIONAL ACCOUNT SECTIONS FOR A BUILDER (docs/sdk-account-format-plan.md phase 5,
// decision 7; the owner, 2026-11-13: "yes. Do 1-5" — no section named, so the plan's examples). `wb.account.contacts`, `.name`
// and `.roomDefaults`: each is read and written in the SAME doc, field and shape the Spaces app uses, in the account's index room
// (sdkAccount.js indexRoomOf), sealed under the app's account-store key (loc.app, as phase 3's `xindex`), and merged by the app's
// OWN rules — imported, never copied:
//   contacts      `xindex2.contacts`   store.js mergeContactLists (a row by its email / @username / agent id; a newer `at` wins;
//                                      a removal is a `deleted` row) + dedupePeople, at most 1000 — as saveContacts keeps them
//   name          `xindex.name`        the app's rule: one name for the account, trimmed to 24; an empty name never replaces one
//   roomDefaults  `xroom-defaults`     roomDefaultPrefs.js: writeRoomDefaults stamps each changed option, mergeRoomDefaults keeps
//                                      the later edit per option (temporary and private assistants never both on)
// OPT-IN: a section reads nothing until the app first uses it (get, a change, on('change')); a builder that never does sees no
// request and no change. Once used, every account sync (the stream, the minute poll — sdkAccount.js _sync) reads it again and
// fires 'change' when another device moved it. A write lands only over the version read (409 → read, merge, again), never after
// a read that was not definitive (the clobber rule), and keeps every other field of the doc as it was: the index sync (xindex)
// and the vault keep (xindex2) write these docs too, each carrying what it does not own (sdkAccountDoc.js toAppIndex, vaultKeep.js
// keepToApp). No SDK release before 3.24.0 reads or writes any of the three docs.
import { mergeContactLists, normContact, dedupePeople, contactKey } from './store.js'
import { cleanRoomDefaults, writeRoomDefaults, ROOM_DEFAULTS_DOC } from './roomDefaultPrefs.js'
import { sealDoc } from './accountSeal.js'
import { BLOCKS_DOC, cleanBlocks, mergeBlocks, isBlocked } from './blocks.js' // blocks: the app's list and its rules
import { CHAT_LOCKS_DOC, cleanChatLocks, mergeChatLocks, validPin, newSalt, newLockId, stretchPin, pinIdFor, addLock, dropLock, lockOfTarget, liveLocks, accountTries, wrongTryIn } from './chatLock.js'

const fail = (code, msg, extra = {}) => Object.assign(new Error('witbitz: ' + msg), { code, ...extra })
const canon = (x) => JSON.stringify(x === undefined ? null : x)
const copy = (x) => (x === null || x === undefined ? null : JSON.parse(JSON.stringify(x)))
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)

class Section {
  /** @param {object} spec { doc, of(doc) → value, apply(doc, change) → the doc to write, or null when nothing moves, calls } */
  constructor (ix, spec) { this._ix = ix; this._spec = spec; this._calls = spec.calls; this._val = null; this._master = null; this._used = false; this._fns = new Set(); this._remote = false }
  /** What this device last read (null before the first read, and for another account). */
  get value () { if (this._remote) return copy(this._val); const s = this._ix._backup._s; return s && s.master === this._master ? copy(this._val) : null }
  /** Read it now. */
  async get () { return this._pass(null) }
  /** 'change': fn(value) when a read finds that another device changed it. */
  on (ev, fn) { if (ev === 'change' && typeof fn === 'function') { this._fns.add(fn); if (!this._used && this._ix.enabled) this._pass(null).catch(() => null) } return this }
  off (ev, fn) { this._fns.delete(fn); return this }
  _seen (v, fire = false) { const was = this._val; this._remote = true; this._val = v; if (fire && canon(was) !== canon(v)) this._fire(v) } // in a vault: what the vault read
  _fire (v) { for (const fn of this._fns) { try { fn(copy(v)) } catch { /* the app's callback */ } } }
  async _pass (change) {
    const ix = this._ix, d = this._spec.doc
    if (!ix.enabled) throw fail('not_enabled', 'turn the account on first (wb.backup.enable or restore)')
    this._used = true
    const s0 = ix._backup._s, moved = () => { if (ix._backup._s !== s0) throw fail('account_changed', 'the account changed on this device during the call') }
    for (let i = 0; i < 5; i++) {
      const loc = await ix._where(); moved()
      if (this._master !== loc.master) { this._master = loc.master; this._val = null }
      if (!loc.made && !(s0.device && s0.device.made)) { await ix._ensureRoom(loc); moved() } // the index room, made once (as the sync does)
      const got = await ix._read(loc, d, loc.app); moved()
      if (!got.ok) throw fail(got.unopenable ? 'unopenable' : 'unreadable', `the account's ${d} could not be ${got.unopenable ? 'opened' : 'read'}`, { status: got.status })
      const next = change === null ? null : this._spec.apply(got.doc, change)
      if (next) {
        const w = await ix._client().state(loc.room, loc.mk, d, await sealDoc(loc.app, next), 'account ' + d, 'device', got.v); moved()
        if (w && w.status === 409) { await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 40) * (i + 1))); continue } // another device wrote: merge over it
        if (!w || w.status !== 200) throw fail('save_failed', `the account's ${d} could not be saved`, { status: w && w.status })
        this._val = this._spec.of(next); return copy(this._val)
      }
      const was = this._val, now = this._spec.of(got.doc)
      this._val = now
      if (was !== null && canon(was) !== canon(now)) this._fire(now)
      return copy(now)
    }
    throw fail('save_failed', `the account's ${d} kept changing under this device — try again`, { status: 409 })
  }
}

// ── contacts: xindex2.contacts ──
const contactsOf = (doc) => dedupePeople(((obj(doc) && Array.isArray(doc.contacts)) ? doc.contacts : []).map(normContact).filter(Boolean))
const withContacts = (doc, rows) => {
  const cur = contactsOf(doc), next = dedupePeople(mergeContactLists(cur, rows).list).slice(0, 1000)
  return canon(next) === canon(cur) ? null : { v: 2, ...(obj(doc) || {}), contacts: next, at: Date.now() }
}
const live = (list) => list && list.filter((c) => !c.deleted).map(({ deleted: _d, ...c }) => c)
// one row, stamped against the list each try read: newer than any copy of it (the app's LWW), a removal its tombstone
const stamped = (c, gone) => (cur) => {
  const ex = cur.find((x) => contactKey(x) === contactKey(c))
  if (gone && !ex) return []
  return [{ ...(gone ? ex : c), ...(gone ? { deleted: true } : {}), at: Math.max(Date.now(), ((ex && ex.at) || 0) + 1) }]
}
const oneContact = (contact) => { const c = normContact(contact); if (!c) throw fail('invalid_argument', 'a contact needs an email or an @username (a saved assistant: an id and a name)'); return c }
class Contacts extends Section {
  constructor (ix) { super(ix, { doc: 'xindex2', of: contactsOf, calls: ['get', 'set', 'remove', 'merge'], apply: (doc, rows) => withContacts(doc, typeof rows === 'function' ? rows(contactsOf(doc)) : rows) }) }
  get value () { return live(super.value) }
  async get () { return live(await super.get()) }
  _fire (v) { super._fire(live(v)) } // the app keeps a removal as a row; the builder sees the people
  /** Add or edit one contact ({ email | username, fn?, tel? } or a saved assistant { kind: 'agent', id, fn, persona? }); it wins over older copies. */
  async set (contact) { return live(await this._pass(stamped(oneContact(contact), false))) }
  /** Remove one (by its email, @username or assistant id) on every device — the app's tombstone row. */
  async remove (contact) { return live(await this._pass(stamped(oneContact(contact), true))) }
  /** Fold in a list as the app does on a sync or a restore: each row by its own `at`. */
  async merge (list) { if (!Array.isArray(list)) throw fail('invalid_argument', 'contacts.merge takes a list'); return live(await this._pass(list)) }
}

// ── name: xindex.name ──
class Name extends Section {
  constructor (ix) { super(ix, { doc: 'xindex', of: (doc) => (obj(doc) && typeof doc.name === 'string' ? doc.name : ''), calls: ['get', 'set'],
    apply: (doc, name) => (obj(doc) && doc.name === name ? null : { v: 2, rooms: {}, devices: {}, signouts: {}, ...(obj(doc) || {}), name, at: Date.now() }) }) }
  /** The person's name, for every device of the account (the app keeps 24 characters). An empty name is refused, as the app never writes one over a name. */
  async set (name) { const n = String(typeof name === 'string' ? name : '').trim().slice(0, 24); if (!n) throw fail('invalid_argument', 'a name is needed'); return this._pass(n) }
}

// ── roomDefaults: xroom-defaults ──
const memStore = (v) => { const m = new Map(v ? [['space:default-room', JSON.stringify(v)]] : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, x) => { m.set(k, String(x)) }, removeItem: (k) => { m.delete(k) } } }
const optionsOf = (doc) => { const c = cleanRoomDefaults(doc); if (!c) return null; const { v: _v, mods: _m, ...o } = c; return o }
class RoomDefaults extends Section {
  constructor (ix) { super(ix, { doc: 'x' + ROOM_DEFAULTS_DOC, of: optionsOf, calls: ['get', 'set'],
    apply: (doc, patch) => { const cur = cleanRoomDefaults(doc), next = writeRoomDefaults(patch, {}, memStore(cur), Date.now()); return next && canon(optionsOf(next)) !== canon(optionsOf(cur)) ? next : null } }) }
  /** Change some of the New-Space defaults ({ quick, enclave, verified, lanes, temporary }: booleans; { assistant, model }: strings).
   *  `verified` is kept for older apps: today's app makes every new Space verified and ignores it (sync sweep 11-21 #11). */
  async set (patch) {
    const p = obj(patch), c = p && cleanRoomDefaults({ v: 1, ...p })
    if (!p || !Object.keys(p).length || Object.keys(p).some((k) => k === 'v' || k === 'mods' || !c || !(k in c))) throw fail('invalid_argument', 'roomDefaults.set takes { quick, enclave, verified, lanes, temporary } (booleans) and { assistant, model } (strings)')
    return this._pass(p)
  }
}

// ── blocks: xblocks { v: 1, list } — the app's Block (blocks.js; docs/report-and-block.md §4; sync sweep 2026-11-13) ──
// One entry per person, keyed on what proves who they are (a verified email, an @username, the key that signed in one Space —
// space.blockIdentity); a newer `at` wins; an unblock is a `gone` tombstone that retires every older block it shares a proof with.
const blocksOf = (doc) => cleanBlocks(obj(doc) && Array.isArray(doc.list) ? doc.list : [])
const withBlocks = (doc, add) => { const cur = blocksOf(doc), next = mergeBlocks(cur, add); return canon(next) === canon(cur) ? null : { ...(obj(doc) || {}), v: 1, list: next } }
const liveBlocks = (list) => list && list.filter((b) => !b.gone)
const oneWho = (who) => { const w = obj(who), c = w && cleanBlocks([{ ...w, at: 1 }]); if (!c || !c.length) throw fail('invalid_argument', 'a block names a person by { email }, { user } or { room, sid } — space.blockIdentity(message)'); return { ...c[0], at: 0 } }
const nextAt = (cur) => Math.max(Date.now(), ...cur.map((b) => (b.at || 0) + 1))
class Blocks extends Section {
  constructor (ix) { super(ix, { doc: 'x' + BLOCKS_DOC, of: blocksOf, calls: ['get', 'block', 'unblock', 'merge'], apply: (doc, add) => withBlocks(doc, typeof add === 'function' ? add(blocksOf(doc)) : add) }) }
  get value () { return liveBlocks(super.value) }
  async get () { return liveBlocks(await super.get()) }
  _fire (v) { super._fire(liveBlocks(v)) } // the app keeps an unblock as a row; the builder sees who is blocked
  /** Block a person on every device of the account ({ email?, user?, room?, sid?, name? } — space.blockIdentity(message), plus the name to show). */
  async block (who) { const w = oneWho(who); return liveBlocks(await this._pass((cur) => [{ ...w, at: nextAt(cur) }])) }
  /** Unblock: every live entry that names them by any proof goes, kept as a tombstone so another device does not bring them back. */
  async unblock (who) {
    const w = oneWho(who)
    return liveBlocks(await this._pass((cur) => { const at = nextAt(cur), gone = cur.filter((b) => isBlocked(w, [b])); return (gone.length ? gone : [w]).map((b) => ({ ...b, name: '', at, gone: true })) }))
  }
  /** Fold in a list (another store's, a restore) as the app does: per person the newer entry wins. */
  async merge (list) { if (!Array.isArray(list)) throw fail('invalid_argument', 'blocks.merge takes a list'); return liveBlocks(await this._pass(list)) }
  /** Is this writer blocked? Any one proof they share counts. From what this device last read — or from `list`, one of your own. */
  has (who, list) { return isBlocked(obj(who), list ? cleanBlocks(list) : (super.value || [])) }
}

/** Puts the sections on the account index (`ix.contacts`, `ix.name`, `ix.roomDefaults`, `ix.blocks`) and keeps them in `ix._sections`. */
class ChatLocks extends Section {
  constructor(ix) { super(ix, { doc: 'x' + CHAT_LOCKS_DOC, of: cleanChatLocks, calls: ['get', 'merge', 'set', 'remove', 'check', 'changePin'], apply: (doc, incoming) => { const next = typeof incoming === 'function' ? incoming(cleanChatLocks(doc)) : mergeChatLocks(doc, incoming); return canon(next) === canon(cleanChatLocks(doc)) ? null : next } }) }
  async merge(doc) {
    const clean = cleanChatLocks(doc); if (!clean) throw fail('invalid_argument', 'chatLocks.merge needs a chat-locks document')
    return this._write(clean)
  }
  async set({ kind, target, pin, title } = {}) {
    if (!['room', 'code'].includes(kind) || typeof target !== 'string' || !target || target.length > 300 || !validPin(pin)) throw fail('invalid_argument', 'chatLocks.set needs kind, target and a PIN of 4–12 digits')
    const s0 = this._ix._backup._s, salt = newSalt(), fingerprint = await pinIdFor(await stretchPin(pin, salt)), id = newLockId()
    if (this._ix._backup._s !== s0) throw fail('account_changed', 'the account changed during PIN setup')
    return this._write((doc) => { if (lockOfTarget(doc, kind, target)) throw fail('locked', 'this chat is already locked'); return addLock(doc, id, { kind, target, salt, pin: fingerprint, title }) })
  }
  async remove({ lockId } = {}) {
    if (typeof lockId !== 'string' || !/^lk_[A-Za-z0-9_-]{22}$/.test(lockId)) throw fail('invalid_argument', 'chatLocks.remove needs a lockId')
    return this._write((doc) => dropLock(doc, lockId))
  }
  async changePin({ lockId, pin, newPin } = {}) {
    if (!validPin(newPin)) throw fail('invalid_argument', 'a PIN is 4–12 digits')
    const s0 = this._ix._backup._s, doc = await this.get(), lock = liveLocks(doc).find((l) => l.lockId === lockId)
    if (!lock) throw fail('not_found', 'that display lock does not exist')
    const checked = await this.check({ lockId, pin })
    if (!checked.ok) throw fail('wrong_pin', 'the current PIN was not accepted', { next: checked.next })
    const fingerprint = await pinIdFor(await stretchPin(newPin, lock.salt))
    if (this._ix._backup._s !== s0) throw fail('account_changed', 'the account changed during PIN setup')
    return this._write((cur) => {
      const current = liveLocks(cur).find((l) => l.lockId === lockId)
      if (!current || current.pin !== lock.pin || current.salt !== lock.salt) throw fail('changed_meanwhile', 'the display lock changed; try again')
      return addLock(cur, lockId, { kind: current.kind, target: current.target, salt: current.salt, title: current.title, pin: fingerprint })
    })
  }
  async check({ lockId, pin } = {}) {
    if (!validPin(pin)) throw fail('invalid_argument', 'a PIN is 4–12 digits')
    const s0 = this._ix._backup._s, doc = await this.get(), lock = liveLocks(doc).find((l) => l.lockId === lockId)
    if (!lock) throw fail('not_found', 'that display lock does not exist')
    const before = accountTries(doc)
    if (before.next > Date.now()) return { ok: false, next: before.next }
    const fingerprint = await pinIdFor(await stretchPin(pin, lock.salt))
    if (this._ix._backup._s !== s0) throw fail('account_changed', 'the account changed during PIN checking')
    let ok = false, next = 0
    const dev = this._ix.deviceId
    if (!dev) throw fail('not_enabled', 'this account has no device id for synced PIN attempts')
    await this._write((cur) => {
      ok = false
      const now = Date.now(), current = liveLocks(cur).find((l) => l.lockId === lockId), tries = accountTries(cur)
      if (!current || current.pin !== lock.pin || current.salt !== lock.salt) throw fail('changed_meanwhile', 'the display lock changed; try again')
      if (tries.next > now) { next = tries.next; return cur }
      ok = fingerprint === current.pin
      const result = ok ? cur : wrongTryIn(cur, dev, now)
      next = accountTries(result, now).next
      return result
    })
    return { ok, next }
  }
  async _write(change) {
    const ix = this._ix, s0 = ix._backup._s, merged = await this._pass(change)
    // The app reads this optional doc only after the account index advertises its presence.
    for (let i = 0; i < 5; i++) {
      const loc = await ix._where(), got = await ix._read(loc, 'xindex', loc.app)
      if (ix._backup._s !== s0) throw fail('account_changed', 'the account changed during chatLocks.merge')
      if (!got.ok) throw fail('unreadable', 'the account index could not be read')
      const marks = ((got.doc || {}).signouts || {})
      const next = { ...(got.doc || {}), signouts: { ...marks, '@chatlocks': Math.max(Date.now(), (Number(marks['@chatlocks']) || 0) + 1) } }
      const r = await ix._client().state(loc.room, loc.mk, 'xindex', await sealDoc(loc.app, next), 'chat locks present', 'device', got.v)
      if (r && r.status === 409) continue
      if (!r || r.status !== 200) throw fail('save_failed', 'the chat-lock presence mark could not be saved')
      return merged
    }
    throw fail('save_failed', 'the account index kept changing; retry chatLocks.merge')
  }
}

export function attachSections (ix) {
  const all = { contacts: new Contacts(ix), name: new Name(ix), roomDefaults: new RoomDefaults(ix), blocks: new Blocks(ix), chatLocks: new ChatLocks(ix) }
  Object.defineProperty(ix, '_sections', { value: all, enumerable: false })
  for (const [k, s] of Object.entries(all)) Object.defineProperty(ix, k, { value: s, enumerable: true, configurable: true })
}
/** After an account sync: the sections the app uses are read again (a change another device made fires 'change'). */
export async function refreshSections (ix) {
  for (const s of Object.values(ix._sections || {})) if (s._used && !s._remote) await s._pass(null).catch(() => null)
}
