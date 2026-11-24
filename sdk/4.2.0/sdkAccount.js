// spaces/public/sdkAccount.js — `wb.account`: the account's LIVE index for a builder's app (2026-10-03; the owner, on what
// the SDK lacked next to the Spaces app: "And what about the index room etc." → "Yes"). wb.backup puts the room list in
// the vault for a RESTORE on a new device; this keeps two LIVE devices in step, the way the app's own index room does:
// the rooms (with their links), what was archived or forgotten, and the devices — with sign-out from another device.
//
// WHERE IT LIVES: a Witbitz room whose id and key are DERIVED from the backup's master secret (HKDF), so every device that
// holds the account — by enable() or restore({ code }) — finds the same room, and two devices can never make two indexes.
// The index is one state doc in it ('index', the account-doc size cap), and its content is sealed ON THE DEVICE under a
// third derived key before it is sent: the room's key reaches the standard tier like any room's, but what it carries —
// every room link the account holds — never does.
//
// HOW DEVICES AGREE: per-entry last-writer-wins. Every room entry carries `at` (the last change made to it), a forgotten
// room leaves a tombstone `{ room, at }`, and a device keeps `seenAt` and, once signed out, `out`. Merging is a union
// that keeps the newer of each — commutative, so devices converge whatever order they sync in; a write lost to a race
// is re-sent by its device on the next sync, because that device still sees its entry missing.
// ★ THE INDEX-CLOBBER RULE (the app lost an account's room list this way once — a fresh device wrote its EMPTY list over
//   the real one): nothing is written unless the read before it was DEFINITIVE — a 200 whose content opened, or a 200
//   with no doc yet. A failed, slow or unopenable read writes nothing and the sync reports { ok: false }.
// INSTANT (2026-10-03): every write to the index is announced on the index room's stream (agent/spaceService.mjs
// announceWrite), and a device that holds a socket on it syncs at once — a room made on the phone is on the laptop in
// about a second. The minute poll stays as the backstop for a socket that is down. Needs connect-src
// wss://code-relay.witbitz.chat in the page's CSP, like the room streams; without it the poll does the work.
import { indexGoneStep } from './indexGone.js'
import { openRoomStream } from './roomStreamClient.js'
import { sealDoc, openDoc, appStoreKey } from './accountSeal.js'
// THE APP'S FORMAT TOO (docs/sdk-account-format-plan.md phase 3, 3.24.0): the same room also holds the Spaces app's `xindex`,
// sealed under the app's account-store key. A sync reads BOTH docs and writes BOTH — the old `index` stays for every older
// release (they read only it), so an old and a new device of one account stay in step. sdkAccountDoc.js translates.
import { APP_DOC, toAppIndex, fromAppIndex, sameAppIndex } from './sdkAccountDoc.js'
// THE APP'S OPTIONAL SECTIONS (phase 5): wb.account.contacts / .name / .roomDefaults, in the app's docs of this same room — opt-in
import { attachSections, refreshSections } from './sdkAccountSections.js'
import { normUsageKey, pickUsageKey, newUsageKey, collectUsage, usageTotals, docNameFor, monthOf } from './usageReceipts.js' // the account's usage key (receipts on every turn; wb.account.usage)

const enc = new TextEncoder(), dec = new TextDecoder()
const SALT = enc.encode('witbitz-sdk-account-v1')
const DOC = 'index' // the server's account-doc cap (agent/spaceService.mjs INDEX_MAX_BYTES), not the 32 KB widget cap
const MAX_TOMBS = 500, MAX_DEVICES = 50
const SEEN_EVERY = 60 * 60 * 1000 // a device refreshes its "last seen" hourly, so an idle sync writes nothing
const fail = (code, msg, extra = {}) => Object.assign(new Error('witbitz: ' + msg), { code, ...extra })

