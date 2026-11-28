// sdkComputers.js — `wb.computers`: the person's CLOUD COMPUTERS from a builder's page (docs/sdk-cloud-computers.md; the owner,
// 2026-10-24: "The user pays, full sdk set, the keys are with the user"). The same engine as the Code section — the opening
// (codeCloud.js: attest the enclave and its Sentinel against the published images, seal the grant and the bundle), the sealed
// relay to its connector (codeTransport.js), the connector's own route list (codeRelay.js) — and what the Code section keeps,
// kept in THIS app's account index (sdkAccount.js), sealed like every account document: a computer made here is listed here.
//
// The keys are the person's: the workspace's half, the relay secret, the owner/recovery secrets, the model keys and the AWS
// key that pays for its hours (awsKey.js) sit in the sealed account documents and in this page's memory while it works —
// as room keys do without a vault. In vault mode (docs/sdk-cloud-computers.md phase 3) they stay in the vault.
//
// Every dependency is injectable (`deps`) so the whole thing runs against fakes in tests.

import { attachmentWarning, partsFor, parseModel, normRevert, ocPermissionRuleset, OC_ASK_PERMISSIONS } from './opencodeWire.js'
import { pageQuery, cursorBefore, mayHaveMore, mergeTail, PAGE } from './codeHistory.js'
import { undoTarget } from './codeUndo.js'
import { commandTurn, normCommands } from './codeCommands.js'
import { acceptEditsRules, acceptsEdits, unsuitableCodeModels, wildcardMatch } from './codeModes.js'
import { sentinelKeys, askGenuine, decideTag } from './codeSentinel.js'
import { cachedSessions, loadSession, saveSession, clearSession, saveList, loadList, slimSession, prune, forgetComputer } from './codeCache.js'
import { idb } from './idb.js'
import { languageNudge, withLanguage } from './codeLanguage.js'
import { PendingCodeDrafts, providerRefusal, firstOutputStarted, promptLanded } from './codeSent.js'
import { normProgress, progressLine } from './codeProgress.js'
import { codeAgentPreference, computerModelPreference } from './sdkAccountSections.js'
import { FOLDER_ROUTE } from './codeFolders.js'
import { childIdsOf, childFromEvent, refusalOf, PERSON_REFUSAL } from './codeSubagents.js'
import { mkdirPath } from './codeMkdir.js'
import { CLOUD_HOME, newCloudComputer, openCloudComputer, closeCloud, CloudError } from './codeCloud.js'
import { mintCloudKeys } from './codeCloudKeys.js'
import { relayTransport, deletePairedCodeSession } from './codeTransport.js'
import { CLOUD_PICKS_MAX_BYTES, CLOUD_DOC, COMPUTERS_DOC, normCloud, mergeCloud, withCloud, withoutCloud, normRegistry, mergeRegistry, withComputer, withoutComputer, liveComputers } from './codeComputers.js'
import { normEgress } from './codeEgress.js'
import { AWS_KEY_DOC, ensureAwsKey, signAws, awsKeyStatus } from './awsKey.js'
import { sealDoc, openDoc } from './accountSeal.js'
import { CODE_KEYS_REVOKE } from './codeOrphanKeys.js' // the one address (it was written three times — sync sweep backlog P3)
import { FILES_DOWNLOAD_ROUTE, FILES_UPLOAD_ROUTE, MAX_FILE_TRANSFER, keepBothName } from './codeFilesRoutes.js' // the Files sheet's routes (codeFiles.js)
import { validAttachmentRef, parseAttachmentNote, ATTACHMENT_ROUTE } from './codeAttachments.js'
import { OUTPUT_ROUTE, replyOutputs } from './codeOutputs.js' // what a reply produced, screenshots included (codeOutputCards.js)
import { watchUrl } from './codeBrowse.js'
import { setSessionPrivate } from './sdkBrowserPrivate.js'

const fail = (code, message, extra = {}) => Object.assign(new Error('witbitz: ' + message), { code, ...extra })
const SEG = /^(?!\.)[A-Za-z0-9_.-]{1,128}$/
const seg = (v, what) => { const s = String(v || ''); if (!SEG.test(s)) throw fail('invalid_argument', `${what} is not an id`); return encodeURIComponent(s) }
const withDir = (p, dir) => (dir ? p + (p.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(dir) : p)
const sidQ = (sid) => encodeURIComponent(seg(sid, 'session') && String(sid))
const absPath = (p) => { const s = String(p || ''); if (!s.startsWith('/') || s.length > 4096 || /[\0\r\n]/.test(s)) throw fail('invalid_argument', 'a path on the computer is absolute (it starts with /)'); return s }
// bytes in any common shape → base64 (a builder hands a Blob from a file input, a Uint8Array, or base64 already)
async function toB64 (data) {
  if (typeof data === 'string') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('invalid_argument', 'upload data as a string is base64')
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
    const digits = data.length - padding
    if (digits % 4 === 1 || (padding && data.length % 4 !== 0)) throw fail('invalid_argument', 'upload data as a string is base64')
    if (Math.floor(digits * 3 / 4) > MAX_FILE_TRANSFER) throw fail('too_large', `a file is at most ${MAX_FILE_TRANSFER / 1024 / 1024} MB`)
    return data
  }
  if (data && typeof data.size === 'number' && data.size > MAX_FILE_TRANSFER) throw fail('too_large', `a file is at most ${MAX_FILE_TRANSFER / 1024 / 1024} MB`) // a Blob: before reading it
  let u8 = null
  if (data instanceof Uint8Array) u8 = data
  else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data)
  else if (data && typeof data.arrayBuffer === 'function') u8 = new Uint8Array(await data.arrayBuffer())
  if (!u8) throw fail('invalid_argument', 'upload data is a Blob, a File, an ArrayBuffer, a Uint8Array or base64')
  if (u8.length > MAX_FILE_TRANSFER) throw fail('too_large', `a file is at most ${MAX_FILE_TRANSFER / 1024 / 1024} MB`)
  let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** What a builder sees of a computer: never a secret. */
const infoOf = (id, reg, cloud) => {
  const r = reg.computers[id] || {}, c = cloud.cloud[id] || {}
  return { id, name: r.name || 'Cloud computer', cloud: true, version: Number(c.version) || 0, egress: (c.egress && c.egress.mode) || 'none' }
}

export class Computers {
  /** @param {object} wb the Witbitz client; @param {object} [deps] injectable engine (tests) */
  constructor (wb, deps = {}) {
    this._wb = wb
    this._d = { open: openCloudComputer, close: closeCloud, mint: mintCloudKeys, transport: relayTransport, fetch: (...a) => fetch(...a), ...deps }
    this._open = new Map() // id → Computer, while this page has it open
    this._opening = new Map() // id → the open in flight (a second open() of the same id waits for it: one handover — K#3)
    this._removed = new Set() // ids removed in this page: an open that finishes after its remove closes what it opened
  }

