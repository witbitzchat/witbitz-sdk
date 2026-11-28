import { sealDoc } from './accountSeal.js'
import { disconnectKeptSpace, keptAgentSpaceIds } from './sdkKeptAgent.js'

const fail = (code, text, status) => Object.assign(new Error('witbitz: ' + text), { code, ...(status ? { status } : {}) })
const current = (wb, session, state) => { if (wb._session !== session || wb.backup._s !== state) throw fail('account_changed', 'the account changed during the cloud-device operation') }

/** A kept Space remains solo and has no private lane of its own, on every SDK/vault device. */
export async function assertNotKept(space) {
  // ⚑ A VAULT FROM BEFORE THIS CHECK (the 4.2.0 kit) answers `vault_refused` to the unknown call — a 4.3.0 page could then open
  //   no private lane and change no members against it (second review, 2026-11-27). No answer there = no check, as before 4.3.0;
  //   the cloud device drops a kept Space that gained people or lanes at its next tick either way (cloud-device/scope.mjs).
  if (space._wb?.vault) {
    try { return await space._wb.vault._c.roomAccount(space.room, 'alwaysOn', 'assertNotKept') }
    catch (e) { if (e && e.code === 'vault_refused') return; throw e }
  }
  if (await isKeptSpace(space)) throw fail('kept_space', 'stop keeping this Space always on before adding people or private lanes')
}

export async function isKeptSpace(space) {
  const w = space._wb, a = w && w.account
  if (!a?.enabled || typeof a._read !== 'function') {
    if (!w?._session?.email || space._sharedRoom) return false
    if (!w.cloudDevice) throw fail('index_unavailable', 'the Space’s always-on status could not be checked')
    try { return (await w.cloudDevice.status()).rooms.some((r) => r.room === space.room) }
    catch (e) { if (['not_available', 'cloud_device_unavailable', 'not_enrolled', 'not_in_dev_server', 'sign_in_required'].includes(e.code)) return false; throw e } // sign_in_required: a lapsed sign-in cannot ask — and it blocked every lane and member change of an OPEN room, kept or not (second review, 2026-11-27); // cloud_device_unavailable: this deployment runs no cloud device (agent/cloudDeviceRoute.mjs, 501), so nothing here is kept
  }
  const session = w._session, state = w.backup._s, loc = await a._where()
  current(w, session, state)
  const r = await a._read(loc, 'xindex', loc.app)
  current(w, session, state)
  if (!r.ok) throw fail('index_unavailable', 'the account’s always-on mark could not be read')
  return !!r.doc?.rooms?.[space.room]?.alwaysOn
}

export async function disconnectRoomLanes(w, room) {
  if (!w) return
  for (const lane of w._openLanes || []) if (lane._sharedRoom === room) lane._detachShared()
  const session = w._session, state = w.backup?._s
  const sync = async () => {
    const result = await w.account.sync()
    current(w, session, state)
    if (!result?.ok) throw fail('index_unavailable', 'the disconnected lanes could not be synced')
  }
  if (w.account?.enabled) await sync()
  const held = w._heldLaneRooms?.(room) || []
  const children = new Set([...held, ...(w.backup?.rooms || []).filter(r => r.kind === 'lane' && r.shared === room).map(r => r.room)])
  const links = (w.account?.links || []).filter(l => l.a === room || l.b === room)
  for (const link of links) w.account._dropLink(link.a, link.b)
  for (const child of children) w.backup?._detachLane(child, room)
  if (held.length) { await w._detachHeldLanes(room); current(w, session, state) }
  if (w.account?.enabled && (links.length || children.size)) await sync()
}