const ub64 = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const b64url = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function hkdf(secret, info, len) {
  const km = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) }, km, len * 8))
}
/** The index room every device of the account derives: { room, mk, key } — `room` in the shape spaceConfig mints. */
export async function indexRoomOf(masterB64) {
  const master = ub64(masterB64)
  const id = await hkdf(master, 'index-room', 8)
  const room = 'sp-' + [].slice.call(id).map((x) => x.toString(36)).join('').slice(0, 12)
  const mk = b64url(await hkdf(master, 'index-mk', 32))
  const key = await crypto.subtle.importKey('raw', await hkdf(master, 'index-seal', 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { room, mk, key }
}

// sealDoc / openDoc: accountSeal.js — the same sealing the Spaces app's account stores use

const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)
/** The union of two index views, the newer of each entry kept. Pure — the whole agreement between devices is here. */
export function mergeIndex(a, b, maxRooms = 500) {
  const tomb = new Map()
  for (const t of [...(a.tomb || []), ...(b.tomb || [])]) if (t && t.room) tomb.set(t.room, Math.max(tomb.get(t.room) || 0, num(t.at)))
  const rooms = new Map()
  for (const r of [...(a.rooms || []), ...(b.rooms || [])]) {
    if (!r || !r.room) continue
    const prev = rooms.get(r.room)
    if (!prev || num(r.at) > num(prev.at)) rooms.set(r.room, r)
  }
  for (const [room, r] of rooms) if (tomb.has(room) && tomb.get(room) >= num(r.at)) rooms.delete(room) // only a TOMBSTONE removes — an entry from a backup made before `at` existed has none
  const devices = {}
  for (const src of [a.devices || {}, b.devices || {}]) {
    for (const [id, d] of Object.entries(src)) {
      if (!d || typeof d !== 'object') continue
      const p = devices[id]
      devices[id] = !p ? { ...d } : { ...(num(d.seenAt) > num(p.seenAt) ? { ...p, ...d } : { ...d, ...p }), seenAt: Math.max(num(p.seenAt), num(d.seenAt)), ...((p.out || d.out) ? { out: Math.max(num(p.out), num(d.out)) } : {}) }
    }
  }
  // LANE LINKS (lane.link): keyed by the pair, newest wins; an unlink is a `removed` entry, so it reaches every device too.
  const links = new Map()
  for (const l of [...(a.links || []), ...(b.links || [])]) {
    if (!l || !l.a || !l.b) continue
    const k = linkKey(l.a, l.b), prev = links.get(k)
    if (!prev || num(l.at) > num(prev.at)) links.set(k, l)
  }
  const keepDevices = Object.entries(devices).sort((x, y) => num(y[1].seenAt) - num(x[1].seenAt)).slice(0, MAX_DEVICES)
  return {
    rooms: [...rooms.values()].sort((x, y) => num(x.at) - num(y.at)).slice(-maxRooms),
    tomb: [...tomb.entries()].map(([room, at]) => ({ room, at })).sort((x, y) => x.at - y.at).slice(-MAX_TOMBS),
    devices: Object.fromEntries(keepDevices),
    links: [...links.values()].sort((x, y) => num(x.at) - num(y.at)).slice(-200),
  }
}
const linkKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a)
/** THE ACCOUNT'S USAGE KEY (the owner, 2026-10-23: a builder's app records the account's usage too — docs/usage-receipts.md).
 *  One per account, in the index every device shares: the smaller id wins (as the app's pickUsageKey), and a key that lost
 *  stays among the old ones so receipts addressed to it are still collected. → { usage, usageOld } */
export function mergeUsage(a, b) {
  const win = pickUsageKey(a && a.usage, b && b.usage)
  const old = new Map()
  for (const k of [...((a && a.usageOld) || []), ...((b && b.usageOld) || []), a && a.usage, b && b.usage].map(normUsageKey)) if (k && (!win || k.id !== win.id)) old.set(k.id, k)
  return { usage: win, usageOld: [...old.values()].slice(-5) }
}
const usageCanon = (x) => JSON.stringify([(normUsageKey(x && x.usage) || {}).id || '', ((x && x.usageOld) || []).map((k) => k && k.id).sort()])
const canon = (x) => JSON.stringify({ u: usageCanon(x),
  rooms: [...(x.rooms || [])].sort((p, q) => (p.room < q.room ? -1 : 1)).map((r) => Object.fromEntries(Object.entries(r).sort())),
  tomb: [...(x.tomb || [])].sort((p, q) => (p.room < q.room ? -1 : 1)),
  links: [...(x.links || [])].sort((p, q) => (linkKey(p.a, p.b) < linkKey(q.a, q.b) ? -1 : 1)).map((l) => Object.fromEntries(Object.entries(l).sort())),
  devices: Object.fromEntries(Object.entries(x.devices || {}).sort().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort())])),
})

