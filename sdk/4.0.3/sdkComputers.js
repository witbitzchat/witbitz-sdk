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

import { newCloudComputer, openCloudComputer, closeCloud, CloudError } from './codeCloud.js'
import { mintCloudKeys } from './codeCloudKeys.js'
import { relayTransport } from './codeTransport.js'
import { CLOUD_DOC, COMPUTERS_DOC, normCloud, mergeCloud, withCloud, withoutCloud, normRegistry, mergeRegistry, withComputer, withoutComputer, liveComputers } from './codeComputers.js'
import { normEgress } from './codeEgress.js'
import { AWS_KEY_DOC, ensureAwsKey, signAws, awsKeyStatus } from './awsKey.js'
import { sealDoc, openDoc } from './accountSeal.js'
import { CODE_KEYS_REVOKE } from './codeOrphanKeys.js' // the one address (it was written three times — sync sweep backlog P3)
import { FILES_DOWNLOAD_ROUTE, FILES_UPLOAD_ROUTE, MAX_FILE_TRANSFER, keepBothName } from './codeFilesRoutes.js' // the Files sheet's routes (codeFiles.js)
import { OUTPUT_ROUTE, replyOutputs } from './codeOutputs.js' // what a reply produced, screenshots included (codeOutputCards.js)

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
    if (data.length * 3 / 4 > MAX_FILE_TRANSFER) throw fail('too_large', `a file is at most ${MAX_FILE_TRANSFER / 1024 / 1024} MB`)
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

  /** Remove a computer: closed (a last save) and its account keys cancelled, best-effort; then dropped from the account. */
  async remove (id) {
    this._guard()
    const { reg, cloud } = await this._read()
    const entry = cloud.cloud[id]
    if (!entry || entry.removed) throw fail('not_found', 'no such cloud computer in this account')
    this._removed.add(id) // an open still in flight closes what it opened when it lands (pass 6, docs/state-machines.md K#3)
    const open = this._open.get(id); if (open) open._stop()
    let token = ''; try { token = this._token() } catch { /* signed out: removal still goes ahead */ }
    if (token) {
      await this._d.close({ id, ...(reg.computers[id] || {}), cloud: entry }, { token, fetchImpl: this._d.fetch }).catch(() => false)
      await this._d.fetch(CODE_KEYS_REVOKE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token, computerId: id }) }).catch(() => null)
    }
    await this._write(({ reg: r, cloud: cl }) => ({ reg: withoutComputer(r, id), cloud: withoutCloud(cl, id) }))
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
    if (this._open.has(id)) return this._open.get(id)
    // ★ ONE OPENING PER COMPUTER (pass 6, K#3): two open(id) calls not awaited in turn made two handovers and two Computers;
    //   the first one's close() then dropped the second from `_open`.
    if (this._opening.has(id)) return this._opening.get(id)
    const p = this._openNow(id, o).finally(() => { if (this._opening.get(id) === p) this._opening.delete(id) })
    this._opening.set(id, p)
    return p
  }

  async _openNow (id, { onStep = () => {}, images = 'auto', onNewImage = null } = {}) {
    const { reg, cloud } = await this._read()
    const entry = cloud.cloud[id], pair = reg.computers[id]
    if (!entry || entry.removed || !pair || pair.removed) throw fail('not_found', 'no such cloud computer in this account')
    const computer = { id, name: pair.name, relay: pair.relay, secret: pair.secret, cloud: entry }
    const token = this._token()
    const follow = { auto: () => images === 'auto', ask: async (p, role) => !!(typeof onNewImage === 'function' && await onNewImage(p, role)), fetch: this._d.fetch }
    const save = (_c, patch) => { this._write(({ reg: r, cloud: cl }) => ({ reg: r, cloud: withCloud(cl, id, { ...cl.cloud[id], ...patch }) })).catch(() => {}) }
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
      await this._d.close(computer, { token, fetchImpl: this._d.fetch }).catch(() => false)
      throw fail('not_found', 'this cloud computer was removed while it opened')
    }
    const t = this._d.transport({ computer })
    const c = new Computer(this, computer, t)
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
export class Computer {
  constructor (owner, computer, transport) {
    this._owner = owner
    this._c = computer
    this._t = transport
    this._streams = new Map() // directory ('' = the server's default) → { stop, subs: Map(type → Set(fn)) }
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
      if (!this._dirs.size) { try { const l = await req('GET', '/experimental/session?archived=true'); if (Array.isArray(l)) l.forEach(learn) } catch { /* the default folder still answers */ } }
      return ['', ...new Set([...this._dirs.values()].filter(Boolean))]
    }
    const listEverywhere = async (path, opts) => {
      const one = await scopeOf(opts)
      if (one !== null) return (await req('GET', withDir(path, one))) || []
      const seen = new Map()
      for (const d of await allDirs()) { let l = []; try { l = (await req('GET', withDir(path, d))) || [] } catch (e) { if (!d) throw e /* another folder's failure costs only its list */ } for (const x of Array.isArray(l) ? l : []) { const k = x && (x.id || x.requestID); if (k && !seen.has(k)) seen.set(k, x) } }
      return [...seen.values()]
    }
    this.sessions = {
      list: async () => { const l = (await req('GET', '/experimental/session?archived=true')) || []; if (Array.isArray(l)) l.forEach(learn); return l },
      create: async ({ dir = '', title = '' } = {}) => learn(await req('POST', withDir('/session', dir), title ? { title: String(title).slice(0, 200) } : {})),
      messages: async (sid, { limit = 50 } = {}) => req('GET', await inDir(sid, `/session/${seg(sid, 'session')}/message?limit=${Math.max(1, Math.min(200, Number(limit) || 50))}`)),
      prompt: async (sid, text, { model = '', agent = '' } = {}) => {
        const mi = String(model || '').indexOf('/')
        const body = { parts: [{ type: 'text', text: String(text || '') }], ...(mi > 0 ? { model: { providerID: model.slice(0, mi), modelID: model.slice(mi + 1) } } : {}), ...(agent ? { agent: String(agent) } : {}) }
        return req('POST', await inDir(sid, `/session/${seg(sid, 'session')}/message`), body)
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
    this.approvals = {
      /** Every approval waiting, in every folder — or `{ session }` / `{ dir }` for one. */
      pending: async (opts = {}) => listEverywhere('/permission', opts),
      /** 'once' | 'always' | 'reject'; a reject may carry a message for the model ("stop and ask me"). */
      answer: async (id, response, { session = '', message = '' } = {}) => {
        if (!['once', 'always', 'reject'].includes(response)) throw fail('invalid_argument', "an approval is 'once', 'always' or 'reject'")
        if (response === 'reject' && message) {
          // A connector from before the reply route refuses it (403/404/405): then the bare refusal on the old route, as the app does (codeApprovals.js).
          // in the session's FOLDER (sync sweep 11-08: an approval in another folder than the default was never found)
          const replyPath = `/permission/${seg(id, 'approval')}/reply`
          try { return await req('POST', session ? await inDir(session, replyPath) : replyPath, { reply: 'reject', message: String(message).slice(0, 2000) }) } catch (e) { if (!session || ![403, 404, 405].includes(e.status)) throw e }
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
      get private () { const b = transport.browse ? transport.browse() : null; return !!(b && b.private) },
      /** → true when sent (the computer's next report confirms it). */
      setPrivate: (on) => {
        const b = this._t.browse ? this._t.browse() : null
        if (!b || !b.canPrivate || typeof this._t.setBrowsePrivate !== 'function') throw fail('not_supported', 'this computer\'s browser has no private mode')
        if (!this._t.setBrowsePrivate(!!on)) throw fail('offline', 'the computer is not connected')
        return true
      },
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
    let off = false, stream = null
    const attach = (d) => {
      if (off) return
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
    return () => { off = true; const s = stream && stream.subs.get(type); if (s) s.delete(fn) }
  }

  _stop () { for (const st of this._streams.values()) { try { if (st.stop) st.stop() } catch { /* */ } } this._streams.clear(); try { this._t.close() } catch { /* */ } if (this._owner._open.get(this.id) === this) this._owner._open.delete(this.id) } // only itself: never a newer opening of the same computer

  /** Close it: a last save, then the enclave stops (its hours stop counting). */
  async close () {
    this._stop()
    let token = ''; try { token = this._owner._token() } catch { return false }
    return this._owner._d.close(this._c, { token, fetchImpl: this._owner._d.fetch })
  }
}