/** Requests use the attested, encrypted cloud-device channel. */
export class CloudDevice {
  constructor(wb) { this._wb = wb }
  async _ask(t, body = {}) {
    const w = this._wb, auth = w._auth('the cloud device belongs to an account')
    const session = w._session, state = w.backup._s
    const opts = typeof w._cloudDeviceOpts === 'function' ? await w._cloudDeviceOpts() : undefined // devRoot: the dev server's device, under its root
    if (typeof (w._client && w._client.cloudDevice) !== 'function') throw fail('not_available', 'this client has no cloud device') // a builder's own client, a test's: no device here (isKeptSpace reads that as not kept)
    const r = await w._client.cloudDevice({ t, ...body }, auth.idToken, opts)
    current(w, session, state)
    if (!r || r.status !== 200 || r.ok === false) throw fail((r && r.error) || 'offline', (r && (r.message || r.reason)) || 'the cloud device did not answer', r && r.status)
    return r
  }
  async status() {
    const w = this._wb
    if (w.vault) return w.vault._c.account('cloudDevice', 'status')
    const h = await this._ask('hello')
    return { email: h.email || null, registered: !!h.registered, rooms: Array.isArray(h.rooms) ? h.rooms : [], builds: h.builds || null }
  }
  async enroll({ getCode } = {}) {
    const w = this._wb
    if (w.vault) return w.vault._c.account('cloudDevice', 'enroll')
    if (typeof getCode !== 'function') throw fail('no_screen', 'cloud-device sign-in needs an emailed code')
    const session = w._session, state = w.backup._s
    await this._ask('enrol')
    const code = await getCode(); current(w, session, state)
    await this._ask('code', { code: String(code || '').trim() })
    return this.status()
  }
  async register({ getCode } = {}) {
    const w = this._wb
    if (w.vault) return w.vault._c.account('cloudDevice', 'register')
    if (!w.backup._v2 || w.backup.service !== 'account') throw fail('not_on_service', 'register the cloud device from an account on the account service')
    const session = w._session, state = w.backup._s
    const { spk } = await this._ask('devkey'); current(w, session, state)
    const registration = await w.backup._v2.enrolCloudDevice(w.backup, { spk, getCode })
    current(w, session, state)
    await this._ask('devready', { base: registration.base })
    return this.status()
  }
  async setBuilds(state) {
    const w = this._wb
    if (w.vault) return w.vault._c.account('cloudDevice', 'setBuilds', state)
    return this._ask('builds', { state })
  }
  async forget() {
    const w = this._wb
    if (w.vault) return w.vault._c.account('cloudDevice', 'forget')
    const session = w._session, state = w.backup._s, h = await this.status()
    current(w, session, state)
    let cleanupError
    const links = await keptAgentSpaceIds(w)
    let marked = []
    if (w.account?.enabled && typeof w.account._read === 'function') {
      const loc = await w.account._where()
      const entry = await w.account._read(loc, 'xindex', loc.app)
      current(w, session, state)
      if (!entry.ok) throw fail('index_unavailable', 'the account’s always-on marks could not be read')
      marked = Object.entries(entry.doc?.rooms || {}).filter(([, r]) => r?.alwaysOn).map(([id]) => id)
    }
    const rooms = [...new Set([...h.rooms.map((r) => r.room), ...links])]
    current(w, session, state)
    for (const room of rooms) {
      const r = { room }
      let sp
      try {
        if (w._agentRoom) sp = w._agentRoom(r.room)
        else { const rec = w.backup.rooms.find((x) => x.room === r.room); if (!rec) throw fail('not_in_account', 'restore the kept Space to finish unlinking it'); sp = await w.openSpace(rec.link, { live: false }) }
        await disconnectKeptSpace(sp)
      } catch (e) { cleanupError = cleanupError || e }
      finally { if (sp) sp.close() }
      current(w, session, state)
    }
    try { await this._ask('forget') } catch (e) { if (e.code !== 'not_enrolled') throw e }
    current(w, session, state)
    for (const room of new Set([...rooms, ...marked])) { current(w, session, state); await markKept(w, room, false) }
    if (cleanupError) throw cleanupError
    return { forgotten: true }
  }
}