export class AccountIndex {
  /** @param {object} o { backup: AccountBackup, client: () => spaceClient, deviceName?, viewer? } */
  constructor({ backup, client, deviceName = '', viewer = '', live = () => null, openStream = openRoomStream, version = '' } = {}) {
    this._version = String(version || '').slice(0, 40) // devices[].sdk: the release this device runs (plan § 4.2, decision 6)
    this._live = live
    this._openStream = openStream
    this._stream = null
    this._backup = backup
    this._client = client
    this._deviceName = String(deviceName || '').slice(0, 80)
    this._viewer = viewer
    this._devices = {}
    this._loc = null // { master, room, mk, key } for the backup's current master
    const cur = new Map(); this._usageCursor = { get: (k) => cur.get(k), set: (k, v) => { cur.set(k, v) } } // where each room's receipts were read up to (this page)
    this._pushT = null
    this._poll = null
    this._running = null
    /** Called after a sync changed what this device holds (rooms or devices). */
    this.onChange = null
    /** Called once when another device signed THIS one out: the SDK has dropped the account here — clear what your app keeps. */
    this.onSignedOut = null
    this.lastError = null
    backup._onLocal = () => this._schedule()
    // enable() / restore(): the account now exists on this device — a browser starts keeping it in step at once.
    backup._onStart = () => { this._schedule(); if (typeof window !== 'undefined') this.start() }
    attachSections(this) // this.contacts, this.name, this.roomDefaults: nothing is read until the app uses one
  }

  get enabled() { return this._backup.enabled }
  /** This device's id in the account (stable while its state is kept). */
  get deviceId() { return (this._backup._s && this._backup._s.device && this._backup._s.device.id) || '' }
  /** The account's rooms: [{ room, link, kind, label?, shared?, archived? }] — archived ones included, so filter as you like. */
  get rooms() { return this._backup.rooms }
  /** The account's devices: [{ id, name, seenAt, signedOut, current }]. */
  get devices() {
    return Object.entries(this._devices).map(([id, d]) => ({ id, name: d.name || '', seenAt: num(d.seenAt), signedOut: !!d.out, current: id === this.deviceId, ...(typeof d.sdk === 'string' && d.sdk ? { sdk: d.sdk } : {}) }))
      .sort((x, y) => y.seenAt - x.seenAt)
  }

  /** The member's linked lanes (lane.link), on every device: [{ a, b, cap? }] — two lane rooms. Links run where BOTH lanes
   *  are open, so a device that opens them links them again: `laneA.link(laneB)` for each pair listed here. */
  get links() { return ((this._backup._s && this._backup._s.links) || []).filter((l) => !l.removed).map(({ a, b, cap }) => ({ a, b, ...(Number.isFinite(cap) ? { cap } : {}) })) }

  /** @private the account's usage key (null until the index has given one) — and with the ones it replaced, for collecting. */
  _usageKey() { const s = this._backup._s; return (s && normUsageKey(s.usage)) || null }
  _usageKeys() { const s = this._backup._s; return s ? [normUsageKey(s.usage), ...((s.usageOld || []).map(normUsageKey))].filter(Boolean) : [] }

  _noteLink(a, b, cap) {
    const s = this._backup._s; if (!s) return
    const k = linkKey(a, b)
    const prev = (s.links || []).find((l) => linkKey(l.a, l.b) === k)
    if (prev && !prev.removed && prev.cap === cap) return
    s.links = [...(s.links || []).filter((l) => linkKey(l.a, l.b) !== k), { a, b, cap, at: Date.now() }].slice(-200)
    this._backup._changed(); this._schedule()
  }
  _dropLink(a, b) {
    const s = this._backup._s; if (!s) return
    const k = linkKey(a, b)
    s.links = [...(s.links || []).filter((l) => linkKey(l.a, l.b) !== k), { a, b, removed: true, at: Date.now() }].slice(-200)
    this._backup._changed(); this._schedule()
  }

