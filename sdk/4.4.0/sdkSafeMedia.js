// sdkSafeMedia.js — `space.safeMedia`: SAFE MEDIA from a builder's page (docs/safe-media.md; the owner, 2026-10-27: "Do 1+2").
// The same engine as the Spaces app (safeMedia.js makeSafe / verifySafe, safeMediaRoom.js): in a room with `safeMedia: true`,
// a photo or a PDF is made safe ONCE — sent, sealed to the tools enclave's ATTESTED key, through the Space server (which sees
// ciphertext only), and given back as JPEGs our enclave encoded from pixels a keyless one-shot parser produced, with the
// hardware's attestation over exactly those bytes. The copies are stored beside the original (op 'safe', a hidden entry
// `{ kind: 'safe', safeFor: { id, at, i }, safe }`), and a reader draws one only after checking that attestation itself.
//
//   space.safeMedia.on                         → true | false | null (not known yet: call refresh())
//   await space.safeMedia.refresh()            → boolean, from the room's sealed settings
//   await space.safeMedia.set(on, { from })    → { changed } — the admins' where the room names some, any member's otherwise
//   await space.safeMedia.copy(message, ref)   → { ok, versions: [{ w, h, b64 }], statement, att } | { ok: false, why } — VERIFIED here, or ok:false
//   await space.safeMedia.make(message, ref)   → { ok, error? } — make the copy for everyone (needs a signed-in session)
//   await space.safeMedia.isOriginal(copy, b64) → boolean — the original is the file the copy was made from
//   events on the Space: 'safeMedia' { on, from, ts } (the setting moved) · 'safeCopy' { for: { id, at, i } } (a copy arrived)
//
// `ref` = { at: 'images' | 'files', i } — which attachment of the message (default: its first image, else its first file).
// While the setting is on, send() makes the copies of what it sends by itself, as the app does (best effort: signed out,
// offline or too large, the message goes anyway and anyone may make() it later).

import { makeSafe, verifySafe, isTheOriginal, firstVerifiedCopy, safeMediaReady, SAFE_MAX_INPUT } from './safeMedia.js'

