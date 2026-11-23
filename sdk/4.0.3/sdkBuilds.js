// sdkBuilds.js — `wb.builds`: WHICH ENCLAVE BUILD THIS PERSON ACCEPTS, in a builder's app (the owner's build-later list,
// 2026-10-28, item 3; "Sync the sdk", 2026-11-07). The Witbitz app seals a confidential room's key only to a build that is
// (1) published by Witbitz and (2) on the PERSON's own list of accepted builds (trustedBuilds.js; the owner, 2026-10-11:
// "Accept this build should be only from the user perspective. It is a per user choice."). The SDK sealed to any published
// build — the person had no say. Now a builder chooses:
//
//   new Witbitz({ builds: 'published' })  — as before: any build Witbitz publishes (the default; nothing changes)
//   new Witbitz({ builds: 'mine' })       — the person's own list, the app's rules:
//       · FIRST USE: an account that has accepted nothing accepts the first published build it meets;
//       · AUTOMATIC (on unless the person turns it off): every published build is accepted when met — still checked
//         against what Witbitz published, still attested;
//       · off: a new build BLOCKS the person's confidential rooms (`enclave_not_accepted`, with the verdict) until
//         `wb.builds.accept(room)`.
//     The list rides the account (a sealed `builds` document in this app's account index — every device of the account
//     sees an acceptance), and `state` / `onState` for a page without one. The pure rules are enclaveAccept.js's, the
//     app's own.
import { mergeTrusted, parseTrusted, trustBuild, userVerdict, gatedKey, publishedKey } from './enclaveAccept.js'
import { sealDoc, openDoc } from './accountSeal.js'
import { roomRegion, DEFAULT_REGION } from './regions.js'

export const BUILDS_DOC = 'builds' // the app's TRUSTED_DOC (trustedBuilds.js) — the same document name, sealed the same way
const fail = (code, message, extra = {}) => Object.assign(new Error('witbitz: ' + message), { code, ...extra })
const parseAuto = (a) => (a && typeof a === 'object' && typeof a.on === 'boolean' && Number.isFinite(+a.at) ? { on: a.on, at: +a.at } : null)
const stateOf = (s) => (s && typeof s === 'object' ? { builds: parseTrusted(s.builds), ...(parseAuto(s.auto) ? { auto: parseAuto(s.auto) } : {}) } : null)

export class Builds {
  /** @param {object} wb the Witbitz client  @param {object} o { mode: 'published' | 'mine', state? } */
  constructor (wb, { mode = 'published', state = null } = {}) {
    if (!['published', 'mine'].includes(mode)) throw fail('invalid_argument', "builds is 'published' or 'mine'")
    this._wb = wb
    this._mode = mode
    const s = stateOf(state)
    this._list = s ? s.builds : []
    this._auto = s && s.auto ? s.auto : null
    this._ready = !!s // a list this page was handed is known — for a page with NO account (_known: with one, its list is read first)
    this._accountRead = false // the account's own list has been read on this page (review 2026-11-07: until then nothing is "known")
    this._pending = new Map() // region → { attested, platform } met before the list was known
    this._syncing = null
    /** Called with the new state whenever it changes — persist it there (a page without an account). */
    this.onState = null
  }

  /** 'published' (any build Witbitz publishes) | 'mine' (the person's own list). */
  get mode () { return this._mode }
  /** JSON-safe state to persist: { builds, auto? }. */
  get state () { return { builds: this._list.map((e) => ({ ...e })), ...(this._auto ? { auto: { ...this._auto } } : {}) } }
  /** The builds this person accepted: [{ kernel, payload?, policy?, at }]. */
  list () { return this._list.map((e) => ({ ...e })) }
  /** Is "accept new Witbitz builds automatically" on? On unless the person turned it off. */
  get automatic () { return !this._auto || this._auto.on }

  /** Turn automatic acceptance on or off — for the account (every device). */
  async setAutomatic (on) {
    if (this._mode === 'mine' && !this._known()) await this.sync()
    this._auto = { on: !!on, at: Date.now() }
    this._changed()
    await this._push()
    return this.automatic
  }

  /** Does this person accept the enclave serving `room`? → { ok, reason?, live } — reason: no_attestation · kernel ·
   *  payload · policy (not published by Witbitz) · unknown (the list is not read yet) · not_accepted. null before the
   *  room's enclave has attested. In 'published' mode, any published build is ok. */
  verdict (room) {
    const k = this._live(room)
    if (!k) return null
    if (this._mode === 'published') { const v = userVerdict([], k.attested, k.platform); return v.reason === 'not_accepted' ? { ok: true, matched: v.live, live: v.live } : v } // published = accepted
    return userVerdict(this._known() ? this._list : undefined, k.attested, k.platform)
  }

  /** The person accepts the build serving `room` (its region's enclave). → the list. */
  async accept (room) {
    if (this._mode !== 'mine') throw fail('invalid_argument', "accepting a build is for new Witbitz({ builds: 'mine' })")
    if (!this._known()) await this.sync() // the account's list (and its automatic choice) first: never a partial list taken as whole
    const k = this._live(room)
    if (!k || !k.attested) throw fail('not_attested', 'that room\'s enclave has not attested yet — open the room first')
    const pub = userVerdict([], k.attested, k.platform)
    if (pub.reason !== 'not_accepted' && !pub.ok) throw fail('not_published', 'this build is not one Witbitz publishes — it cannot be accepted', { verdict: pub })
    this._list = trustBuild(this._list, k.attested)
    this._changed()
    await this._push()
    return this.list()
  }