  // ── the account documents (sealed in this app's account index) ──────────────────────────────────────────────────────
  async _store (name) {
    this._guard()
    const acc = this._wb.account
    if (!acc || !acc.enabled) throw fail('not_enabled', 'turn the account on first (wb.backup.enable or restore) — a cloud computer lives in it')
    const loc = await acc._where(), c = acc._client()
    let v = null // the version get() read: put() lands only over it (sync sweep 11-08 #32)
    return {
      get: async () => {
        const r = await c.state(loc.room, loc.mk, name)
        if (!r || r.status !== 200) throw fail('unreadable', 'the account could not be read just now', { status: r && r.status })
        v = Number.isInteger(r.v) ? r.v : null
        const st = r.state
        return st == null || (typeof st === 'object' && !Object.keys(st).length) ? null : openDoc(loc.key, st)
      },
      put: async (doc) => {
        const w = await c.state(loc.room, loc.mk, name, await sealDoc(loc.key, doc), name, 'device', v ?? undefined)
        if (w && w.status === 409) throw fail('moved', 'another device changed the account just now')
        if (!w || w.status !== 200) throw fail('save_failed', 'the account could not be saved just now', { status: w && w.status })
      },
    }
  }
  async _deleteLockedSession(target, current) {
    const { reg } = await this._read()
    const cache = await this._cache(String(target).split('/')[0])
    return deletePairedCodeSession(liveComputers(reg), target, current, cache)
  }
  async _read () {
    const [rs, cs] = await Promise.all([this._store(COMPUTERS_DOC), this._store(CLOUD_DOC)])
    const [reg, cloud] = await Promise.all([rs.get(), cs.get()])
    return { reg: normRegistry(reg), cloud: normCloud(cloud), rs, cs }
  }
  /** Change both documents from what is there NOW (merged per entry by its own clock, as the Code section does). */
  async _write (change) {
    // each doc written only over the version read; another device's write in between → read, change and merge again
    for (let i = 0; ; i++) {
      const cur = await this._read()
      const next = change(cur)
      try {
        await cur.rs.put({ ...mergeRegistry(next.reg, cur.reg), at: Date.now() })
        await cur.cs.put({ ...mergeCloud(next.cloud, cur.cloud), at: Date.now() })
        return
      } catch (e) { if (!(e && e.code === 'moved') || i >= 4) throw e }
    }
  }
  /** Not in vault mode yet (docs/sdk-cloud-computers.md phase 3): the keys must stay in the vault, so nothing here runs. */
  _guard () { if (this._wb.vault) throw fail('vault_mode', 'cloud computers in vault mode come in a later release — the keys must stay in the vault') }
  _token () { return this._wb._auth('a cloud computer belongs').idToken }
  async _awsAdmit () {
    const rec = await ensureAwsKey({ token: this._token(), store: await this._store(AWS_KEY_DOC), fetchImpl: this._d.fetch })
    return signAws(rec, 'admit')
  }

  /** The account's cloud computers, newest first: `{ id, name, cloud, version, egress }` — never a secret. */
  async list () {
    this._guard()
    const { reg, cloud } = await this._read()
    return liveComputers(reg).filter((c) => cloud.cloud[c.id] && !cloud.cloud[c.id].removed).map((c) => infoOf(c.id, reg, cloud))
  }

  /**
   * A new cloud computer. Its model keys come from the account (capped, like a paired laptop's) unless `keys` brings the
   * person's own; its hours charge the person's AWS key when it is opened.
   * @param {object} o { name?, keys?: { trustedRouter, tinfoil?, github? }, egress?, browsePrivate? }
   */
  async create ({ name = 'Cloud computer', keys = null, egress = null, browsePrivate = false } = {}) {
    this._guard()
    const k = keys && typeof keys === 'object' ? keys : null
    const c = newCloudComputer({ name, key: k ? k.trustedRouter : '', tinfoil: k ? k.tinfoil : '', github: k ? k.github : '', browsePrivate })
    if (egress != null) {
      const e = normEgress(egress)
      if (e.error) throw fail('invalid_argument', `egress: ${e.error}`)
      c.cloud.egress = e.policy
    }
    if (!k || !k.trustedRouter) {
      const got = await this._d.mint({ computerId: c.id, name: c.name, idToken: this._token(), fetchImpl: this._d.fetch })
      if (!got.ok) throw fail(got.code || 'keys_refused', got.reason || 'the account did not give this computer its keys')
      c.cloud.key = got.tr; if (got.tinfoil) c.cloud.tinfoil = got.tinfoil; if (got.venice) c.cloud.venice = got.venice; c.cloud.codeKey = got.codeKey
    }
    await this._write(({ reg, cloud }) => ({ reg: withComputer(reg, c.id, { name: c.name, relay: c.relay, secret: c.secret }), cloud: withCloud(cloud, c.id, c.cloud) }))
    return { id: c.id, name: c.name, cloud: true, version: 0, egress: (c.cloud.egress && c.cloud.egress.mode) || 'none' }
  }

  async setDefaultPrivate(id, on) {
    this._guard()
    if (typeof on !== 'boolean') throw fail('invalid_argument', 'choose true or false')
    const { reg, cloud } = await this._read()
    const computer = reg.computers[id]
    if (!computer?.secret || computer.removed || !cloud.cloud[id] || cloud.cloud[id].removed) throw fail('not_found', 'no such cloud computer in this account')
    await this._patchCloud({ id, secret: computer.secret }, { browsePrivate: on ? true : null })
    const held = this._open.get(id)
    if (held?._c.secret === computer.secret) held._c.cloud.browsePrivate = on
  }

  async connections(id) {
    this._guard()
    const { reg, cloud } = await this._read()
    const pair = reg.computers[id], entry = cloud.cloud[id]
    if (!pair?.secret || pair.removed || !entry || entry.removed) throw fail('not_found', 'no such cloud computer in this account')
    return computerConnections(this, { id, secret: pair.secret })
  }

  async _cache(id) {
    this._guard()
    const account = this._wb.account
    if (!account?.enabled) throw fail('not_enabled', 'the account must be open to read its cached conversations')
    const state = account._backup?._s
    const check = () => { if (!account.enabled || account._backup?._s !== state) throw fail('account_changed', 'the account changed') }
    const loc = await account._where()
    check()
    const open = async (key, blob) => {
      const data = await openDoc(loc.key, blob.accountBox)
      check()
      if (data.key !== key) throw fail('unreadable', 'the cached conversation has a different identifier')
      return data.value
    }
    const store = {
      get: async key => { const blob = await idb.get(key); return blob ? open(key, blob) : null },
      set: async (key, value) => { const box = await sealDoc(loc.key, { key, value }); check(); return idb.set(key, { accountBox: box }) },
      entries: async prefix => Promise.all((await idb.entries(prefix)).map(async ([k, v]) => [k, await open(k, v)])),
      del: key => idb.del(key),
      delStrict: key => { check(); return idb.delStrict(key) },
    }
    return { cid: 'sdk:' + loc.room + ':' + seg(id, 'computer'), store, check }
  }
  async cachedSessions(id) {
    const { cid, store, check } = await this._cache(id)
    const rows = await cachedSessions(cid, store)
    check()
    return rows
  }
  async cachedDirectory(id) {
    const { cid, store, check } = await this._cache(id)
    const directory = await loadList(cid, store)
    check()
    return directory
  }
  async cachedSession(id, sid) {
    const { cid, store, check } = await this._cache(id)
    const row = await loadSession(cid, seg(sid, 'session'), store)
    check()
    return row
  }

  async _patchCloud(computer, patch) {
    return this._write(({ reg, cloud }) => {
      if (reg.computers[computer.id]?.removed || reg.computers[computer.id]?.secret !== computer.secret || !cloud.cloud[computer.id] || cloud.cloud[computer.id].removed) throw fail('not_found', 'this computer is no longer registered')
      return { reg, cloud: withCloud(cloud, computer.id, patch) }
    })
  }

  async _closeComputer(computer) {
    // THE STOP IS WHAT WAS ASKED; `closedAt` only says so to the account's other devices (second review, 2026-11-27). Run together,
    // a failed stamp rejected a close that had stopped the computer, and a failed stop was still published as closed.
    const stopped = await this._d.close(computer, { token: async () => this._token(), fetchImpl: this._d.fetch })
    if (stopped) await this._patchCloud(computer, { closedAt: Date.now() }).catch(() => {})
    return stopped
  }

  /** Stop a registered computer without starting or removing it. */
  async close (id) {
    this._guard()
    const opening = this._opening.get(id)
    if (opening) await opening.catch(() => {})
    const handle = this._open.get(id)
    if (handle) return handle.close()
    const { reg, cloud } = await this._read()
    const pair = reg.computers[id], entry = cloud.cloud[id]
    if (!pair || pair.removed || !entry || entry.removed) throw fail('not_found', 'no such cloud computer in this account')
    return this._closeComputer({ ...pair, id, cloud: entry })
  }

