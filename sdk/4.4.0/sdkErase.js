// sdkErase.js — `wb.erasure`: A BUILDER'S USERS' ROOMS CAN BE DELETED WHEN THE USER IS ERASED (https://witbitz.chat/docs/sdk-builder.md#user-erasure; a
// builder, 2026-10-07: "users.erase finds 0 rooms for a user of ours"). The tenant's erase (`wb.users.erase(email)` on its
// server → agent/eraseUser.mjs) runs ONLY the list the account FILED with the attested standing Sentinel, and deletes only
// a room whose create carried a deletion commitment and that nobody else marked. The Witbitz app does all three
// (roomDelete.js, accountUsage.js, eraseFile.js); the SDK did none. Now, for every room the SDK creates or opens:
//   1. a CREATE carries delCommit = sha256(HMAC(erase key, 'witbitz-room-delete:' + room)) — only this account can later
//      prove it created the room (the server keeps the commitment, never the secret);
//   2. the room gets this account's MEMBERSHIP MARK (HMAC(erase key, 'witbitz-usage-drop:' + room)) — so another account's
//      delete of a room this account used is refused (409 shared), and this account's own delete is not;
//   3. the account's list — per room, the delete secret and the drop — is FILED, sealed to the standing Sentinel, under
//      the app's tenant and the signed-in email (eraseFile.js, unchanged). Automatic, a few seconds after a room is
//      created or opened, and only when the list changed; `wb.erasure.file()` does it on demand.
// THE ERASE KEY comes from the BACKUP MASTER (wb.backup), which every device of the account restores: the Sentinel keeps one
// list per account and a filing REPLACES it, so every device must derive the same secrets. No backup → no shared secret →
// nothing is committed, marked or filed (a room created then can be deleted only by the tenant: wb.rooms.delete(room)).
// The mark works on rooms created before this, the commitment does not (it is set at create, never after).
import { delSecretFor, delCommitOf } from './roomDelete.js'
import { dropFor } from './usageReceipts.js'
import { fileEraseList } from './eraseFile.js'
import { attestStandingSentinel } from './connections.js'
import { sealTo as sealToEnclave } from './sealShare.js'
import { eraseAccount, stepDone, readAllEntries } from './accountErase.js' // the app's Delete my account — its order and rules, and its one rule for "done"
import { deleteOwnRoom, leaveAndMaybeDelete, leaveHandover, deleteHandedOver } from './roomDelete.js'
import { inviteScope } from './sdkRekey.js'

const enc = new TextEncoder()
const ub64 = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
const b64u = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const TENANT = /^t_[0-9a-f]{32}$/ // the Sentinel's (erase.mjs)
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) } } }

/** The erase key every device of the account derives from its backup master: { secret } (43-char base64url). */
export async function eraseKeyOf (masterB64) {
  const km = await crypto.subtle.importKey('raw', ub64(masterB64), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('witbitz-sdk-account-v1'), info: enc.encode('erase-key') }, km, 256)
  return { secret: b64u(new Uint8Array(bits)) }
}

export class Erasure {
  /** @param {object} wb the Witbitz client */
  constructor (wb) {
    this._wb = wb
    this._k = { master: null, key: null }
    this._marked = new Set()
    this._opened = [] // rooms this page created or opened, newest last
    this._debounceMs = 4000
    this._timer = null
    this._deps = null // tests: { post, auth, attest, seal }
    let ls = null; try { ls = globalThis.localStorage || null; if (ls) ls.getItem('witbitz:probe') } catch { ls = null }
    this._ls = ls || memStorage() // where eraseFile.js remembers what it filed (skips an unchanged list for 6 h)
  }

  async _key () {
    const st = this._wb.backup && this._wb.backup.state
    const m = st && st.master
    if (!m) return null
    if (this._k.master !== m) this._k = { master: m, key: await eraseKeyOf(m) }
    return this._k.key
  }
  /** @private the account's USAGE keys (wb.account): its turns' receipts carry drops made with them, so a delete and the
   *  filed list present those too — else the server reads this account's own receipts as another's (409 shared; sync sweep 11-08 #3) */
  _dropKeys () { try { const a = this._wb.account; return a && typeof a._usageKeys === 'function' ? a._usageKeys() : [] } catch { return [] } }
  _account () { const s = this._wb._session; return s && s.email && !(s.exp && s.exp <= Date.now()) ? String(s.email).toLowerCase() : '' }
  _tenant () { return TENANT.test(this._wb._tenant || '') ? this._wb._tenant : '' }