  /** Read the account's list and fold it in (union; the newest automatic choice wins), writing back what it lacks. */
  async sync () {
    if (this._syncing) return this._syncing
    this._syncing = (async () => {
      const store = await this._store()
      if (!store) { this._ready = true; this._first(); return this.list() } // no account: this page's list is the only one (an account turned on later is read then: _known)
      const doc = await store.get()
      const remote = doc && typeof doc === 'object' ? doc : null
      const next = mergeTrusted(this._list, remote && remote.builds)
      const ra = parseAuto(remote && remote.auto)
      if (ra && (!this._auto || ra.at > this._auto.at)) this._auto = ra
      const lacks = next.length > parseTrusted(remote && remote.builds).length || (this._auto && (!ra || this._auto.at > ra.at))
      this._list = next; this._ready = true; this._accountRead = true
      this._changed()
      if (lacks) { try { await store.put(this.state) } catch { /* the next acceptance writes it */ } }
      this._first()
      return this.list()
    })().finally(() => { this._syncing = null })
    return this._syncing
  }

  // ── the SDK's own hooks ────────────────────────────────────────────────────────────────────────────────────────────
  /** @private the seal gate (Witbitz `mkPub`): the key iff this person accepts the live build; throws `enclave_not_accepted`. */
  _key ({ key, attested, platform, room }) {
    if (this._mode === 'published') return publishedKey({ key, attested, platform, room })
    const known = this._known()
    if (key && !known) this.sync().catch(() => {}) // the list is read in the background; this call says `unknown` meanwhile
    return gatedKey({ key, trusted: known ? this._list : undefined, attested, platform, room })
  }
  /** Is the person's list KNOWN here? With an account: only once ITS list was read on this page — a handed or local list may be
   *  partial, and first use / automatic must never be decided on one. Without an account: the list this page holds. */
  _known () { const acc = this._wb.account; return acc && acc.enabled ? this._accountRead : true }
  /** @private an enclave attested (Witbitz `_encAttest`): first use / automatic, the app's rule (trustedBuilds.autoAccept). */
  _attested (region, attested, platform) {
    if (this._mode !== 'mine' || !attested) return
    if (!this._known()) { this._pending.set(region, { attested, platform }); this.sync().catch(() => {}); return }
    this._auto1(attested, platform)
  }
  _first () { for (const [r, p] of this._pending) { this._pending.delete(r); this._auto1(p.attested, p.platform) } }
  _auto1 (attested, platform) {
    if (!this._known()) return false
    if (this._list.length && !this.automatic) return false
    const v = userVerdict([], attested, platform)
    if (v.reason !== 'not_accepted') return false // not published (or not attested): nothing is accepted for them
    if (userVerdict(this._list, attested, platform).ok) return false // already
    this._list = trustBuild(this._list, attested); this._changed(); this._push().catch(() => {})
    return true
  }
  _live (room) {
    const enc = this._wb._enc
    if (!enc) return null
    const reg = roomRegion(room)
    return enc.byRegion.get(reg) || (reg === DEFAULT_REGION && enc.attested ? { attested: enc.attested, platform: enc.platform } : null)
  }
  async _store () {
    const acc = this._wb.account
    if (!acc || !acc.enabled || typeof acc._where !== 'function') return null
    const loc = await acc._where(), c = acc._client()
    let v = null // the version get() read: put() lands only over it (another device's write in between → 409 → read and merge again)
    return {
      get: async () => {
        const r = await c.state(loc.room, loc.mk, BUILDS_DOC)
        if (!r || r.status !== 200) throw fail('unreadable', 'the account could not be read just now', { status: r && r.status })
        v = Number.isInteger(r.v) ? r.v : null
        const st = r.state
        return st == null || (typeof st === 'object' && !Object.keys(st).length) ? null : openDoc(loc.key, st)
      },
      put: async (doc) => {
        const w = await c.state(loc.room, loc.mk, BUILDS_DOC, await sealDoc(loc.key, { ...doc, at: Date.now() }), BUILDS_DOC, 'device', v ?? undefined)
        if (w && w.status === 409) throw fail('moved', 'another device changed the account just now')
        if (!w || w.status !== 200) throw fail('save_failed', 'the account could not be saved just now', { status: w && w.status })
      },
    }
  }
  async _push () {
    const store = await this._store().catch(() => null)
    if (!store) return
    // read, merge, write ONLY over what was read — another device's write in between is read and merged again, never written
    // over (sync sweep 11-08 #32; the app's accountStores ifV)
    for (let i = 0; ; i++) {
      const remote = await store.get() // a read that fails ABORTS the write: a whole-doc put over an unread copy would drop other devices' acceptances (review 2026-11-07)
      const merged = mergeTrusted(this._list, remote && remote.builds)
      const ra = parseAuto(remote && remote.auto)
      if (ra && (!this._auto || ra.at > this._auto.at)) this._auto = ra
      this._list = merged
      try { await store.put(this.state); return } catch (e) { if (!(e && e.code === 'moved') || i >= 4) throw e }
    }
  }
  _changed () { if (typeof this.onState === 'function') { try { this.onState(this.state) } catch { /* the app's callback must not break the gate */ } } }
}