  /** Remove a computer: closed (a last save) and its account keys cancelled, best-effort; then dropped from the account. */
  async remove (id) {
    this._guard()
    const { reg, cloud } = await this._read()
    const entry = cloud.cloud[id]
    if (!entry || entry.removed) throw fail('not_found', 'no such cloud computer in this account')
    this._removed.add(id) // an open still in flight closes what it opened when it lands (pass 6, docs/state-machines.md K#3)
    const open = this._open.get(id); if (open) open._stop()
    // ★ THE ACCOUNT FIRST (second review, 2026-11-27). The computer was closed and its keys revoked, the cached transcript read and
    //   dropped, and only then was it taken off the account — a failed write (or cache read) left a computer still listed whose keys
    //   were gone, and `_removed` stayed set, so every later open() handed over and closed again. A failed write now changes nothing.
    try { await this._write(({ reg: r, cloud: cl }) => ({ reg: withoutComputer(r, id), cloud: withoutCloud(cl, id) })) }
    catch (e) { this._removed.delete(id); throw e }
    let token = ''; try { token = this._token() } catch { /* signed out: removal still goes ahead */ }
    if (token) {
      await this._d.close({ id, ...(reg.computers[id] || {}), cloud: entry }, { token: async () => token, fetchImpl: this._d.fetch }).catch(() => false)
      await this._d.fetch(CODE_KEYS_REVOKE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token, computerId: id }) }).catch(() => null)
    }
    try { const cache = await this._cache(id); await forgetComputer(cache.cid) } catch { /* this device's cached transcript: the removal stands */ }
  }

  /**
   * Open a computer: start or wake it, check it and its key guard run the published Witbitz images (a NEW published image is
   * followed: `images` 'auto' accepts it, 'ask' calls `onNewImage(pcr0, role)` → true to accept), hand it the person's keys
   * sealed, and connect. → a Computer.
   * @param {string} id
   * @param {object} [o] { onStep?(step), images?: 'auto' | 'ask', onNewImage?(pcr0, role) }
   */
  async open (id, o = {}) {
    this._guard()
    if (this._open.has(id)) {
      const live = this._open.get(id)
      if (o.cache) await live._enableCache()
      return live
    }
    // ★ ONE OPENING PER COMPUTER (pass 6, K#3): two open(id) calls not awaited in turn made two handovers and two Computers;
    //   the first one's close() then dropped the second from `_open`.
    if (this._opening.has(id)) {
      const live = await this._opening.get(id)
      if (o.cache) await live._enableCache()
      return live
    }
    const p = this._openNow(id, o).finally(() => { if (this._opening.get(id) === p) this._opening.delete(id) })
    this._opening.set(id, p)
    return p
  }

  async _openNow (id, { cache = false, onStep = () => {}, images = 'auto', onNewImage = null } = {}) {
    const { reg, cloud } = await this._read()
    const entry = cloud.cloud[id], pair = reg.computers[id]
    if (!entry || entry.removed || !pair || pair.removed) throw fail('not_found', 'no such cloud computer in this account')
    const computer = { id, name: pair.name, relay: pair.relay, secret: pair.secret, cloud: entry }
    const token = this._token()
    const follow = { auto: () => images === 'auto', ask: async (p, role) => !!(typeof onNewImage === 'function' && await onNewImage(p, role)), fetch: this._d.fetch }
    let saving = Promise.resolve()
    const save = (_c, patch) => {
      Object.assign(computer.cloud, patch)
      saving = saving.then(() => this._patchCloud(computer, patch))
      saving.catch(() => {}) // the open awaits the writes before handing back the computer
      return saving
    }
    try {
      // mint: null — a computer made with the builder's own keys (create({ keys })) STAYS on them: the app moves its pasted-key computers
      // to account keys at opening (codeCloud.js), the SDK never does (docs: "keys stay yours"; sync sweep 11-21 #1)
      await this._d.open(computer, { mint: null, token: async () => token, aws: () => this._awsAdmit(), save, openOpts: { onStep, follow, fetchImpl: this._d.fetch } })
    } catch (e) {
      if (e instanceof CloudError || (e && e.code)) throw Object.assign(fail(e.code || 'open_failed', String(e.message || e)), { status: e.status })
      throw e
    }
    // ★ REMOVED WHILE IT OPENED (pass 6, K#3): remove() found nothing to close (the enclave was not up yet) and revoked the keys;
    //   this open then finished a handover — a removed computer running, and billed, until the host's idle stop. Close it now.
    if (this._removed.has(id)) {
      await this._d.close(computer, { token: async () => token, fetchImpl: this._d.fetch }).catch(() => false)
      throw fail('not_found', 'this cloud computer was removed while it opened')
    }
    // ★ A FAILURE AFTER THE HANDOVER (review of the sweep fixes, 2026-11-27; 1384f426b made these awaited): the enclave is running
    //   and nothing holds it — close it before the error goes back, or it runs, and bills, until the host's idle stop.
    let c
    try {
      await saving
      const t = this._d.transport({ computer })
      c = new Computer(this, computer, t, cache ? await this._cache(id) : null)
    } catch (e) {
      await this._d.close(computer, { token: async () => token, fetchImpl: this._d.fetch }).catch(() => false)
      throw e
    }
    this._open.set(id, c)
    return c
  }

  /** This month on the person's AWS key: `{ live, tier, month: { usd, capUsd }, resetsAt }`, or null before the first opening. */
  async usage () {
    this._guard()
    const rec = await (await this._store(AWS_KEY_DOC)).get()
    return rec && rec.keyId ? awsKeyStatus(rec, { fetchImpl: this._d.fetch }) : null
  }
}

/** One open cloud computer: its coding sessions, the agent's approvals and questions, its files, and its live events. */
function computerConnections(owner, computer) {
  const currentPicks = ({ reg, cloud }) => {
    const c = cloud.cloud[computer.id]
    if (!c || c.removed || reg.computers[computer.id]?.removed || reg.computers[computer.id]?.secret !== computer.secret) throw fail('not_found', 'this cloud computer is no longer in the account')
    return c.connections || []
  }
  const changePicks = (id, pick) => owner._write(snapshot => {
    const connections = currentPicks(snapshot).filter(c => c.id !== id)
    if (pick) connections.push(pick)
    if (connections.length > 32 || new TextEncoder().encode(JSON.stringify(connections)).length > CLOUD_PICKS_MAX_BYTES) throw fail('too_large', 'the selected connections exceed the computer limit')
    const cloud = withCloud(snapshot.cloud, computer.id, { connections: connections.length ? connections : null })
    if (pick && !cloud.cloud[computer.id]?.connections?.some(c => c.id === id && c.mcp.tools.length === pick.mcp.tools.length)) throw fail('invalid_argument', 'the connection or its selected tools cannot be saved')
    return { reg: snapshot.reg, cloud }
  })
  return {
    list: async () => currentPicks(await owner._read()).map(c => ({ id: c.id, host: c.host, label: c.label, tools: c.mcp.tools.map(t => t.name), auto: [...c.mcp.auto] })),
    grant: async (conn, { tools, auto = [] } = {}) => {
      const account = await owner._wb._account()
      if (!conn?.mcp || !conn.id || !conn.callKey || !conn.host || !account || (conn.account && conn.account !== account)) throw fail('invalid_argument', 'choose an MCP connection belonging to this account')
      const catalog = await owner._wb.connections.mcpTools(conn.id)
      if (!Array.isArray(catalog?.tools)) throw fail('unreadable', 'the service did not return its tools')
      const names = tools ?? catalog.tools.slice(0, 40).map(t => t.name)
      if (!Array.isArray(names) || !names.length || names.length > 40 || !Array.isArray(auto) || auto.some(n => !names.includes(n))) throw fail('invalid_argument', 'choose up to 40 tools and which may run without asking')
      const picked = catalog.tools.filter(t => names.includes(t.name))
      if (picked.length !== names.length) throw fail('invalid_argument', 'choose tools offered by the service')
      await changePicks(conn.id, { account, id: conn.id, callKey: conn.callKey, host: conn.host, label: conn.label || conn.host, mcp: { tools: picked, auto } })
    },
    revoke: async id => { if (!id) throw fail('invalid_argument', 'a connection id is required'); await changePicks(id, null) },
  }
}