  /** Mark a room archived (or not) on every device. It stays in the account and in the backup. */
  archive(room, on = true) { return this._edit(room, (r) => ({ ...r, archived: !!on })) }
  /** Rename a room in the account (the label a restore and your list show). */
  rename(room, label) { return this._edit(room, (r) => ({ ...r, label: String(label || '').slice(0, 120) })) }
  /** Drop a room from the account on EVERY device — the room itself is not deleted (that is wb.rooms.delete, for a
   *  tenant). Opening its link again later brings it back. */
  forget(room) { this._backup.remove(room); return this }
  /** Sign another device out: at its next sync it drops the account and your app is told (onSignedOut). */
  signOut(deviceId, { reason } = {}) {
    const d = this._devices[deviceId]
    if (!d) throw fail('unknown_device', 'no such device in this account')
    const at = Date.now()
    this._devices[deviceId] = { ...d, out: at, ...(reason === 'erased' ? { outWhy: 'erased' } : {}) } // why: an ONLINE device of a deleted account is told 'erased', as an offline one is (sync sweep 11-19 P3)
    // KEPT until the index carries it (pass 6, K#7): a sign-out lived only in memory — a page closed before the next write lost it
    const s = this._backup._s
    if (s) { s.outs = { ...(s.outs || {}), [deviceId]: at }; this._backup._changed() }
    this._schedule()
    return this
  }

  /** Pull the index, merge, push what this device knows that it lacks. → { ok, rooms, devices } — ok:false (nothing
   *  written) when the index could not be READ, so a failed read can never cost the account its list. */
  /** WHAT THIS ACCOUNT USED in a month, across its rooms and whoever paid (docs/usage-receipts.md — the app's Settings → Your
   *  usage; the owner, 2026-10-23: a builder's app records it too). Every turn this account's devices send carries a
   *  receipt address; the server seals each reply's cost to it, in the room. This folds the new receipts into the account's
   *  monthly sidecar (kept in the index room, sealed like the index) and reads the month.
   *  @param {object} [o] { month?: 'YYYY-MM' } (default this month, UTC)
   *  → { month, replies, costMicros, costUsd, byPayer: { you, admin, app, witbitz } (micros), byDay, in, out } */
  async usage({ month } = {}) {
    if (!this.enabled) throw fail('not_enabled', 'turn the account on first (wb.backup.enable or restore)')
    const m = month === undefined ? monthOf(Date.now()) : String(month)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw fail('invalid_argument', 'month is YYYY-MM')
    await this.sync() // the usage key comes from the index (made by the first device that finds none)
    const loc = await this._where(), c = this._client()
    const vOf = new Map() // name → the version last read: a write lands only over it (sync sweep 11-08 #32); collectUsage reads back and retries
    const readDoc = async (name) => {
      const r = await c.state(loc.room, loc.mk, name)
      if (!r || r.status !== 200) throw fail('unreadable', 'the usage record could not be read', { status: r && r.status })
      if (Number.isInteger(r.v)) vOf.set(name, r.v); else vOf.delete(name)
      const st = r.state
      return st == null || (typeof st === 'object' && !Object.keys(st).length) ? null : openDoc(loc.key, st)
    }
    const writeDoc = async (name, doc) => {
      const w = await c.state(loc.room, loc.mk, name, await sealDoc(loc.key, doc), 'usage', 'device', vOf.has(name) ? vOf.get(name) : undefined)
      if (!w || w.status !== 200) throw fail('save_failed', 'the usage record could not be saved', { status: w && w.status })
    }
    if (typeof c.receipts === 'function') {
      const rooms = this.rooms.map((r) => r.room)
      for (const key of this._usageKeys()) await collectUsage({ key, rooms, read: (room, drop, since) => c.receipts(room, drop, since), ack: (room, drop, upTo) => c.receiptsAck(room, drop, upTo), readDoc, writeDoc, cursor: this._usageCursor }).catch(() => null)
    }
    const t = usageTotals(await readDoc(docNameFor(m)))
    return { month: m, ...t, costUsd: t.costMicros / 1e6 }
  }