/** The app's per-room always-on mark, over a versioned read; links to a stopped kept assistant are tombstoned. */
async function markKept(w, room, on) {
  const a = w.account
  if (!a || !a.enabled) return
  const s = w.backup._s, session = w._session
  if (!on) for (const l of a.links) if (l.a === room || l.b === room) a._dropLink(l.a, l.b)
  const synced = await a.sync(); current(w, session, s)
  if (!synced || !synced.ok) throw fail('index_unavailable', 'the device changed, but its account mark could not sync; check its status')
  for (let i = 0; i < 5; i++) {
    const loc = await a._where(), got = await a._read(loc, 'xindex', loc.app); current(w, session, s)
    if (!got.ok) throw fail('index_unavailable', 'the account mark could not be read')
    const doc = got.doc || {}, entry = (doc.rooms || {})[room]
    if (!entry) throw fail('not_in_account', 'the cloud device changed, but this Space is absent from the account index')
    const at = Math.max(Date.now(), (Number(entry.alwaysOnAt) || 0) + 1)
    const next = { ...doc, rooms: { ...(doc.rooms || {}), [room]: { ...entry, alwaysOn: !!on, alwaysOnAt: at } } }
    const r = await a._client().state(loc.room, loc.mk, 'xindex', await sealDoc(loc.app, next), 'always on', 'device', got.v)
    current(w, session, s)
    if (r && r.status === 409) continue
    if (!r || r.status !== 200) throw fail('save_failed', 'the cloud-device account mark could not be saved')
    return
  }
  throw fail('version_conflict', 'the account kept changing; check the cloud-device status and retry')
}

export class SpaceAlwaysOn {
  constructor(space) { this._sp = space }
  _client() { const w = this._sp._wb; if (!w) throw fail('no_client', 'open this Space through a Witbitz client'); return w }
  async status() {
    const w = this._client(), s = this._sp
    if (w.vault) return w.vault._c.roomAccount(s.room, 'alwaysOn', 'status')
    const h = await w.cloudDevice.status(), entry = h.rooms.find((r) => r.room === s.room)
    return { on: !!entry, registered: h.registered, ...(entry && entry.waiting ? { waiting: entry.waiting } : {}) }
  }
  async enable({ disconnectLanes = false } = {}) {
    const w = this._client(), s = this._sp
    if (w.vault) return w.vault._c.roomAccount(s.room, 'alwaysOn', 'enable', { disconnectLanes: !!disconnectLanes })
    if (s._sharedRoom || String(s.room).startsWith('tmp-')) throw fail('not_supported', 'private lanes and temporary Spaces cannot be kept always on')
    if (!w.account.enabled) throw fail('not_enabled', 'enable the account backup before keeping a Space always on')
    const session = w._session, state = w.backup._s
    const synced = await w.account.sync()
    current(w, session, state)
    if (!synced?.ok) throw fail('index_unavailable', 'the account’s linked rooms could not be checked')
    const cfg = await s._gateConfig({ fresh: true })
    current(w, session, state)
    const linked = w.account.links?.some((l) => l.a === s.room || l.b === s.room)
    const children = new Set((w.backup.rooms || []).filter((r) => r.kind === 'lane' && r.shared === s.room).map((r) => r.room))
    for (const room of w._heldLaneRooms?.(s.room) || []) children.add(room)
    if (linked || children.size || cfg.lanes === true || s.lanes) {
      if (!disconnectLanes) throw fail('lanes_enabled', 'turn private assistants off, or pass disconnectLanes: true')
      await s.configure({ lanes: false })
      current(w, session, state)
      await disconnectRoomLanes(w, s.room)
      current(w, session, state)
    }
    if (!s.shareLink) throw fail('no_link', 'this device does not hold the Space’s current link')
    if (w.builds && w.builds.mode === 'mine') {
      await w.builds.sync()
      current(w, session, state)
      await w.cloudDevice.setBuilds(w.builds.state)
      current(w, session, state)
    }
    await w.cloudDevice._ask('room', { link: s.shareLink })
    current(w, session, state)
    await markKept(w, s.room, true)
    return { on: true }
  }
  async disable() {
    const w = this._client(), s = this._sp
    if (w.vault) return w.vault._c.roomAccount(s.room, 'alwaysOn', 'disable')
    const session = w._session, state = w.backup._s
    let cleanupError
    try { await disconnectKeptSpace(s) } catch (e) { cleanupError = e }
    current(w, session, state)
    try { await w.cloudDevice._ask('unroom', { room: s.room }) } catch (e) { if (e.code !== 'not_enrolled') throw e }
    current(w, session, state)
    await markKept(w, s.room, false)
    if (cleanupError) throw cleanupError
    return { on: false }
  }
  async run(text) {
    const w = this._client(), s = this._sp
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw fail('invalid_argument', 'run needs 1–8000 characters')
    if (w.vault) return w.vault._c.roomAccount(s.room, 'alwaysOn', 'run', text)
    const r = await w.cloudDevice._ask('run', { room: s.room, text })
    return { started: r.started === true }
  }
}