  /** True when this page can file: a tenant app, a live sign-in and a backup (the shared key). */
  get available () { return !!(this._tenant() && this._account() && this._wb.backup && this._wb.backup.enabled) }

  /** @private the create hook (spaceClient `delCommit`): the commitment for `room`, or null with no backup */
  async _commitFor (room) { const k = await this._key(); return k ? delCommitOf(await delSecretFor(k, room)) : null }

  /** @private every room the SDK hands back (Witbitz#_backedUp): mark it once per page, and refile soon. Never throws. */
  _seen (sp) {
    if (!sp || !sp.room) return
    if (!this._opened.includes(sp.room)) this._opened.push(sp.room)
    ;(async () => {
      const k = await this._key()
      if (!k || this._marked.has(sp.room) || !sp._mk) return
      this._marked.add(sp.room)
      // A refusal is ANSWERED, not thrown (mark is email-gated: a sign-in may be needed) — so it is let go too, and the room
      // is marked again the next time it is handed back, as the app's accountUsage does (sync sweep, 2026-10-10).
      try { const r = await this._wb._client.mark(sp.room, sp._mk, await dropFor(k, sp.room)); if (!r || r.status !== 200) this._marked.delete(sp.room) } catch { this._marked.delete(sp.room) }
    })().catch(() => {})
    if (this.available) {
      clearTimeout(this._timer)
      this._timer = setTimeout(() => { this.file().catch(() => {}) }, this._debounceMs)
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref()
    }
  }

  _rooms () {
    const st = this._wb.backup && this._wb.backup.state
    const kept = (st && Array.isArray(st.rooms) ? st.rooms : []).slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map((r) => r.room)
    return [...new Set([...this._opened.slice().reverse(), ...kept])] // newest first: the Sentinel keeps what fits
  }
  _d () {
    if (this._deps) return this._deps
    const wb = this._wb
    return { post: wb._sentinelPost(), auth: wb._auth('the erase list belongs'), attest: (o) => attestStandingSentinel({ ...o, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow }), seal: sealToEnclave }
  }

  /** File this account's delete list with the standing Sentinel, for this app's tenant, so `wb.users.erase(email)` on the
   *  tenant's server can delete the rooms this account created. Automatic after a room is created or opened; call it after
   *  a sign-in or a backup restore to file at once. → `{ filed, rooms?, skipped? }`
   *  @param {object} [opts] { force? } — refile even when the list is unchanged */
  async file ({ force = false } = {}) {
    if (!this._tenant()) return { filed: false, skipped: 'not a tenant app: new Witbitz({ tenant })' }
    if (!this._account()) return { filed: false, skipped: 'signed out: ' + (this._wb && this._wb.vault ? 'wb.vault.signIn' : 'wb.signIn') + ' first' }
    const key = await this._key()
    if (!key) return { filed: false, skipped: 'no backup: enable wb.backup so every device of the account shares the erase key' }
    const d = this._d()
    const backup = this._wb.backup
    const stillOurs = backup && typeof backup._checkErased === 'function' ? async () => !(await backup._checkErased()) : null // pass 7, F#10
    return fileEraseList({ tenant: this._tenant(), account: this._account(), rooms: this._rooms(), keys: [key], dropKeys: this._dropKeys(), post: d.post, auth: d.auth, attest: d.attest, seal: d.seal, ls: this._ls, force, stillOurs })
  }