export class Computer {
  constructor (owner, computer, transport, cache = null) {
    this._owner = owner
    this._c = computer
    this._enableCache = async () => { cache ||= await owner._cache(computer.id) }
    this._t = transport
    this._streams = new Map() // directory → transport subscription and subscribers
    this._firstOutputWatches = new Set()
    // ★ THE SERVER SCOPES BY `directory` (opencodeApp.js withDir): an unscoped call reaches the server's DEFAULT project, so a
    //   session in another folder streamed nothing and its message / abort / todo calls missed it (sync sweep 11-08 #9 — only
    //   create scoped). Each session's folder is learned once (create, list, or GET /session/<id>, which answers unscoped)
    //   and sent on every call about it.
    this._dirs = new Map() // session id → its directory
    this.id = computer.id
    this.name = computer.name
    const req = (m, p, b) => this._req(m, p, b)
    const learn = (x) => { if (x && typeof x.id === 'string' && typeof x.directory === 'string' && x.directory) this._dirs.set(x.id, x.directory); return x }
    const inDir = async (sid, p) => withDir(p, await this._dirOf(sid))
    // A CALL ABOUT NO ONE SESSION (approvals, questions, status, files) is scoped too (sync sweep 11-09, 11-08 #9 half fixed: the
    // app sends the open session's folder, opencodeApp.js api; unscoped, an approval in another folder was never seen after a
    // reload and the agent waited). `{ dir }` or `{ session }` scopes one call; with neither, a list is asked in EVERY folder the
    // computer's sessions live in (learned from the session list once) and joined by id.
    const scopeOf = async ({ session = '', dir = '' } = {}) => (dir ? String(dir) : session ? this._dirOf(session) : null)
    const allDirs = async () => {
      const list = await req('GET', '/experimental/session?archived=true')
      if (!Array.isArray(list)) throw fail('unreadable', 'the computer did not return its sessions')
      list.forEach(learn)
      return ['', ...new Set(list.map(s => s?.directory).filter(Boolean))]
    }
    const listEverywhere = async (path, opts) => {
      const one = await scopeOf(opts)
      if (one !== null) return (await req('GET', withDir(path, one))) || []
      const seen = new Map()
      for (const d of await allDirs()) { let l = []; try { l = (await req('GET', withDir(path, d))) || [] } catch (e) { if (!d) throw e /* another folder's failure costs only its list */ } for (const x of Array.isArray(l) ? l : []) { const k = x && (x.id || x.requestID); if (k && !seen.has(k)) seen.set(k, x) } }
      return [...seen.values()]
    }
    const recentUserText = new Map()
    const modeAgents = new Map()
    const sessionCall = async (sid, method, suffix = '', body) => req(method, await inDir(sid, '/session/' + seg(sid, 'session') + suffix), body)
    const drafts = this._drafts = new PendingCodeDrafts()
    const sendParts = async (sid, parts, opts) => {
      const original = parts
      const keepDraft = reason => drafts.add(sid, { parts: structuredClone(original), reason })
      const ownText = parts.filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\n')
      const previous = recentUserText.get(sid) || []
      const texts = [ownText, ...previous].slice(0, 12)
      let ref = opts.model
      if (!ref) {
        const preferred = await this.preferredModel().catch(error => { if (error.code === 'account_changed') throw error; return '' })
        if (preferred && (await models(sid).catch(() => [])).some(m => m.ref === preferred)) ref = preferred
      }
      if (!transport.can?.('attachments') && parts.some(p => p.type === 'file' && p.mime?.toLowerCase() === 'application/pdf' && /^data:/i.test(p.url))) {
        const catalog = await modelCatalog(sid).catch(() => ({ offered: [], fallback: '' }))
        const offered = catalog.offered
        ref ||= catalog.fallback
        if (!offered.find(m => m.ref === ref)?.input?.includes('pdf')) {
          try {
            const { pdfToText, pdfTextBlock } = await import('./pdfText.js')
            parts = await Promise.all(parts.map(async p => {
              if (p.type !== 'file' || p.mime?.toLowerCase() !== 'application/pdf' || !/^data:/i.test(p.url)) return p
              const bytes = new Uint8Array(await (await fetch(p.url)).arrayBuffer())
              const doc = await pdfToText(bytes)
              return { type: 'text', text: pdfTextBlock({ name: p.filename, ...doc }) }
            }))
          } catch (cause) {
            throw fail('attachment_unreadable', 'Could not prepare the PDF. The prompt was kept as a draft.', { cause, draftId: keepDraft('unsent') })
          }
        }
      }
      const model = parseModel(ref)
      const saved = opts.effort == null && ref ? this.preferredEffort(ref) : ''
      const effort = opts.effort ?? (saved && (await models(sid).catch(() => [])).some(m => m.ref === ref && m.efforts?.includes(saved)) ? saved : '')
      const agent = opts.agent || await agentFor(sid)
      const nudge = languageNudge(texts)
      const promptPath = await inDir(sid, '/session/' + seg(sid, 'session') + '/message')
      const result = await req('POST', promptPath, { parts: nudge ? [...parts, nudge] : parts, ...(nudge ? { system: withLanguage('', texts).trim() } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(model && effort ? { variant: String(effort) } : {}) }).catch(error => {
        if ((error.code === 'request_failed' && (!error.status || error.status >= 500)) || error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError) {
          throw fail('submission_unknown', 'The computer did not confirm the prompt. Check the conversation before sending it again.', { cause: error, draftId: keepDraft('submission_unknown') })
        }
        error.draftId = keepDraft(error.code || 'request_failed')
        throw error
      })
      const refused = providerRefusal(result)
      if (refused) throw fail('provider_refused', refused, { draftId: keepDraft('provider_refused') })
      recentUserText.set(sid, texts)
      return result
    }
    const models = async sid => (await modelCatalog(sid)).offered
    const modelCatalog = async sid => {
      const serviceModels = await this._owner._wb?.models?.().catch(() => [])
      const unsuitable = new Set(unsuitableCodeModels(serviceModels))
      const catalog = await req('GET', await inDir(sid, '/config/providers')).catch(() => null)
      if (!Array.isArray(catalog?.providers)) {
        const legacy = await req('GET', await inDir(sid, '/api/model'))
        const offered = (legacy?.data || []).filter(m => m && !unsuitable.has(m.id) && m.status !== 'deprecated').map(m => ({ ref: m.providerID + '/' + m.id, label: m.name || m.id, input: m.capabilities?.input || m.input, efforts: Object.keys(m.variants || {}) }))
        return { offered, fallback: offered[0]?.ref || '' }
      }
      const owned = catalog.providers.filter(p => p.source !== 'custom')
      const offered = (owned.length ? owned : catalog.providers).flatMap(p => Object.entries(p.models || {}).filter(([id, m]) => m && m.status !== 'deprecated' && !unsuitable.has(id)).map(([id, m]) => ({
        ref: p.id + '/' + id, label: m.name || id, input: m.input, efforts: Array.isArray(m.variants) ? m.variants.map(String) : Object.keys(m.variants || {}),
      })))
      const configured = await req('GET', await inDir(sid, '/config')).catch(() => null)
      const candidates = [configured?.model, ...Object.entries(catalog.default || {}).map(([provider, id]) => provider + '/' + id)]
      return { offered, fallback: candidates.find(ref => offered.some(m => m.ref === ref)) || offered[0]?.ref || '' }
    }
    const agents = async sid => {
      const list = await req('GET', await inDir(sid, '/agent'))
      return list.filter(a => a?.name && a.mode === 'primary' && !a.hidden).map(a => ({ name: a.name, description: a.description || '' }))
    }
    const agentFor = async (sid, available) => {
      if (modeAgents.has(sid)) return modeAgents.get(sid)
      const name = await this.preferredAgent().catch(error => { if (error.code === 'account_changed') throw error; return '' })
      return name && (available || await agents(sid).catch(() => [])).some(a => a.name === name) ? name : ''
    }
    const messagePage = async (sid, { limit = 50, cursor = '' } = {}) => {
      limit = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50))
      let messages
      try { messages = await sessionCall(sid, 'GET', '/message?' + pageQuery({ limit, cursor })) }
      catch (error) {
        if (!cursor || error.status !== 400) throw error
        const all = await sessionCall(sid, 'GET', '/message')
        const at = Array.isArray(all) ? all.findIndex(m => cursorBefore(m) === cursor) : -1
        if (at < 0) throw fail('invalid_cursor', 'the older conversation page could not be located')
        messages = all.slice(Math.max(0, at - limit), at)
      }
      if (!Array.isArray(messages)) throw fail('unreadable', 'the computer did not return its messages')
      if (!cursor) {
        recentUserText.set(sid, messages.filter(m => m?.info?.role === 'user').slice(-12).reverse().map(m => (m.parts || []).filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\n')))
        if (cache) {
          cache.check()
          const cacheSid = seg(sid, 'session')
          const previous = await loadSession(cache.cid, cacheSid, cache.store).catch(() => null)
          cache.check()
          const snapshot = messages.length >= limit && messages[0]?.info?.id ? mergeTail(previous?.msgs, messages).messages : messages
          const write = snapshot.length ? saveSession(cache.cid, cacheSid, snapshot, { dir: this._dirs.get(sid) || '' }, cache.store) : clearSession(cache.cid, cacheSid, cache.store)
          await write.then(() => prune(cache.cid, undefined, cache.store)).catch(() => {})
        }
      }
      const next = mayHaveMore(messages, limit) && cursorBefore(messages[0])
      return { messages, cursor: next && next !== cursor ? next : null }
    }
    const changeAuto = async (sid, dir, on) => {
      const transport = this._t
      if (transport.autoSessions?.().includes(sid) === on) return
      await new Promise((resolve, reject) => {
        let off, timer
        const finish = error => { clearTimeout(timer); off?.(); error ? reject(error) : resolve() }
        const confirm = () => { if (transport.autoSessions?.().includes(sid) === on) finish() }
        timer = setTimeout(() => finish(fail('timeout', 'the computer did not confirm Auto mode')), 25000)
        off = transport.onAuto?.(confirm)
        try {
          if (!transport.setAuto(sid, dir, on)) finish(fail('unavailable', 'the computer could not switch Auto mode'))
          else confirm()
        } catch (error) { finish(error) }
      })
    }
    const modeChanges = new Map()
    this.preferredAgent = () => codeAgentPreference(this._owner._wb.account)
    this.setPreferredAgent = async (sid, name) => {
      if (typeof name !== 'string' || name.length > 256 || (name && !(await agents(sid)).some(a => a.name === name))) throw fail('invalid_argument', 'choose a primary agent on this computer')
      return codeAgentPreference(this._owner._wb.account, name)
    }
    this.onAutoVerdict = (sid, fn, { family = false } = {}) => {
      if (!sid || typeof fn !== 'function') throw fail('invalid_argument', 'a session and callback are required')
      if (!family) return transport.onAuto(e => { if (e?.kind === 'verdict' && e.verdict?.sessionID === sid) fn(e.verdict) })
      const children = new Set(), pending = []
      let active = true
      const flush = () => {
        for (let i = 0; i < pending.length;) {
          if (!children.has(pending[i].sessionID)) { i++; continue }
          const [v] = pending.splice(i, 1)
          fn(v)
        }
      }
      const offEvents = this.on('*', event => {
        const id = childFromEvent(event, sid, children)
        if (id) { children.add(id); flush() }
      }, { session: sid })
      const offAuto = transport.onAuto(e => {
        if (e?.kind !== 'verdict' || !e.verdict?.sessionID) return
        if (e.verdict.sessionID === sid || children.has(e.verdict.sessionID)) fn(e.verdict)
        else { pending.push(e.verdict); if (pending.length > 100) pending.shift() }
      })
      Promise.all([this.sessions.list(), this.sessions.messages(sid)]).then(([sessions, messages]) => {
        if (!active) return
        for (const id of childIdsOf(sid, { sessions, messages })) children.add(id)
        flush()
      }).catch(() => {})
      return () => { active = false; pending.length = 0; offEvents(); offAuto() }
    }
    this.onProgress = (sid, fn) => {
      if (!sid || typeof fn !== 'function') throw fail('invalid_argument', 'a session and callback are required')
      return transport.onProgress(m => { const p = normProgress(m); if (p?.sessionID === sid) fn(p) })
    }
    const effortKey = ref => 'wb-sdk:code-effort:' + JSON.stringify([owner._wb._endpoint, owner._wb._tenant, owner._wb._session?.email || '', computer.id, ref])
    this.preferredEffort = ref => {
      const key = effortKey(ref)
      try { return globalThis.localStorage?.getItem(key) || this._efforts?.get(key) || '' } catch { return this._efforts?.get(key) || '' }
    }
    this.setPreferredEffort = async (sid, ref, effort) => {
      const key = effortKey(ref)
      if (typeof ref !== 'string' || !ref || typeof effort !== 'string' || (effort && !(await models(sid)).some(m => m.ref === ref && m.efforts?.includes(effort)))) throw fail('invalid_argument', 'choose an effort offered for this model')
      if (key !== effortKey(ref)) throw fail('account_changed', 'the account changed')
      this._efforts ||= new Map()
      if (effort) this._efforts.set(key, effort)
      else this._efforts.delete(key)
      try { if (effort) globalThis.localStorage?.setItem(key, effort); else globalThis.localStorage?.removeItem(key) } catch { /* current handle still remembers */ }
    }
    this.preferredModel = () => computerModelPreference(this._owner._wb.account, this.id)
    this.setPreferredModel = async (sid, ref) => {
      if (typeof ref !== 'string' || ref.length > 256 || (ref && !(await models(sid)).some(m => m.ref === ref))) throw fail('invalid_argument', 'choose an available model on this computer')
      return computerModelPreference(this._owner._wb.account, this.id, ref)
    }
    this.sessions = {
      list: async () => {
        const list = await req('GET', '/experimental/session?archived=true')
        if (!Array.isArray(list)) throw fail('unreadable', 'the computer did not return its sessions')
        list.forEach(learn)
        if (cache) {
          cache.check()
          await saveList(cache.cid, list.slice(0, 200).map(slimSession), cache.store, { allowEmpty: true }).catch(() => {})
          cache.check()
        }
        return list
      },
      create: async ({ dir = '', title = '', agent = '', model = '' } = {}) => {
        const picked = model ? parseModel(model) : null
        if (model && !picked) throw fail('invalid_argument', 'choose a provider/model reference')
        if (agent && (typeof agent !== 'string' || agent.length > 256)) throw fail('invalid_argument', 'choose a primary agent')
        return learn(await req('POST', withDir('/session', dir), { permission: ocPermissionRuleset(), ...(title ? { title: String(title).slice(0, 200) } : {}), ...(agent ? { agent } : {}), ...(picked ? { model: { providerID: picked.providerID, id: picked.modelID } } : {}) }))
      },
      messages: async (sid, opts) => (await messagePage(sid, opts)).messages,
      messagePage,
      saveDraft: (sid, parts) => {
        seg(sid, 'session')
        if (!Array.isArray(parts) || !parts.length || parts.some(p => !p || typeof p !== 'object' || typeof p.type !== 'string')) throw fail('invalid_argument', 'provide the prompt parts to keep')
        const id = drafts.add(sid, { parts: structuredClone(parts), reason: 'unsent' })
        if (!id) throw fail('computer_closed', 'The computer session is closed')
        return id
      },
      listDrafts: sid => drafts.list(sid).map(({ id, reason }) => ({ id, reason })),
      getDraft: (sid, id) => structuredClone(drafts.get(sid, id)),
      discardDraft: (sid, id) => drafts.discard(sid, id),
      promptLanded: async (sid, text, knownUserIds) => {
        if (typeof text !== 'string' || !(Array.isArray(knownUserIds) || knownUserIds instanceof Set)) throw fail('invalid_argument', 'provide the prompt and the known user message IDs from before sending')
        const known = new Set(knownUserIds), visited = new Set()
        let cursor
        do {
          const page = await this.sessions.messagePage(sid, { cursor })
          if (promptLanded(page.messages, { knownUserIds: known, text })) return true
          if (page.messages.some(m => m?.info?.role === 'user' && known.has(m.info.id))) return false
          cursor = page.cursor
          if (cursor && visited.has(cursor)) throw fail('submission_unknown', 'The computer returned the same history page twice.')
          visited.add(cursor)
        } while (cursor)
        return false
      },
      watchFirstOutput: (sid, userMessageId, onStall, { timeoutMs = 60000 } = {}) => {
        if (!sid || !userMessageId || typeof onStall !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail('invalid_argument', 'a session, user message ID, callback and positive timeout are required')
        let active = true, off = null
        const stop = () => {
          if (!active) return
          active = false
          clearTimeout(timer)
          off?.()
          this._firstOutputWatches.delete(stop)
        }
        const timer = setTimeout(async () => {
          try {
            const messages = await this.sessions.messages(sid)
            const lastUser = messages.findLast(m => m?.info?.role === 'user')
            if (active && lastUser?.info?.id === userMessageId && !firstOutputStarted(messages)) onStall({ sessionId: sid, userMessageId })
          } catch { /* an unreadable conversation cannot establish a stalled reply */ }
          finally { stop() }
        }, timeoutMs)
        this._firstOutputWatches.add(stop)
        if (typeof transport.onProgress === 'function') off = this.onProgress(sid, p => { if (progressLine(p) || p.phase === 'end') stop() })
        return stop
      },
      attachments: (sid, message) => (message?.parts || []).filter(p => p?.synthetic && p.type === 'text')
        .flatMap(p => parseAttachmentNote(p.text) || []).filter(a => a.session === sid && validAttachmentRef(sid, a.file)),
      readAttachment: async (sid, file) => {
        if (!validAttachmentRef(sid, file)) throw fail('invalid_argument', 'an attachment reference from this session is required')
        const result = await req('GET', ATTACHMENT_ROUTE + '?session=' + encodeURIComponent(sid) + '&file=' + encodeURIComponent(file))
        if (typeof result?.b64 !== 'string') throw fail('unreadable', 'the computer did not return the attachment')
        return result
      },
      attachmentWarning: async (sid, ref, file) => {
        if (!file || typeof file.mime !== 'string') throw fail('invalid_argument', 'a file MIME type is required')
        const catalog = await modelCatalog(sid)
        const selected = ref || catalog.fallback
        const model = catalog.offered.find(m => m.ref === selected)
        return attachmentWarning({ mime: file.mime, modelLabel: model?.label || selected || 'this model', input: model?.input })
      },
      agents,
      family: async sid => {
        const [sessions, tail, approvals, questions] = await Promise.all([
          this.sessions.list(), this.sessions.messages(sid), this.approvals.pending({ session: sid }), this.questions.pending({ session: sid }),
        ])
        const children = [...childIdsOf(sid, { sessions, messages: tail })]
        const family = new Set([sid, ...children])
        return { children, approvals: approvals.filter(x => family.has(x.sessionID)), questions: questions.filter(x => family.has(x.sessionID)) }
      },
      approvalMode: async sid => {
        await modeChanges.get(sid)
        const [session, available] = await Promise.all([sessionCall(sid, 'GET'), agents(sid)])
        const modes = ['manual', 'accept']
        if (available.some(a => a.name === 'plan')) modes.push('plan')
        if (this._t.can?.('auto')) modes.push('auto')
        const agent = await agentFor(sid, available) || session?.agent || 'build'
        const rules = Array.isArray(session?.permission) ? session.permission : []
        const guarded = OC_ASK_PERMISSIONS.filter(p => p !== 'edit').every(p => {
          const matching = rules.filter(r => typeof r?.permission === 'string' && wildcardMatch(p, r.permission))
          const at = matching.findLastIndex(r => r.pattern === '*')
          return at >= 0 && matching.slice(at).every(r => r.action === 'ask' || r.action === 'deny')
        })
        const edit = rules.findLast(r => (r.permission === 'edit' || r.permission === '*') && r.pattern === '*')
        let mode = 'unknown'
        if (this._t.autoSessions?.().includes(sid)) mode = 'auto'
        else if (agent === 'plan') mode = 'plan'
        else if (agent === 'build' && guarded && edit) mode = acceptsEdits(rules) ? 'accept' : 'manual'
        return { mode, modes }
      },
      prompt: async (sid, text, opts = {}) => sendParts(sid, partsFor(text, opts.files), opts),
      models,
      archive: (sid, archived = true) => sessionCall(sid, 'PATCH', '', { time: { archived: archived ? Date.now() : 0 } }),
      undo: async sid => {
        const revert = normRevert((await sessionCall(sid, 'GET'))?.revert)
        let cursor, messageID, atBoundary = !revert
        const visited = new Set()
        do {
          const page = await messagePage(sid, { cursor, limit: PAGE })
          if (!atBoundary) atBoundary = page.messages.some(m => m?.info?.id === revert.messageID)
          if (atBoundary) messageID = undoTarget(page.messages, revert)
          cursor = page.cursor
          if (!cursor || visited.has(cursor)) break
          visited.add(cursor)
        } while (!messageID)
        if (!messageID) return { changed: false, files: false }
        const result = await sessionCall(sid, 'POST', '/revert', { messageID })
        return { changed: true, files: !!normRevert(result?.revert)?.files }
      },
      redo: async sid => {
        const revert = normRevert((await sessionCall(sid, 'GET'))?.revert)
        if (!revert) return { changed: false, files: false }
        await sessionCall(sid, 'POST', '/unrevert')
        return { changed: true, files: revert.files }
      },
      compact: async (sid, model) => {
        const selected = parseModel(model)
        if (!selected) throw fail('invalid_argument', 'select a provider/model to summarize this session')
        if ((await sessionCall(sid, 'GET'))?.revert) throw fail('undo_pending', 'redo or send a message before compacting')
        return sessionCall(sid, 'POST', '/summarize', selected)
      },
      commands: async sid => normCommands(await req('GET', await inDir(sid, '/command'))),
      runCommand: async (sid, text, opts = {}) => {
        const original = partsFor(text, opts.files)
        let turn, picked
        try {
          turn = commandTurn(text, await this.sessions.commands(sid))
          if (!turn || turn.blocked) throw fail(turn ? 'not_supported' : 'unknown_command', 'this project command is unavailable here')
          const status = await this.sessions.status({ session: sid })
          if (!status || typeof status !== 'object') throw fail('unreadable', 'the computer did not return its session status')
          if (status[sid] && status[sid].type !== 'idle') throw fail('busy', 'wait for the current Code turn to finish')
          picked = { ...opts }
          if (turn.model && (await models(sid)).some(m => m.ref === turn.model)) picked.model = turn.model
          if (turn.agent) {
            const available = await agents(sid)
            if (available.some(a => a.name === turn.agent)) picked.agent = turn.agent
          }
        } catch (error) {
          error.draftId = drafts.add(sid, { reason: 'unsent', parts: structuredClone(original) })
          throw error
        }
        return sendParts(sid, [{ type: 'text', text: turn.visible }, { type: 'text', text: turn.expanded, synthetic: true }, ...partsFor('', opts.files)], picked)
      },
      setApprovalMode: async (sid, mode) => {
        if (!['manual', 'accept', 'plan', 'auto'].includes(mode)) throw fail('invalid_argument', 'unknown approval mode')
        const auto = mode === 'auto', canAuto = !!this._t.can?.('auto')
        if (auto && !canAuto) throw fail('not_supported', 'this computer does not offer Auto')
        const change = (modeChanges.get(sid) || Promise.resolve()).catch(() => {}).then(async () => {
          if (mode === 'plan' && !(await agents(sid)).some(a => a.name === 'plan')) throw fail('not_supported', 'this computer does not offer Plan')
          const dir = await this._dirOf(sid)
          if (canAuto && !auto) await changeAuto(sid, dir, false)
          const session = await sessionCall(sid, 'GET')
          const rules = Array.isArray(session?.permission) ? session.permission : []
          const permission = []
          for (const base of ocPermissionRuleset()) {
            const last = rules.findLast(r => typeof r?.permission === 'string' && wildcardMatch(base.permission, r.permission) && r.pattern === '*')
            const action = base.permission === 'edit' && mode === 'accept' ? 'allow' : base.action
            if (last?.action === 'deny') continue
            const editRules = base.permission === 'edit' && mode === 'accept' ? acceptEditsRules() : null
            const protectedEdits = !editRules || editRules.every(target => rules.findLast(r => r.permission === 'edit' && r.pattern === target.pattern)?.action === target.action)
            if (last?.action === action && protectedEdits) continue
            permission.push(...(editRules || [{ ...base, action }]))
            const scoped = new Map()
            for (const r of rules) {
              if (r.permission !== base.permission || r.pattern === '*') continue
              if (r.action === 'deny' || base.permission === 'external_directory') scoped.set(r.pattern, r)
            }
            permission.push(...scoped.values())
          }
          if (permission.length) await sessionCall(sid, 'PATCH', '', { permission })
          if (auto) await changeAuto(sid, dir, true)
          modeAgents.set(sid, mode === 'plan' ? 'plan' : 'build')
          return { mode }
        })
        modeChanges.set(sid, change)
        try { return await change } finally { if (modeChanges.get(sid) === change) modeChanges.delete(sid) }
      },
      abort: async (sid) => req('POST', await inDir(sid, `/session/${seg(sid, 'session')}/abort`), {}),
      rename: async (sid, title) => req('PATCH', await inDir(sid, `/session/${seg(sid, 'session')}`), { title: String(title || '').slice(0, 200) }),
      remove: async (sid) => { const r = await req('DELETE', await inDir(sid, `/session/${seg(sid, 'session')}`)); this._dirs.delete(String(sid)); return r },
      todo: async (sid) => req('GET', await inDir(sid, `/session/${seg(sid, 'session')}/todo`)),
      /** { <session id>: status } — `{ session }` or `{ dir }` for one folder; otherwise every folder's, joined. */
      status: async (opts = {}) => {
        const one = await scopeOf(opts)
        if (one !== null) return req('GET', withDir('/session/status', one))
        const out = {}
        for (const d of await allDirs()) { try { Object.assign(out, (await req('GET', withDir('/session/status', d))) || {}) } catch (e) { if (!d) throw e } }
        return out
      },
    }
    this.connections = computerConnections(owner, computer)
    const approveKey = async () => {
      if (!computer.cloud?.grantKey) throw fail('not_supported', 'this computer has no key guard')
      return (await sentinelKeys(computer.cloud.grantKey)).approve
    }
    this.keyGuard = {
      pending: async () => {
        const key = await approveKey()
        const reply = await req('GET', '/witbitz/sentinel/asks')
        if (!Array.isArray(reply?.asks)) throw fail('unreadable', 'the key guard did not return its requests')
        const pending = []
        for (const ask of reply.asks) {
          if (typeof ask?.id === 'string' && ask.expires > Date.now() && await askGenuine(key, ask)) pending.push(ask)
        }
        return pending
      },
      decide: async (ask, allow) => {
        if (typeof allow !== 'boolean' || typeof ask?.id !== 'string' || !(ask.expires > Date.now())) throw fail('invalid_argument', 'a current key-guard request and a decision are required')
        const key = await approveKey()
        const id = ask.id
        if (!(await askGenuine(key, ask))) throw fail('unverified', 'the key guard could not verify this request')
        return req('POST', '/witbitz/sentinel/decide', { id, allow, tag: await decideTag(key, id, allow) })
      },
    }
    this.approvals = {
      refusalOf,
      folders: async (sid, id) => {
        if (!this._t.can?.('folders')) return []
        const result = await req('GET', await inDir(sid, FOLDER_ROUTE + '?ask=' + seg(id, 'approval')))
        return (result?.folders || []).filter(f => f && typeof f.path === 'string')
      },
      allowFolder: async (sid, id) => {
        if (!this._t.can?.('folders')) throw fail('not_supported', 'this computer does not offer folder approvals')
        const pending = await this.approvals.pending({ session: sid })
        if (!pending.some(p => p.sessionID === sid && (p.id || p.requestID) === id && p.permission === 'external_directory')) throw fail('not_pending', 'this session has no matching folder approval')
        if (!(await this.approvals.folders(sid, id)).length) throw fail('not_offered', 'the computer offered no folder for this request')
        return req('POST', await inDir(sid, FOLDER_ROUTE), { ask: id })
      },
      /** Every approval waiting, in every folder — or `{ session }` / `{ dir }` for one. */
      pending: async (opts = {}) => listEverywhere('/permission', opts),
      /** 'once' | 'always' | 'reject'; a reject may carry a message for the model ("stop and ask me"). */
      answer: async (id, response, { session = '', message = '' } = {}) => {
        if (!['once', 'always', 'reject'].includes(response)) throw fail('invalid_argument', "an approval is 'once', 'always' or 'reject'")
        if (response === 'reject') {
          // A connector from before the reply route refuses it (403/404/405): then the bare refusal on the old route, as the app does (codeApprovals.js).
          // in the session's FOLDER (sync sweep 11-08: an approval in another folder than the default was never found)
          const replyPath = `/permission/${seg(id, 'approval')}/reply`
          try { return await req('POST', session ? await inDir(session, replyPath) : replyPath, { reply: 'reject', message: String(message || PERSON_REFUSAL).slice(0, 2000) }) } catch (e) { if (!session || ![403, 404, 405].includes(e.status)) throw e }
        }
        if (!session) throw fail('invalid_argument', 'answering an approval needs its session id (the event carries it as sessionID)')
        return req('POST', await inDir(session, `/session/${seg(session, 'session')}/permissions/${seg(id, 'approval')}`), { response })
      },
    }
    this.questions = {
      pending: async (opts = {}) => listEverywhere('/question', opts),
      /** `{ session }` (the event's sessionID) or `{ dir }`: the folder the question is in — a question in another folder than the
       *  computer's default is answered there (sync sweep 11-08); neither = the default folder, as before. */
      answer: async (id, answers, opts = {}) => req('POST', withDir(`/question/${seg(id, 'question')}/reply`, (await scopeOf(opts)) || ''), { answers }),
      dismiss: async (id, opts = {}) => req('POST', withDir(`/question/${seg(id, 'question')}/reject`, (await scopeOf(opts)) || '')),
    }
    const filesCan = () => { if (this._t.can && !this._t.can('files')) throw fail('not_supported', 'this computer does not move files yet (an older image or connector)') }
    // a reply's files are their own capability (the connector's hello says `outputs`; codeOutputCards.js) — a computer that
    // moves files may not serve them yet (sync sweep 11-08 #33)
    const outputsCan = () => { if (this._t.can && !this._t.can('outputs')) throw fail('not_supported', 'this computer does not serve a reply\'s files yet (an older image or connector)') }
    this.files = {
      mkdir: async (sid, parent, name) => {
        const relative = String(parent || ''), leaf = String(name || '').trim()
        if (!leaf || leaf === '.' || leaf === '..' || /[\\/:\x00-\x1f]/.test(leaf) || relative.startsWith('/') || /[\\:\x00-\x1f]/.test(relative) || relative.split('/').includes('..')) throw fail('invalid_argument', 'use a relative parent folder and one folder name')
        return req('POST', sid === null ? withDir(mkdirPath(relative), CLOUD_HOME) : await inDir(sid, mkdirPath(relative)), { name: leaf })
      },
      // the folder's project: `{ session }` (that session's folder) or `{ dir }`; neither = the computer's default project
      list: async (path = '', opts = {}) => req('GET', withDir('/file?path=' + encodeURIComponent(String(path || '')), (await scopeOf(opts)) || '')),
      changes: async (opts = {}) => req('GET', withDir('/vcs/status', (await scopeOf(opts)) || '')),
      diff: async (opts = {}) => req('GET', withDir('/vcs/diff?mode=git', (await scopeOf(opts)) || '')),
      // FILES (the Code section's Files sheet, codeFiles.js — the owner's "build later" list, 2026-10-28): a file of the session's
      // folder, never one outside it or one that looks like a secret (the connector refuses those), at most 20 MB.
      /** → { name, kind, mime, size, mtime, b64 } */
      download: async (session, path) => { filesCan(); return req('GET', `${FILES_DOWNLOAD_ROUTE}?session=${sidQ(session)}&path=${encodeURIComponent(absPath(path))}`) },
      /** Into folder `dir` of the session. A name already there: onExists 'fail' (default — `exists`), 'replace', or 'keepBoth'
       *  ("report (2).pdf"). → { ok, name, path, size } */
      upload: async (session, { dir, name, data, onExists = 'fail' } = {}) => {
        filesCan()
        if (!['fail', 'replace', 'keepBoth'].includes(onExists)) throw fail('invalid_argument', "onExists is 'fail', 'replace' or 'keepBoth'")
        const n = String(name || '').trim()
        if (!n || /[/\\\0]/.test(n) || n === '.' || n === '..' || n.length > 255) throw fail('invalid_argument', 'a file name, without a folder')
        const b64 = await toB64(data)
        const route = `${FILES_UPLOAD_ROUTE}?session=${sidQ(session)}`
        const send = async (nm, replace) => this._t.request('POST', route, { dir: absPath(dir), name: nm, b64, ...(replace ? { replace: true } : {}) })
        let r = await send(n, onExists === 'replace')
        if (r && r.status === 409 && r.json && r.json.exists && onExists === 'keepBoth') {
          let taken = new Set(); try { const l = await req('GET', '/file?path=' + encodeURIComponent(absPath(dir))); taken = new Set((Array.isArray(l) ? l : []).map((e) => e && e.name)) } catch { taken = new Set([n]) }
          taken.add(n); r = await send(keepBothName(n, (x) => taken.has(x)), false)
        }
        if (r && r.status === 409 && r.json && r.json.exists) throw fail('exists', `${n} is already in that folder`, { status: 409, replaceable: !!r.json.replaceable })
        if (!r || !r.ok) throw fail(r && r.status === 403 ? 'refused' : 'request_failed', `upload ${n} — ${(r && ((r.json && r.json.error) || r.status)) || 'no answer'}`.slice(0, 300), { status: r && r.status })
        return r.json
      },
      /** A file a reply produced (outputs()), screenshots included → { name, kind, mime, size, b64 } */
      output: async (session, path) => { outputsCan(); return req('GET', `${OUTPUT_ROUTE}?session=${sidQ(session)}&path=${encodeURIComponent(absPath(path))}`) },
    }
    // THE AGENT'S BROWSER: its report, and PRIVATE browsing (codeTransport setBrowsePrivate) — where the computer says it can
    // (`canPrivate`: witbitz-code's browser on the person's own computer; a cloud image without it answers not_supported).
    this.browser = {
      status: () => (this._t.browse ? this._t.browse() : null),
      url: (opts = {}) => { if (opts.session !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(String(opts.session))) throw fail('invalid_argument', 'session is not an id'); return watchUrl({ ...this._c.cloud, relay: this._c.relay }, opts) },
      get private () { const b = transport.browse ? transport.browse() : null; return !!(b && b.private) },
      /** → true when sent (the computer's next report confirms it). */
      setPrivate: (on) => {
        const b = this._t.browse ? this._t.browse() : null
        if (!b || !b.canPrivate || typeof this._t.setBrowsePrivate !== 'function') throw fail('not_supported', 'this computer\'s browser has no private mode')
        if (!this._t.setBrowsePrivate(!!on)) throw fail('offline', 'the computer is not connected')
        return true
      },
      setDefaultPrivate: async on => {
        if (typeof on !== 'boolean') throw fail('invalid_argument', 'choose true or false')
        await owner._patchCloud(computer, { browsePrivate: on ? true : null })
        computer.cloud.browsePrivate = on
      },
      setSessionPrivate: (session, on) => setSessionPrivate({ ...this._c.cloud, relay: this._c.relay }, session, on),
    }
    this.egress = { get: () => (this._t.egress ? this._t.egress() : null) }
  }

  /** What a reply PRODUCED — files it wrote, the browser's screenshots, files its answer names that changed (codeOutputs.js,
   *  the Code section's previews). `messages`: the reply's messages (sessions.messages); omitted = the session's latest.
   *  → [{ path, kind: 'pdf'|'image'|'table'|'text'|'file', source: 'wrote'|'shot'|'named' }] — fetch one with files.output(). */
  async outputs (session, messages) {
    const sid = String(session || ''); seg(sid, 'session')
    const info = await this._req('GET', `/session/${encodeURIComponent(sid)}`)
    if (info && typeof info.directory === 'string' && info.directory) this._dirs.set(sid, info.directory)
    let ms = Array.isArray(messages) ? messages : ((await this._req('GET', withDir(`/session/${encodeURIComponent(sid)}/message?limit=20`, this._dirs.get(sid) || ''))) || [])
    if (!Array.isArray(messages)) { const k = ms.map((m) => m && m.info && m.info.role).lastIndexOf('user'); ms = k >= 0 ? ms.slice(k + 1) : ms } // the latest reply: after the last prompt
    return replyOutputs(ms, { directory: (info && info.directory) || '', session: sid })
  }

  /** 'online' | 'connecting' | 'offline' */
  get status () { return this._t.status() }

  async _req (method, path, body) {
    const r = await this._t.request(method, path, body)
    if (!r || !r.ok) {
      const code = r && r.status === 403 ? 'refused' : r && r.status === 404 ? 'not_found' : 'request_failed'
      throw fail(code, `${method} ${path.split('?')[0]} — ${(r && (r.text || r.status)) || 'no answer'}`.slice(0, 300), { status: r && r.status })
    }
    return r.json
  }

  /** @private a session's directory — learned once, then kept ('' when the computer does not say) */
  async _dirOf (sid) {
    const id = String(sid || '')
    if (this._dirs.has(id)) return this._dirs.get(id)
    let d = '', known = false
    try { const info = await this._req('GET', `/session/${encodeURIComponent(seg(id, 'session') && id)}`); d = info && typeof info.directory === 'string' ? info.directory : ''; known = true } catch { d = '' }
    if (known) this._dirs.set(id, d) // an answer without a folder is kept too (asked once); a failed ask is asked again next time
    return d
  }

  /** Live events from the computer (OpenCode's, parsed): `on('message.part.updated', fn)`, or `on('*', fn)` for all. → off
   *  The computer streams per FOLDER: pass `{ session }` (its folder is looked up) or `{ dir }` for a session outside the
   *  server's default folder — without it, its events never arrive. */
  on (type, fn, { session = '', dir = '' } = {}) {
    if (typeof fn !== 'function') throw fail('invalid_argument', 'on(type, fn) needs a function')
    let off = false, stream = null, streamDir = ''
    const attach = (d) => {
      if (off) return
      streamDir = d
      stream = this._streams.get(d)
      if (!stream) {
        stream = { subs: new Map(), stop: null }
        this._streams.set(d, stream)
        const st = stream
        st.stop = this._t.subscribe(withDir('/event', d), (ev) => {
          for (const key of [ev && ev.type, '*']) for (const f of st.subs.get(key) || []) { try { f(ev) } catch { /* a builder's handler never stops the stream */ } }
        })
      }
      if (!stream.subs.has(type)) stream.subs.set(type, new Set())
      stream.subs.get(type).add(fn)
    }
    if (dir || !session) attach(String(dir || ''))
    else this._dirOf(session).then(attach, () => attach(''))
    return () => {
      off = true
      const listeners = stream?.subs.get(type)
      if (!listeners || !listeners.delete(fn)) return
      if (!listeners.size) stream.subs.delete(type)
      if (!stream.subs.size && this._streams.get(streamDir) === stream) {
        this._streams.delete(streamDir)
        stream.stop?.()
      }
    }
  }

  _stop () { this._drafts.close(); for (const cancel of this._firstOutputWatches) cancel(); for (const st of this._streams.values()) { try { if (st.stop) st.stop() } catch { /* */ } } this._streams.clear(); try { this._t.close() } catch { /* */ } if (this._owner._open.get(this.id) === this) this._owner._open.delete(this.id) } // only itself: never a newer opening of the same computer

  /** Close it: a last save, then the enclave stops (its hours stop counting). */
  async close () {
    this._stop()
    return this._owner._closeComputer(this._c)
  }
}