  async sync() {
    if (!this._backup.enabled) throw fail('not_enabled', 'no account on this device — call wb.backup.enable() or restore({ code }) first')
    // A CHANGE MADE WHILE A PASS IS OUT (pass 6, K#7): the running pass may have read and merged before it — it was left for
    // the next sync (a minute). One more pass runs as soon as this one settles, and the caller waits for that one.
    if (this._running) {
      if (!this._again) this._again = this._running.catch(() => null).then(() => { this._again = null; return this.enabled ? this.sync() : { ok: false, rooms: this.rooms, devices: this.devices } })
      return this._again
    }
    this._running = this._sync().finally(() => { this._running = null })
    return this._running
  }

  /** Keep in step on their own: a sync every `every` ms while the page is visible, and when it becomes visible. */
  start({ every = 60_000 } = {}) {
    this.stop()
    if (typeof setInterval !== 'function') return this
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    this._poll = setInterval(() => { if (this.enabled && visible()) this.sync().catch((e) => { this.lastError = e }) }, Math.max(5_000, every))
    if (typeof document !== 'undefined' && document.addEventListener) {
      this._onVis = () => { if (this.enabled && visible()) this.sync().catch((e) => { this.lastError = e }) }
      document.addEventListener('visibilitychange', this._onVis)
    }
    this._listen()
    return this
  }