  /** DELETE MY ACCOUNT — the Witbitz app's Settings → Delete my account (accountErase.js), for a builder's user (the owner's
   *  build-later list, 2026-10-28; "Sync the sdk", 2026-11-07). In this order, every step safe to run again:
   *   0. the backup FIRST (its email gate is the step that can refuse — nothing else is deleted until it is through);
   *   1. every room of the account (the backup's list and the rooms this page opened): one ONLY this account used is DELETED
   *      — the server checks this account's creation secret; a room someone else used is LEFT (what they wrote with you
   *      stays theirs too); an older room with no creation secret lapses when idle;
   *   2. the username (a sign-in made in your app has none — nothing to release) and the directory entry; the app's filed
   *      erase list is withdrawn;
   *   3. the account's index LAST, only when every step before it worked; then this client forgets the account
   *      (wb.backup.onState(null), signed out).
   *  Needs a live sign-in (for 2) and the backup (its key proves which rooms this account created). Billing: a builder's
   *  user is the APP's user — your server erases it (`wb.users.erase(email)` with the admin key).
   *  → { deleted:[room], left:[room], lapsing:[room], failed:[{room|what, why}], account:{ username, directory, backup } }
   *  `failed` not empty: nothing was forgotten here — fix the cause (often a sign-in) and call it again.
   *  @param {object} [opts] { onStep?(text) — progress lines to show; names? — the display names this person posts under in
   *    your app (`send(text, { from })`): a room whose every message is theirs (by email, or by one of these names) counts as
   *    only theirs. Without them a room with a named message is LEFT, never deleted unchecked (the server also refuses a
   *    room another account marked); code, ticket, emailCode — a backup set up with an email (wb.backup.gated) is deleted
   *    only with its emailed code, as a restore: the first call (with the recovery `code`) mails it and throws
   *    `email_code_required` with a `ticket` BEFORE anything is deleted; call again with { code, ticket, emailCode };
   *    getCode(address) → the emailed code — an account on the Witbitz account service is deleted there with it (as
   *    wb.backup.deleteAccount), as the run's backup step. In a vault the vault runs all of this itself, with its own screens. } */
  async deleteAccount ({ onStep, names = [], code, ticket, emailCode, getCode } = {}) {
    const wb = this._wb
    // IN A VAULT the vault holds the keys and runs the whole erase itself, asking the person on its own screens (vault-core.js
    // backup.deleteAccount; the owner, 2026-11-24) — it answers with the same report
    if (wb.vault) { const r = await wb.backup.deleteAccount({ names }); return (r && r.report) || r }
    const sess = wb._session
    if (!sess || !sess.idToken || (sess.exp && sess.exp <= Date.now())) throw Object.assign(new Error('witbitz: sign in first — deleting the account needs a live sign-in'), { code: 'sign_in_required' })
    const backup = wb.backup
    const key = await this._key()
    if (!key) throw Object.assign(new Error('witbitz: deleting the account needs its backup (wb.backup) — its key proves which rooms this account created'), { code: 'no_backup' })
    // the backup's email gate FIRST: nothing is deleted until the release is in hand (sync sweep 11-08 #1). Asked only while the
    // server still holds a gated backup — a re-run after the backup went (its gate with it) needs no new emailed code; and the
    // backup is the run's FIRST step (accountErase.js), so the 120 s release is spent seconds after it was made, however many
    // rooms follow (sync sweep 11-09 #15).
    let token = null, gone = null
    // AN ACCOUNT ON THE WITBITZ ACCOUNT SERVICE (sync sweep 2026-11-23 follow-up): its backup is the account there — deleted with an
    // emailed code, as the run's backup step. The old store answered "on the account service" and every such run stopped at step 1.
    const onService = !!(backup._s && backup._s.v2 && backup._v2)
    if (onService && !backup._s.erased && typeof getCode !== 'function' && !(this._deleteDeps && this._deleteDeps.deleteBackup)) throw Object.assign(new Error('witbitz: this account is on the Witbitz account service — pass getCode(address) for the emailed code'), { code: 'invalid_argument' })
    if (!onService && backup.gated && !(this._deleteDeps && this._deleteDeps.deleteBackup)) {
      const probe = await backup._deleteRemote(null)
      if (probe.ok || probe.status !== 403) gone = probe // already gone / not enforced (deleted now), or why it could not be asked
      else token = await backup._release({ code, ticket, emailCode })
    }
    const dropKeys = this._dropKeys()
    const st = backup.state || {}
    const kept = Array.isArray(st.rooms) ? st.rooms : []
    // a room's key: the whole key kept for a split room, else the link's own (a plain room's link IS its key — sync sweep 11-08
    // #2: only split rooms had one here, so every plain Space read as shared and was left)
    const keysBefore = new Map(kept.map((r) => [r.room, backup.keyFor(r.room)])) // read now: the service's erase may end the backup's state
    const keyOf = async (room) => {
      const kk = keysBefore.get(room) || backup.keyFor(room); if (kk) return kk
      const r = kept.find((x) => x.room === room)
      if (!r || !r.link || /[#&]us=/.test(r.link)) return null
      try { const o = await wb._client.open(r.link); return o && o.room === room ? o.mk : null } catch { return null }
    }
    const isTemp = (r) => String(r).startsWith('tmp-')
    let indexRoom = null
    try { if (wb.account && wb.account.enabled && typeof wb.account._where === 'function') indexRoom = (await wb.account._where()).room } catch { indexRoom = null }
    const d = this._deleteDeps || {}
    const client = wb._client
    const temporaryScope = wb.temporaryRooms?._scope()
    const rep = await eraseAccount({
      me: { email: this._account(), names: (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 20) },
      indexRoom,
      rooms: {
        all: [...new Set([...kept.filter((r) => r.kind !== 'lane').map((r) => r.room), ...this._opened])].filter((r) => r && !isTemp(r)),
        account: kept.filter((r) => r.kind === 'lane').map((r) => r.room), // a lane is the account's own: deleted without a read
      },
      read: d.read || (async (room) => {
        const mk = await keyOf(room)
        if (!mk) return null // a room this client cannot open is treated as shared: never deleted unchecked
        const entries = await readAllEntries((since) => client.poll(room, mk, undefined, since)) // every page, not the first (sync sweep 2026-11-09)
        if (!entries) return null
        let config = null; try { config = await client.getConfig(room, mk) } catch { config = null }
        return { entries, config }
      }),
      deleteRoom: d.deleteRoom || ((room) => deleteOwnRoom(room, { url: wb._roomDeleteEndpoint(), keys: [key], dropKeys, fetchImpl: (...a) => wb._fetch(...a) })),
      // a queued delete is CONFIRMED (this secret's tombstone is down) before the account key goes — asked, never re-queued (state machines pass 9, S#1)
      confirmDeleted: d.confirmDeleted || (d.deleteRoom ? undefined : ((room) => deleteOwnRoom(room, { url: wb._roomDeleteEndpoint(), keys: [key], dropKeys, fetchImpl: (...a) => wb._fetch(...a), check: true }))),
      // a VERIFIED room: hand over this account's marks and delete secrets as it leaves; the last one out deletes it (agent/roomLeave.mjs).
      // What they wrote stays part of the room while anyone who joined is still in it.
      // WHAT THE ACCOUNT KEEPS OUTSIDE ITS ROOMS, as the app's Delete my account takes it (accountEraseUi.js eraseCleanups; sync sweep
      // 2026-11-18 #2: the SDK passed none, and the builder docs promised the app's behaviour) — from this SDK's own handles.
      cleanups: d.cleanups || sdkEraseCleanups(wb),
      // …and the account's OTHER devices: each is signed out through the index before it goes (the app's signOutOthersForErase);
      // one offline meanwhile clears itself on the index's 410s (sdkAccount.js / devices.js indexGoneVerdict).
      signOutOthers: d.signOutOthers || (async () => {
        const a = wb.account; if (!a || !a.enabled) return { ok: true }
        for (const x of a.devices || []) if (x && !x.current && !x.signedOut) { try { a.signOut(x.id, { reason: 'erased' }) } catch { /* gone meanwhile */ } }
        const r = await a.sync().catch(() => null)
        return r && r.ok ? { ok: true } : { ok: false, why: 'the other devices could not be told — they clear themselves when they next find the account gone' }
      }),
      leaveRoom: d.leaveRoom || (async (room) => {
        const mk = await keyOf(room); if (!mk || typeof client.leave !== 'function') return { left: false }
        return leaveAndMaybeDelete(room, { post: (h) => client.leave(room, mk, h), handover: (r) => leaveHandover(r, { keys: [key], dropKeys }), del: (r, h, opts) => deleteHandedOver(r, h, { ...opts, url: wb._roomDeleteEndpoint(), fetchImpl: (...a) => wb._fetch(...a) }) })
      }),
      idToken: async () => sess.idToken,
      // ONE rule for "done" (accountErase.stepDone — sync sweep 11-09 #14); a builder's sign-in owns no @username: the server's
      // first_party_required is nothing to release (#4 — it ended every run here, after the rooms and the backup were gone)
      releaseUsername: d.releaseUsername || (async (t) => stepDone(await client.userRelease(t), { nothing: ['first_party_required'] })),
      eraseDirectory: d.eraseDirectory || (async (t) => { const sc = inviteScope(t); return stepDone(await client.dirErase(t, sc || undefined)) }),
      eraseBilling: async () => ({ ok: true }), // the app's user: the builder's server erases it (wb.users.erase)
      deleteBackup: d.deleteBackup || (onService
        ? async () => { if (backup._s && backup._s.erased) return { ok: true }; try { await backup._v2.deleteAccount(backup, { getCode, keep: true }); return { ok: true } } catch (e) { return { ok: false, reason: (e && (e.code || e.message)) || 'failed' } } }
        : () => (gone || backup._deleteRemote(token))),
      backupGone: () => { if (backup._s) { clearTimeout(backup._timer); backup._timer = null; backup._s.erased = true; backup._changed() } }, // pass 7, F#2: no write re-creates it, even if a later step fails
      withdrawFiled: d.withdrawFiled || (this._tenant() ? async () => { const dd = this._d(); const r = await fileEraseList({ tenant: this._tenant(), account: this._account(), rooms: [], keys: [key], dropKeys, post: dd.post, auth: dd.auth, attest: dd.attest, seal: dd.seal, ls: this._ls, force: true }).catch(() => null); return { ok: !!(r && r.filed) } } : null),
      wipe: async () => {
        try {
          if (temporaryScope) wb.temporaryRooms._erase(temporaryScope)
        } finally {
          this._opened = []; this._marked.clear(); this._k = { master: null, key: null }
          try { if (wb.account && typeof wb.account.stop === 'function') wb.account.stop() } catch { /* */ }
          backup._drop() // onState(null): the builder persists that this client holds no account any more
          wb.signOut()
        }
      },
      onStep,
    })
    delete rep.account.billing
    return rep
  }

  /** Is a list filed for this account in this app, and how many rooms? Never the secrets. → `{ ok, filed, rooms?, updated? }` */
  async status () {
    if (!this._tenant() || !this._account()) return { ok: true, filed: false }
    const d = this._d()
    return d.post({ op: 'sentinel', sentinel: { mode: 'erasestatus', tenant: this._tenant() }, ...d.auth })
  }
}

/** The SDK's half of the app's eraseCleanups (accountEraseUi.js): connections, Siri, outside agents, cloud computers, then what is left
 *  at the Sentinel. Room funding and mail addresses are the app's own (a builder bills through its tenant; mail is app-only). */
export function sdkEraseCleanups (wb) {
  const why = (e) => String((e && e.message) || e)
  return [
    { what: 'connections', run: async () => { for (const c of await wb.connections.list()) if (c && c.id) await wb.connections.detach(c.id); return { ok: true } } },
    { what: 'your Siri setup', run: async () => { await wb.siri.revoke(); return { ok: true } } },
    { what: 'outside agents', run: async () => { if (wb.a2a && typeof wb.a2a.revoke === 'function') await wb.a2a.revoke(); return { ok: true } } },
    { what: 'the cloud device', run: async () => {
      if (!wb.cloudDevice) return { ok: true }
      try {
        const status = await wb.cloudDevice.status()
        if (status.email || status.registered || status.rooms?.length) await wb.cloudDevice.forget()
        return { ok: true }
      } catch (e) {
        if (['not_enrolled', 'not_available', 'not_in_dev_server', 'cloud_device_unavailable'].includes(e.code)) return { ok: true }
        return { ok: false, why: why(e) }
      }
    } },
    { what: 'your cloud computers', run: async (t) => { // every object of each (controller destroy) — not remove(), which keeps them for a key file
      if (!wb.computers || typeof wb.computers._read !== 'function') return { ok: true }
      const { destroyCloud } = await import('./codeCloud.js')
      const { cloud } = await wb.computers._read()
      for (const [id, e] of Object.entries((cloud && cloud.cloud) || {})) {
        if (!e || e.removed || !e.workspace) continue
        const r = await destroyCloud({ id, cloud: e }, { token: t })
        if (!r.ok) return r
      }
      return { ok: true }
    } },
    { what: 'your account at the Sentinel', run: async (t) => {
      const r = await wb._sentinelPost()({ op: 'sentinel', sentinel: { mode: 'forgetaccount' }, idToken: t }).catch((e) => ({ error: why(e) }))
      if (r && r.ok) return { ok: true }
      if (/unknown op forgetaccount|not an op this front forwards|bad_mode/.test(String((r && r.error) || ''))) return { ok: true } // an older Sentinel (accountEraseUi.js FORGET_UNSUPPORTED): the steps above took every record it keeps
      return { ok: false, why: String((r && r.error) || 'no answer') }
    } },
  ].map((c) => ({ ...c, run: (t) => c.run(t).catch((e) => ({ ok: false, why: why(e) })) }))
}