const fail = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })
const stdB64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s) }
const fromB64 = (s) => Uint8Array.from(atob(String(s || '').replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0))
const isPdf = (a) => !!a && (a.mime === 'application/pdf' || /\.pdf$/i.test(a.name || ''))
export const isImg = (a) => !!a && (a.kind === 'image' || /^image\//i.test(String(a.mime || ''))) // = media.js isImageAtt, COPIED: media.js loads the app's idb and key worker, which the SDK must not (isImgCopy.test holds them equal) — a photo sent as a file is a photo
const slotKey = (f) => `${f.id}|${f.at}|${f.i}`
// the assistant's photos (_autoAgent): the app's numbers, COPIED — messageRender.js and safeMediaRoom.js load the app's shell
// (sdkAppParityMore.test holds them equal)
export const AUTO_SAFE_MS = 30 * 60_000 // a photo younger than this gets its copy made by the first device that draws it
export const AUTO_SAFE_WAIT_MS = 2500 // …after this wait, for a copy another device may be making
/** What send() matches its own stored message by — the app's echo signature (space.js echoSig). */
export const sigOf = (m) => `${String((m && m.text) || '').trim()}|${((m && m.images) || []).length}|${((m && m.files) || []).length}`

export class SpaceSafeMedia {
  /** @param {object} space the Space; @param {object} [deps] injectable engine (tests): { makeSafe, verifySafe, pins, root, now } */
  constructor (space, deps = {}) {
    this._s = space
    this._d = { makeSafe, verifySafe, pins: undefined, root: undefined, ...deps }
    this._on = null; this._at = -1 // what is known, as of `_at` (a settings read: now; a line: its ts) — an older word never wins
    this._copies = new Map() // slotKey → [copy entries], oldest first
    this._sent = [] // { sig, made: [{ at, i, p }] } — copies being made for messages this handle sent, waiting for their ids
    this._autoTried = new Set() // the assistant's photos this handle has made (or tried to make) a copy of — once each
  }

  /** The setting as this handle knows it: true / false, or null before the room's settings or a line said. A private lane
   *  follows its Space's (sync sweep 2026-10-27 #1: the mirror copies the Space's photos into the lane, and there they were
   *  read as plain attachments) — draw a lane's photos through copy() as the Space's. */
  get on () {
    // a lane's OWN value is ignored: before 2026-10-30 a lane could be turned on alone, and nothing can turn that off now — it
    // stayed on after its Space turned it off (sync sweep 2026-10-31 #3)
    if (this._isLane()) { const sh = this._lane(); return sh && sh.safeMedia ? sh.safeMedia.on : null } // without its Space's handle: not known here
    return this._on
  }
  /** @private the Space this handle's lane follows, or null for a Space (or a lane opened without its Space's handle) */
  _lane () { const sh = this._s && this._s._sharedSpace; return sh && sh !== this._s ? sh : null }
  /** @private IS this handle a private lane? ONE check (sync sweep P7: `configure` asked `_sharedRoom`, this file `_sharedSpace`, and
   *  a Lane built without its Space's handle — the app's and the vault's — read as a Space here: its own value, `set` allowed). */
  _isLane () { return !!(this._s && this._s._sharedRoom) }
  /** Is there an accepted safe-media build in this release at all? (safeMediaPins.js) — false: nothing verifies yet. */
  get available () { return safeMediaReady(this._d.pins) }

  /** @private learn the setting as of `at`; tells listeners when it moved. */
  _learn (on, at, from = '') {
    if (at < this._at) return
    const was = this._on
    this._on = !!on; this._at = at
    // a LANE's own value is kept but never said: the lane follows its Space, and relays the Space's moves (sweep 11-07 #12)
    if (was !== this._on && was !== null && !this._isLane()) this._s._emit('safeMedia', { on: this._on, from, ts: at })
  }

  /** Read the room's sealed settings → boolean. */
  async refresh () {
    const sh = this._lane()
    if (sh && sh.safeMedia) return sh.safeMedia.refresh() // a lane follows its Space: read the Space's
    if (this._isLane()) throw fail('lane_follows_space', 'a private lane follows its Space’s Safe media — read it on the Space (open the lane with its Space)')
    const c = this._s._client
    if (!c || typeof c.getConfig !== 'function') throw fail('unavailable', 'this Space cannot read its settings here')
    let cfg = await c.getConfig(this._s.room, this._s._mk)
    // a SLEEPING confidential Space reads nothing: wake it and read once more, as the vault does (sweep P2: a lane's refresh,
    // which reads its Space's, failed until something else woke it)
    const wb = this._s._wb
    if (!cfg && !c.keyless && !c.vault && wb && typeof wb._encWake === 'function' && typeof this._s._isEnclave === 'function' && this._s._isEnclave()) {
      try { await wb._encWake(this._s.room, { tries: 8 }); cfg = await c.getConfig(this._s.room, this._s._mk) } catch { /* said below */ }
    }
    // "sign in" only where it is the reason — a gated room's settings before sign-in; a sleeping enclave or a failed read is not
    // (sweep 11-07 #8: a vault, signed in, was told to sign in)
    if (!cfg || typeof cfg !== 'object') throw fail('config_unavailable', 'the room’s settings could not be read just now — try again')
    if (cfg.gated === true && !cfg.allow) throw fail('config_unavailable', 'the room’s settings could not be read (sign in to a verified Space first)')
    this._learn(cfg.safeMedia === true, Date.now())
    return this.on === true // a private lane follows its Space (sync sweep 2026-10-29 #7: refresh() answered false while `on` was true)
  }

  /** Turn Safe media on or off for everyone — a line every member sees says who did. */
  async set (on, { from } = {}) {
    if (typeof on !== 'boolean') throw fail('invalid_argument', 'safeMedia.set takes true or false')
    // A private lane follows its Space: its own setting could turn it on for the lane alone and never off (sync sweep
    // 2026-10-30 #4) — the Space's admins set it, for everyone, on the Space.
    if (this._isLane()) throw fail('lane_follows_space', 'a private lane follows its Space’s Safe media — set it on the Space')
    if (on && !this.available) throw fail('safe_media_unavailable', 'no safe-media enclave is accepted in this release yet')
    return this._s.configure({ safeMedia: on, ...(from ? { from } : {}) })
  }

  /** @private one ledger entry, from the poll: a copy (kept, never a message) or the line that moved the setting. → true if consumed. */
  _note (e) {
    if (!e || typeof e !== 'object') return false
    if (e.kind === 'safe') {
      if (!e.safeFor || !e.safe) return true
      const k = slotKey(e.safeFor), list = this._copies.get(k) || []
      if (!list.some((x) => x.id === e.id)) { this._copies.set(k, [...list, e]); this._s._emit('safeCopy', { for: { id: e.safeFor.id, at: e.safeFor.at, i: e.safeFor.i } }) }
      return true
    }
    if (e.sys && e.safeMedia && typeof e.safeMedia === 'object') this._learn(e.safeMedia.on === true, Number(e.ts) || 0, e.name || e.from || '')
    return false
  }

  /** @private which attachment of a message → { at, i, att, kind } */
  _slot (message, ref) {
    if (!message || typeof message !== 'object' || message.id == null) throw fail('invalid_argument', 'safeMedia takes a stored message (from "message" or space.messages)')
    let at = ref && ref.at, i = ref && Number.isInteger(ref.i) ? ref.i : 0
    if (!at) at = Array.isArray(message.images) && message.images.length ? 'images' : 'files'
    if (at !== 'images' && at !== 'files') throw fail('invalid_argument', "ref.at is 'images' or 'files'")
    const att = Array.isArray(message[at]) ? message[at][i] : null
    if (!att) throw fail('invalid_argument', `the message has no ${at}[${i}]`)
    if (at === 'files' && !isPdf(att) && !isImg(att)) throw fail('invalid_argument', 'only photos and PDFs have safe copies')
    return { at, i, att, kind: at === 'images' || isImg(att) ? 'image' : 'pdf' }
  }

  /** The first copy of that attachment that VERIFIES on this device, every version checked → { ok, versions, statement, att } | { ok: false, why }. */
  async copy (message, ref) {
    const s = this._slot(message, ref)
    const list = (this._copies.get(slotKey({ id: message.id, at: s.at, i: s.i })) || []).map((c) => ({ c, via: this._s }))
    // a private lane's MIRRORED entry (`sh:<the Space's id>`) is drawn from its Space's copies — the same bytes; the original
    // check below still holds (sync sweep: the Space's verified copies were never seen in the lane). Its COPIES are the Space's
    // stored blobs, read through the SPACE's handle — the lane's room has none (sync sweep 11-08 #13); its ORIGINAL is the
    // lane's own: the mirror stored the photo's bytes again in the lane, so the entry's ref is under the lane's key (sync
    // sweep 11-09: read through the Space, it was a 404)
    const m = /^sh:(.+)$/.exec(String(message.id || '')), sh = this._lane()
    const shared = !!(m && sh && sh.safeMedia)
    if (shared) list.push(...(sh.safeMedia._copies.get(slotKey({ id: m[1], at: s.at, i: s.i })) || []).map((c) => ({ c, via: sh.safeMedia._s })))
    if (!list.length) return { ok: false, why: 'no safe copy yet' }
    const origVia = this._s // the entry's own room holds its original — the lane's, for a mirrored one
    // every version fetched and checked; the loop, the verify and the "made from THIS file" check are safeMedia.js firstVerifiedCopy,
    // the app's too (sync sweep 2026-10-29 #1: a copy must be OF this file)
    const r = await firstVerifiedCopy(list, {
      fetch: async ({ via }, vs) => ({ bytes: await Promise.all(vs.map(async (v) => fromB64((await via.attachment({ ...v, mime: 'image/jpeg' })).b64))) }),
      verify: (safe, bytes) => this._d.verifySafe(safe, bytes, { pins: this._d.pins, root: this._d.root }),
      original: async () => fromB64((await origVia.attachment(s.att)).b64),
    })
    if (!r.ok) return r
    const c = r.cand.c, vs = c.safe.versions
    return { ok: true, versions: vs.map((x, k) => ({ w: x.w, h: x.h, b64: stdB64(r.bytes[k]) })), statement: c.safe.statement, att: c.safe.att }
  }

  /** Does `b64` (the original's bytes, from space.attachment) hash to what `copy` was made from? Check before opening it. */
  async isOriginal (copy, b64) {
    let st; try { st = JSON.parse(copy && copy.statement) } catch { return false }
    return isTheOriginal(st, fromB64(b64))
  }

  /** @private the sign-in a make needs, or a clear error */
  _idToken () {
    const wb = this._s._wb
    if (!wb || typeof wb._auth !== 'function') throw fail('sign_in_required', 'sign in first — making a file safe is counted to an account')
    return wb._auth('making a file safe is counted').idToken
  }

  /** @private bytes → the enclave → a verified result (throws with a reason) */
  async _made (bytes, kind, mime, idToken) {
    if (!bytes.length || bytes.length > SAFE_MAX_INPUT) throw fail('too_large', 'this file is too large to make safe')
    return this._d.makeSafe({ bytes, kind, mime }, { client: this._s._client, idToken, pins: this._d.pins, root: this._d.root, ...(this._d.now ? { now: this._d.now } : {}) })
  }

  /** @private post one made copy beside its original */
  async _post (ref, made, from) {
    const safe = { for: { id: ref.id, at: ref.at, i: ref.i }, statement: made.statement, att: made.att, versions: made.versions.map((v) => ({ w: v.w, h: v.h, b64: stdB64(v.bytes) })) }
    // A sleeping confidential Space answers 'warming' (a copy wakes nothing), and one whose enclave key is not known yet throws
    // before sending: wake it, then post once more — as the app does (sync sweep 2026-10-29 #6).
    const post = () => Promise.resolve().then(() => this._s._client.safeCopy(this._s.room, this._s._mk, safe, from || this._s._who()))
      .catch((e) => (/enclave key unavailable/.test(String((e && e.message) || e)) ? { status: 503, error: 'enclave_warming' } : Promise.reject(e)))
    let r = await post()
    const wb = this._s._wb
    if (r && (r.status === 503 || r.error === 'enclave_warming') && wb && typeof wb._encWake === 'function' && typeof this._s._isEnclave === 'function' && this._s._isEnclave()) {
      try { await wb._encWake(this._s.room, { tries: 8 }); r = await post() } catch { /* the enclave did not come up: say the first answer */ }
    }
    if (!r || r.status !== 200) return { ok: false, error: String((r && (r.reason || r.error)) || 'the room did not take it') }
    this._s._kick()
    return { ok: true }
  }

  /** Make the safe copy of an attachment already in the room, for everyone. Never throws for a refusal: { ok, error? }. */
  async make (message, ref, { from } = {}) {
    this._s._needKey('safe media')
    const s = this._slot(message, ref)
    if (!this.available) return { ok: false, error: 'safe_media_unavailable' }
    const idToken = this._idToken()
    try {
      const got = await this._s.attachment(s.att)
      const made = await this._made(fromB64(got.b64), s.kind, s.att.mime || got.mime || '', idToken)
      return await this._post({ id: message.id, at: s.at, i: s.i }, made, from)
    } catch (e) { return { ok: false, error: String((e && (e.code === 'too_large' ? 'too_large' : e.message)) || e) } }
  }

  /** @private at send: start making the copies of a message's photos and PDFs (only while the setting is on, signed in). */
  async _prepare (msg) {
    if (!(msg.images || []).length && !(msg.files || []).some((a) => isPdf(a) || isImg(a))) return
    if (this.on === false || !this.available) return // `on`, not `_on`: a lane follows its Space (sync sweep 2026-10-29 #7)
    const c = this._s._client
    if (!c || c.keyless || typeof c.safeCopy !== 'function') return
    if (this.on === null) { try { await this.refresh() } catch { return } } // once per handle: the first photo sent asks the room
    if (this.on !== true) return
    let idToken; try { idToken = this._idToken() } catch { return } // signed out: the message goes, anyone may make() later
    const made = []
    const start = (at, i, a, kind) => {
      if (!a || typeof a.b64 !== 'string') return
      let bytes; try { bytes = fromB64(a.b64) } catch { return }
      made.push({ at, i, p: this._made(bytes, kind, a.mime || '', idToken).catch(() => null) })
    }
    ;(msg.images || []).forEach((a, i) => start('images', i, a, 'image'))
    ;(msg.files || []).forEach((a, i) => { if (isPdf(a)) start('files', i, a, 'pdf'); else if (isImg(a)) start('files', i, a, 'image') })
    if (made.length) this._sent.push({ sig: sigOf(msg), made, at: Date.now() })
  }

  /** @private THE ASSISTANT'S PHOTOS TOO (the app's messageRender.js autoSafe + safeMediaRoom.js `auto`; docs/safe-media.md § 11;
   *  sync sweep 2026-11-13): show_photo and fetch_url put pictures from web pages into its replies, and no device sent them, so
   *  nobody made their copy at send. A RECENT one with no copy after a short wait (another member's device may be making it) is
   *  made here — the bytes go to the tools enclave, nothing is decoded on this device. Once per photo per handle; signed out, a
   *  keyless client (a vault) or a failure: it waits for make(), as before. Its PDFs are left alone (write_pdf's are our own). */
  _autoAgent (m) {
    if (this.on !== true || !this.available || /^sh:/.test(String(m.id))) return // a lane's copy of its Space's line: the Space's handle makes it
    const c = this._s._client
    if (!c || c.keyless || typeof c.safeCopy !== 'function' || !(Number(m.ts) > Date.now() - AUTO_SAFE_MS)) return
    const todo = (Array.isArray(m.images) ? m.images : []).map((_a, i) => i).filter((i) => !this._autoTried.has(slotKey({ id: m.id, at: 'images', i })))
    if (!todo.length) return
    for (const i of todo) this._autoTried.add(slotKey({ id: m.id, at: 'images', i }))
    const t = setTimeout(async () => {
      for (const i of todo) {
        if ((this._copies.get(slotKey({ id: m.id, at: 'images', i })) || []).length || this._s._stopped) continue // a copy came meanwhile
        try { await this.make(m, { at: 'images', i }) } catch { /* signed out: Make safe stays the way */ }
      }
    }, this._d.autoWaitMs ?? AUTO_SAFE_WAIT_MS)
    try { t.unref?.() } catch { /* a browser timer */ }
  }

  /** @private a stored message arrived: if this handle sent it, its copies go beside it; the assistant's recent photos get theirs. */
  _arrived (m) {
    if (m && m.self && !m.sys && m.id != null) { this._autoAgent(m); return }
    if (!this._sent.length || !m || m.self || m.sys || m.id == null) return
    this._sent = this._sent.filter((x) => Date.now() - x.at < 10 * 60_000) // a message the room never gave back is let go
    const k = this._sent.findIndex((x) => x.sig === sigOf(m))
    if (k < 0) return
    const [x] = this._sent.splice(k, 1)
    ;(async () => { for (const y of x.made) { const made = await y.p; if (made) await this._post({ id: m.id, at: y.at, i: y.i }, made).catch(() => null) } })()
  }
}
