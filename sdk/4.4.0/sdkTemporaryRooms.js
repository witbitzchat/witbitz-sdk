import { deviceWrapKey } from './vaultAtRest.js'
import { seal, open } from './deviceSeal.js'

const fail = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })
const pendingScope = wb => JSON.stringify([wb._endpoint, wb._tenant, wb._clientOpts.app || '', wb._session?.email || ''])
const storagePrefix = scope => 'wb-sdk:temporary:' + encodeURIComponent(scope) + ':'

export class TemporaryRooms {
  constructor(wb, persist) {
    this._wb = wb
    this._persist = persist === true
    this._memory = new Map()
    this._generation = 0
  }

  _scope() {
    if (this._wb.vault) throw fail('vault_unsupported', 'temporary rooms are unavailable in vault mode')
    return pendingScope(this._wb)
  }

  async _remember(sp, scope, { days, title } = {}) {
    if (scope !== this._scope()) return
    const generation = this._generation, name = storagePrefix(scope) + sp.room
    const previous = this._memory.get(name) || (await this._records(scope, sp.room)).get(name)
    if (scope !== this._scope() || generation !== this._generation) return
    const record = { ...previous, room: sp.room, link: sp.shareLink, at: previous?.at || Date.now() }
    if (days) record.days = days
    const label = sp.title || title
    if (label) record.title = String(label).slice(0, 200)
    sp._temporaryScope = scope
    this._memory.set(name, record)
    if (!this._persist) return
    try {
      const key = await deviceWrapKey({ name: 'witbitz-sdk-temporary' })
      if (!key) return
      const blob = await seal(key, { scope, ...record })
      if (pendingScope(this._wb) === scope && this._generation === generation && this._memory.get(name) === record) globalThis.localStorage.setItem(name, JSON.stringify(blob))
    } catch { /* still available in this SDK instance */ }
  }

  async _records(scope, onlyRoom) {
    const prefix = storagePrefix(scope)
    const wanted = onlyRoom ? prefix + onlyRoom : null
    const rows = new Map([...this._memory].filter(([k]) => wanted ? k === wanted : k.startsWith(prefix)))
    if (!this._persist) return rows
    let key, storage
    try {
      storage = globalThis.localStorage
      if (!storage) return rows
      key = await deviceWrapKey({ name: 'witbitz-sdk-temporary' })
    } catch { return rows }
    if (!key) return rows
    const names = wanted ? [wanted] : Array.from({ length: storage.length }, (_, i) => storage.key(i))
    for (const name of names) {
      if (!name?.startsWith(prefix) || rows.has(name)) continue
      try {
        const blob = storage.getItem(name)
        if (!blob) continue
        const row = await open(key, JSON.parse(blob))
        if (row?.scope === scope && row.room?.startsWith('tmp-') && name === prefix + row.room) rows.set(name, row)
      } catch { /* leave unreadable records in place and continue with the others */ }
    }
    return rows
  }

  async _status(row) {
    if (Date.now() - row.at < (row.days ? row.days * 86_400_000 : 30 * 60_000)) return 'recent'
    try {
      const k = await this._wb._openLink(row.link)
      if (k.room !== row.room) return 'unknown'
      const r = await this._wb._client.pollSealed(k.room, k.mk, '', 0)
      if (r?.status === 410) return 'expired'
      if (r?.status === 200 && !r.changed && !r.entries?.length) return 'unknown'
      return r?.status === 200 ? 'live' : 'unknown'
    } catch { return 'unknown' }
  }

  _drop(name) {
    this._memory.delete(name)
    if (this._persist) globalThis.localStorage?.removeItem(name)
  }

  _title(sp) {
    if (sp._temporaryScope !== this._scope()) return
    const row = this._memory.get(storagePrefix(sp._temporaryScope) + sp.room)
    if (row && row.title !== sp.title) this._remember(sp, sp._temporaryScope).catch(() => {})
  }

  _erase(scope) {
    this._generation++
    const prefix = storagePrefix(scope)
    for (const name of this._memory.keys()) if (name.startsWith(prefix)) this._memory.delete(name)
    let storage
    try { storage = globalThis.localStorage } catch { return }
    if (!storage) return
    for (let i = storage.length - 1; i >= 0; i--) {
      const name = storage.key(i)
      if (name?.startsWith(prefix)) storage.removeItem(name)
    }
  }

  async list() {
    const scope = this._scope(), rows = await this._records(scope), result = []
    for (const [name, row] of rows) {
      const status = await this._status(row)
      if (scope !== this._scope()) throw fail('account_changed', 'the account changed')
      if (status === 'expired') this._drop(name)
      else result.push({ room: row.room, at: row.at, title: row.title || '', status })
    }
    if (scope !== this._scope()) throw fail('account_changed', 'the account changed')
    return result.sort((a, b) => b.at - a.at)
  }

  async open(room, options) {
    const scope = this._scope(), name = storagePrefix(scope) + room
    const row = (await this._records(scope, room)).get(name)
    if (!row) throw fail('not_found', 'this device has no such temporary room')
    const status = await this._status(row)
    if (scope !== this._scope()) throw fail('account_changed', 'the account changed')
    if (status === 'expired') { this._drop(name); throw fail('expired', 'this temporary room has expired') }
    return this._wb.openSpace(row.link, options)
  }
}