  // The socket on the index room's stream: any write to the index (another device's, or this one's) → sync now.
  _listen() {
    const l = this._live && this._live()
    if (!l || !l.WebSocketImpl || this._stream || !this.enabled) return
    const master = this._backup._s.master
    this._where().then((loc) => {
      if (this._stream || !this.enabled || this._backup._s.master !== master || !this._poll) return
      this._stream = this._openStream({
        mk: loc.mk, path: 's', WebSocketImpl: l.WebSocketImpl,
        onEvent: (ev) => { if (ev && ev.k === 'poll' && this.enabled) this.sync().catch((e) => { this.lastError = e }) },
      })
    }).catch(() => { /* the poll still runs */ })
  }
  stop() {
    if (this._poll) { clearInterval(this._poll); this._poll = null }
    if (this._onVis && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', this._onVis); this._onVis = null }
    clearTimeout(this._pushT); this._pushT = null
    if (this._stream) { try { this._stream.stop() } catch { /* */ } this._stream = null }
    return this
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────────────────
  _edit(room, fn) {
    const s = this._backup._s
    const i = s ? s.rooms.findIndex((r) => r.room === room) : -1
    if (i < 0) throw fail('unknown_room', 'that room is not in this account')
    s.rooms[i] = { ...fn(s.rooms[i]), at: Date.now() }
    this._backup._schedule()
    return this
  }
  _schedule() { if (!this.enabled) return; clearTimeout(this._pushT); this._pushT = setTimeout(() => { this._pushT = null; this.sync().catch((e) => { this.lastError = e }) }, 300) }

  async _where() {
    const master = this._backup._s.master
    if (!this._loc || this._loc.master !== master) this._loc = { master, ...(await indexRoomOf(master)), app: await appStoreKey(ub64(master)) }
    return this._loc
  }
  _me() {
    const s = this._backup._s
    if (!s.device || !s.device.id) { s.device = { id: 'd_' + b64url(crypto.getRandomValues(new Uint8Array(9))), name: this._deviceName }; this._backup._changed() }
    if (this._deviceName && s.device.name !== this._deviceName) { s.device = { ...s.device, name: this._deviceName }; this._backup._changed() }
    return s.device
  }
  async _read(loc, name = DOC, key = loc.key) {
    const c = this._client()
    let r
    try { r = await c.state(loc.room, loc.mk, name) } catch { return { ok: false } }
    if (!r || r.status !== 200) return { ok: false, status: r && r.status }
    const st = r.state
    const v = Number.isInteger(r.v) ? r.v : 0 // the version this read saw — the write is conditional on it
    if (st == null || (typeof st === 'object' && !Object.keys(st).length)) return { ok: true, doc: null, v }
    try { return { ok: true, doc: await openDoc(key, st), v } } catch { return { ok: false, unopenable: true } }
  }
  async _ensureRoom(loc) {
    if (loc.made) return
    try { await this._client().create({ room: loc.room, mk: loc.mk }, { base: this._viewer || undefined }) } catch (e) { if (!/409|exists/.test(String(e && e.message))) throw e }
    loc.made = true
  }
  // Read → merge → write ONLY IF the index has not moved since the read (ifV); another device that wrote in between makes
  // the server answer 409, and the merge runs again on what it wrote — two devices syncing at once both keep their rooms
  // (a reviewer's finding, 2026-10-05; spaces/test/sdkAccountIndex.test.mjs).
  async _sync() {
    for (let i = 0; i < 5; i++) {
      const r = await this._syncOnce()
      if (!r.conflict) { if (r.ok && !r.signedOut) await refreshSections(this); return r } // a section in use: read again (its 'change' event)
      await new Promise((res) => setTimeout(res, 20 + Math.floor(Math.random() * 80) * (i + 1)))
    }
    this.lastError = fail('save_failed', 'the account index kept changing under this device — try again', { status: 409 })
    return { ok: false, rooms: this.rooms, devices: this.devices }
  }
  async _syncOnce() {
    // ★ ONE ACCOUNT PER PASS (pass 6, docs/state-machines.md K#2): a vault switching accounts swaps the backup's state (_adopt,
    //   _drop, restore) while a pass awaits; the pass then merged account B's rooms into account A's index under A's key, and A's
    //   rooms into B's backup. The pass keeps the state it began with and stops the moment another is in its place.
    const s0 = this._backup._s
    const moved = () => this._backup._s !== s0
    const stopped = () => ({ ok: false, rooms: this.rooms, devices: this.devices })
    if (!s0) return stopped()
    const loc = await this._where()
    if (moved()) return stopped()
    // CREATE BEFORE THE FIRST READ, once per device (an existing room answers 409). A read of an unknown room is not
    // refused — the server adopts it with no owner — so waiting for a 404 would leave the index outside the app's tenant.
    const me0 = this._me()
    if (!me0.made) {
      try { await this._ensureRoom(loc) } catch (e) { this.lastError = e; return { ok: false, rooms: this.rooms, devices: this.devices } }
      if (moved()) return stopped()
      this._backup._s.device = { ...me0, made: true }; this._backup._changed()
    }
    const got = await this._read(loc)
    if (moved()) return stopped()
    // THE ACCOUNT WAS DELETED while this device was away (sync sweep 2026-11-18 #11): its index answers 410 — twice, a minute apart,
    // and this device signs itself out as erased, as the app does (indexGone.js, the one rule)
    {
      const s0 = this._backup._s || {}, g = indexGoneStep(s0.indexGoneAt || 0, got.ok ? 200 : got.status)
      if ((s0.indexGoneAt || 0) !== g.first) { if (g.first) s0.indexGoneAt = g.first; else delete s0.indexGoneAt; this._backup._changed() }
      if (g.erased) return this._signedOut('erased')
    }
    const gotX = got.ok ? await this._read(loc, APP_DOC, loc.app) : got // the app-format doc: the same clobber rule — unknown is not empty
    if (moved()) return stopped()
    if (!gotX.ok) { this.lastError = fail(gotX.unopenable ? 'unopenable' : 'unreadable', gotX.unopenable ? 'the account index could not be opened' : 'the account index could not be read', { status: gotX.status }); return { ok: false, rooms: this.rooms, devices: this.devices } }
    const old = got.doc ? { rooms: got.doc.rooms || [], tomb: got.doc.tomb || [], links: got.doc.links || [], devices: got.doc.devices || {}, usage: normUsageKey(got.doc.usage), usageOld: (got.doc.usageOld || []).map(normUsageKey).filter(Boolean) } : { rooms: [], tomb: [], links: [], devices: {}, usage: null, usageOld: [] }
    const fromApp = fromAppIndex(gotX.doc)
    const remote = { ...mergeIndex(old, fromApp), ...mergeUsage(old, fromApp) } // READ-THROUGH: both docs, the newer of each entry (one rule, mergeIndex)
    const s = this._backup._s
    const me = this._me()
    const mine = this._devices[me.id] || {}
    // a sign-out this device made and kept (K#7): back into the list after a reload, until the index carries it
    const outs = s.outs || {}
    const localDevices = { ...this._devices }
    for (const [id, at] of Object.entries(outs)) { const d = localDevices[id] || remote.devices[id]; if (d && num(d.out) < at) localDevices[id] = { ...d, out: at } }
    const local = { rooms: s.rooms, tomb: s.tomb || [], links: s.links || [], devices: { ...localDevices, [me.id]: { ...mine, name: me.name || mine.name || '', seenAt: num(mine.seenAt), ...(typeof this._spk === 'string' && this._spk ? { spk: this._spk } : {}), ...(this._version ? { sdk: this._version } : {}) } } }
    const merged = mergeIndex(local, remote)
    // the usage key: made by the first device that finds none — only after this DEFINITIVE read, so two keys meet only in a race
    Object.assign(merged, mergeUsage({ usage: s.usage, usageOld: s.usageOld }, remote))
    if (!merged.usage) merged.usage = await newUsageKey()
    if (moved()) return stopped()
    const self = merged.devices[me.id]
    if (self.out) return this._signedOut(self.outWhy === 'erased' ? 'erased' : undefined)
    if (Date.now() - num(self.seenAt) > SEEN_EVERY) merged.devices[me.id] = { ...self, seenAt: Date.now() }
    const before = canon({ rooms: s.rooms, tomb: s.tomb || [], links: s.links || [], devices: this._devices, usage: s.usage, usageOld: s.usageOld })
    const usageBefore = usageCanon(s)
    const roomsBefore = canon({ rooms: s.rooms, tomb: s.tomb || [] })
    this._devices = merged.devices
    s.rooms = merged.rooms; s.tomb = merged.tomb; s.links = merged.links; s.usage = merged.usage; s.usageOld = merged.usageOld
    const after = canon(merged)
    // DUAL WRITE: the old doc for every older release, then the app's; each only when it differs from what it holds, each over
    // the version read. A 409 on either re-reads both and merges again.
    const appDoc = toAppIndex(merged, gotX.doc)
    for (const [differs, name, key, body, v] of [[after !== canon(old), DOC, loc.key, { v: 1, rooms: merged.rooms, tomb: merged.tomb, links: merged.links, devices: merged.devices, usage: merged.usage, ...(merged.usageOld.length ? { usageOld: merged.usageOld } : {}) }, got.v],
      [!sameAppIndex(appDoc, gotX.doc), APP_DOC, loc.app, { ...appDoc, at: Date.now() }, gotX.v]]) {
      if (!differs) continue
      const w = await this._client().state(loc.room, loc.mk, name, await sealDoc(key, body), 'account index', 'device', v)
      if (w && w.status === 409) return { conflict: true } // the merged state is kept locally; the next pass re-reads and merges again
      if (!w || w.status !== 200) { this.lastError = fail('save_failed', 'the account index could not be saved', { status: w && w.status }); return { ok: false, rooms: this.rooms, devices: this.devices } }
    }
    // the index now carries each kept sign-out (written above, or it already had it) — or the device is gone from it: let go
    if (Object.keys(outs).length) {
      const left = Object.fromEntries(Object.entries(outs).filter(([id, at]) => merged.devices[id] && num(merged.devices[id].out) < at))
      if (Object.keys(left).length) s.outs = left; else delete s.outs
      this._backup._changed()
    }
    if (canon({ rooms: merged.rooms, tomb: merged.tomb }) !== roomsBefore) this._backup._persist() // the vault copy holds rooms + tombs, not devices
    if (usageCanon(merged) !== usageBefore) this._backup._changed() // this device keeps the account's usage key
    if (after !== before) { if (canon({ links: merged.links }) !== canon({ links: local.links })) this._backup._changed(); if (typeof this.onChange === 'function') { try { this.onChange({ rooms: this.rooms, devices: this.devices }) } catch { /* the app's callback */ } } }
    this.lastError = null
    return { ok: true, rooms: this.rooms, devices: this.devices }
  }
  _signedOut(reason) {
    this.stop()
    this._devices = {}
    this._backup._drop()
    if (typeof this.onSignedOut === 'function') { try { this.onSignedOut(reason ? { reason } : undefined) } catch { /* the app's callback */ } }
    return { ok: true, signedOut: true, rooms: [], devices: [], ...(reason ? { reason } : {}) }
  }
}
