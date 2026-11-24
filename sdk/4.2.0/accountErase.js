// accountErase.js — DELETE MY ACCOUNT (docs/user-erasure.md). The account's own index is the list: every room, the lanes,
// the sync rooms. Rooms this account created that nobody else used are DELETED (roomDelete.js — the server checks the
// creator's secret); shared rooms are LEFT (what the person posted stays part of the others' conversation — the owner's
// rule); rooms created before deletion commitments existed cannot be deleted by their creator and lapse when idle.
// ORDER (sync sweep 11-09 #3, #15): the sign-in and the BACKUP come FIRST — the steps that can refuse (a protected backup
// asks its second factor, and the server's release lasts 120 s) are met before a single Space is deleted; then the rooms,
// the username, the directory entry and inboxes, the billing user; the index room LAST and only when every step before it
// worked, so a run that did not finish keeps the list it is run again from (every step is idempotent). Then this device is wiped.
// Pure over injected deps, so the order and the rules are tested without a browser.

const lc = (s) => String(s || '').trim().toLowerCase()

/** EVERY PAGE of a room's messages (sync sweep 2026-11-09, Unclear P3: a poll answers ONE page, bounded in bytes, so a long room
 *  was judged from its oldest messages and someone who wrote only later was never seen). `page(sinceCount)` → a poll answer
 *  { status?, entries, more?, version }. → the entries, or null when a page failed or the room did not end within `max` pages —
 *  the caller treats null as "could not check", i.e. shared: never deleted. */
export async function readAllEntries (page, { max = 200 } = {}) {
  const out = []
  let since = 0
  for (let i = 0; i < max; i++) {
    const v = await page(since).catch(() => null)
    if (!v || (v.status != null && v.status !== 200) || !Array.isArray(v.entries)) return null
    out.push(...v.entries)
    if (!v.more) return out
    const next = Number(v.version)
    if (!Number.isFinite(next) || next <= since) return null
    since = next
  }
  return null
}

/** Did anyone besides this account use the room? Conservative: any other email on its allow-list, or any human entry
 *  whose author is not one of this account's names, makes it SHARED — and a shared room is left, never deleted. */
export function roomIsShared ({ entries = [], config = null, me = {} } = {}) {
  const mine = new Set([...(me.names || []), me.email].filter(Boolean).map(lc))
  const allow = (config && config.allow && Array.isArray(config.allow.emails)) ? config.allow.emails : []
  if (allow.some((e) => lc(e) && !mine.has(lc(e)))) return true
  if (config && config.allow && Array.isArray(config.allow.mh) && config.allow.mh.length > 1) return true // hidden addresses: more than one means someone else
  for (const e of entries) {
    if (!e || e.self || e.sys || e.name === 'system' || e.kind === 'system') continue // the assistant and system lines are not people
    if (e.email && !mine.has(lc(e.email))) return true // a verified row carries its writer's email
    const who = lc(e.from || e.name || e.by)
    if (who && !mine.has(who)) return true
  }
  return false
}

/** ONE RULE for "this account step was done" (sync sweep 11-09 #14 — the app read any reply with no `ok` as done, so a 401/503
 *  `{ error }` wiped the device; the SDK read the status alone, so a `200 { ok:false }` passed). `r` is a client reply
 *  `{ status, ...body }` (spaceClient's shape). Done: a 2xx whose body does not say otherwise, or a 404 (nothing there).
 *  `nothing`: refusals that mean there is nothing to do here (e.g. `first_party_required` — an app's sign-in owns no @username).
 *  → { ok, why? } */
export function stepDone (r, { nothing = [] } = {}) {
  if (!r || typeof r !== 'object') return { ok: false, why: 'unreachable' }
  const err = typeof r.error === 'string' ? r.error : ''
  if (err && nothing.includes(err)) return { ok: true }
  const st = r.status
  if (st === 404) return { ok: true }
  const why = String(r.reason || err || 'refused') + (st ? ' (' + st + ')' : '')
  if (st !== undefined && !(Number(st) >= 200 && Number(st) < 300)) return { ok: false, why: st ? why : 'unreachable' }
  if (r.ok === false || err) return { ok: false, why }
  return { ok: true }
}

/** The BACKUP's delete for a device that holds its id (docs/user-erasure.md): asked plainly first (or with a release already in
 *  hand); only when the server answers `gated` — a protected backup with its gate enforced — the account's second factor runs,
 *  right then, and the delete is asked again with that fresh release (it lasts 120 s; sync sweep 11-09 #3: the regular app sent
 *  a token only a restore or a link leaves behind, so every protected backup refused after the rooms were gone).
 *  post(token|null) → { status, json }; factor() → release token | null. → { ok, status?, reason? } */
export async function deleteGatedBackup ({ post, factor, token = null }) {
  const verdict = ({ status, json }) => {
    if (status === 200 || status === 404) return { ok: true } // 404: already gone
    return { ok: false, status, reason: (json && (json.reason === 'incomplete' ? 'some old copies could not be deleted yet — run it again' : (json.error || json.reason))) || ('backup ' + (status || 'unreachable')) }
  }
  const first = await post(token || null)
  if (!(first.status === 403 && first.json && (first.json.reason === 'gated' || first.json.error === 'gated'))) return verdict(first)
  const t = await Promise.resolve().then(factor).catch(() => null)
  if (!t) return { ok: false, status: 403, reason: 'verification is needed to delete your protected backup' }
  return verdict(await post(t))
}

// ⛔ QUEUED IS NOT DELETED (state machines pass 9, 9·S#1): the server answers a creator's delete on its one-row check —
//   `200 { queued: true }` — and deletes in the background, which can still end with the room whole (busy, shared, a failed
//   sweep). The run counted that answer as deleted, deleted the index and wiped the device — the account key the room's delete
//   secret derives from — so nothing could delete the room again. A queued room is now CONFIRMED: asked again (`confirmDeleted`,
//   a probe that queues nothing; else the delete itself, less often) until THIS secret's tombstone is down. Unconfirmed in time, it
//   is a failure: the index and the device are kept, and the next run asks again (a tombstoned room answers at once then).
// LEAVING (roomLeave.mjs, the owner 2026-11-17: "a verified room is deleted when its last member is gone"): leaveRoom may answer
// `{ deleted: true }` — this account was the last one who joined a verified room, and it deleted the room with what the others
// handed over. Then the room counts as deleted, not left.
async function leaveInto (d, room, rep, otherwise) {
  let r = null
  try { r = await d.leaveRoom(room) } catch { /* */ }
  if (r && r.warming) { rep.failed.push({ room, why: 'its confidential assistant did not wake up — run Delete my account again in a few minutes' }); return } // sweep 11-18 #1
  ;(r && r.deleted ? rep.deleted : otherwise).push(room)
}

export const CONFIRM_EVERY_MS = 15_000, CONFIRM_WITHIN_MS = 5 * 60_000
const queuedOnly = (r) => !!(r && r.ok && r.body && r.body.queued === true && r.body.tombstoned !== true)
async function confirmQueued (d, rooms, rep, say) {
  const ask = d.confirmDeleted || d.deleteRoom
  const sleep = d.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)))
  const now = d.now || Date.now
  const every = d.confirmDeleted ? CONFIRM_EVERY_MS : 60_000 // the delete itself re-queues a whole-store walk: ask it seldom
  const until = now() + CONFIRM_WITHIN_MS
  let left = [...rooms]
  while (left.length && now() < until) {
    say('Waiting for the server to finish deleting ' + (left.length === 1 ? 'a Space' : left.length + ' Spaces') + ' (this can take a few minutes)…')
    await sleep(every)
    const still = []
    for (const room of left) {
      const c = await Promise.resolve().then(() => ask(room)).catch(() => null)
      const b = (c && c.body) || {}
      if (c && c.ok && (b.tombstoned === true || (b.deleted === true && !b.queued && !b.pending))) rep.deleted.push(room)
      else if (c && c.status === 409 && b.error === 'shared') await leaveInto(d, room, rep, rep.left) // the server's full check found another account
      else if (c && c.status === 404) await leaveInto(d, room, rep, rep.lapsing)
      else still.push(room)
    }
    left = still
  }
  for (const room of left) rep.failed.push({ room, why: 'still being deleted on the server — run Delete my account again in a few minutes' })
}

/**
 * deps: { rooms: { all: [room], account: [room] }  (account = index, pipes, lanes, usage sidecar holders),
 *         read(room) → { entries, config } | null, deleteRoom(room) → { ok, status, body }, leaveRoom(room),
 *         confirmDeleted(room)? → { ok, status, body } (the server's probe: is THIS secret's tombstone down — 9·S#1), sleep(ms)?, now()?,
 *         idToken() → string, releaseUsername(t), eraseDirectory(t), eraseBilling(t), deleteBackup() → { ok, status, reason },
 *         backupGone()? (the backup was deleted: stop writing it),
 *         cleanups?: [{ what, run(idToken) → { ok, why? }, needsBilling? }] (after the backup, before the rooms),
 *         signOutOthers()? → { ok, why? } (before the index; best effort),
 *         indexRoom: room | null, wipe(), me: { email, names }, onStep(text) }
 * → a report { deleted:[room], left:[room], lapsing:[room], failed:[{room|what, why}], account:{ username, directory, billing, backup } }
 */
export async function eraseAccount (d) {
  const say = (t) => { try { d.onStep && d.onStep(t) } catch { /* */ } }
  const rep = { deleted: [], left: [], lapsing: [], failed: [], account: {}, attestedLeft: [] }
  // FIRST, before anything is deleted: the sign-in the account steps need, then the backup (its gate may ask a second factor)
  say('Checking your sign-in…')
  const t = await Promise.resolve().then(() => d.idToken()).catch(() => '')
  if (!t) { rep.failed.push({ what: 'account', why: 'sign-in needed' }); return rep }
  say('Deleting your backup…')
  const b = await Promise.resolve().then(() => d.deleteBackup()).catch(() => ({ ok: false, reason: 'unreachable' }))
  rep.account.backup = !!(b && b.ok)
  if (!rep.account.backup) { rep.failed.push({ what: 'backup', why: (b && (b.reason || b.status)) || 'failed' }); return rep } // nothing deleted yet: verify and run it again
  // pass 7, F#2: the backup is gone — this device writes it no more, even when a later step fails and it is not wiped
  if (d.backupGone) { try { await d.backupGone() } catch { /* the server's 410 is the backstop */ } }
  // WHAT THE ACCOUNT LEFT OUTSIDE ITS ROOMS ("We should delete everything we can", the owner, 2026-11-17): connections at the
  // Sentinel, Siri, outside agents, mail addresses, room-funding grants, the cloud device. After the backup (the point of no
  // return), BEFORE any room goes: a mail address and Siri are ended through the message room, a grant through the billing
  // record. A failure is a failure like any other: the rest runs, the index and the device stay, a re-run finishes it.
  const holdBilling = []
  for (const c of Array.isArray(d.cleanups) ? d.cleanups : []) {
    if (!c || typeof c.run !== 'function') continue
    say('Removing ' + c.what + '…')
    const r = await Promise.resolve().then(() => c.run(t)).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
    if (r && r.ok) (rep.account.cleaned = rep.account.cleaned || []).push(c.what)
    else { rep.failed.push({ what: c.what, why: (r && (r.why || r.error)) || 'failed' }); if (c.needsBilling) holdBilling.push(c.what) }
  }
  const account = new Set(d.rooms.account || [])
  const list = [...new Set([...(d.rooms.all || []), ...account])].filter((r) => r && r !== d.indexRoom)
  const queued = []
  for (const room of list) {
    say('Checking your Spaces…')
    let shared = false
    if (!account.has(room)) {
      const r = await d.read(room).catch(() => null)
      shared = !r || roomIsShared({ entries: r.entries, config: r.config, me: d.me }) // unreadable ⇒ treat as shared: never delete what we could not check
    }
    if (shared) { await leaveInto(d, room, rep, rep.left); continue }
    const del = await d.deleteRoom(room).catch(() => ({ ok: false, status: 0 }))
    if (queuedOnly(del)) queued.push(room) // answered, not deleted yet: confirmed below (9·S#1)
    else if (del.ok) rep.deleted.push(room)
    else if (del.status === 409 && del.body && del.body.error === 'busy') rep.failed.push({ room, why: 'delete busy — the room is being changed just now; run Delete my account again' }) // NOT "shared" (pass 9, X#3): it is this account's room, still on the server
    else if (del.status === 409) await leaveInto(d, room, rep, rep.left) // the server saw another account's traces: shared after all
    else if (del.status === 404) await leaveInto(d, room, rep, rep.lapsing) // no commitment (an older room): it lapses when idle
    else rep.failed.push({ room, why: 'delete ' + (del.status || 'unreachable') })
  }
  if (queued.length) await confirmQueued(d, queued, rep, say)
  say('Removing your account details…')
  for (const [k, fn] of [['username', d.releaseUsername], ['directory', d.eraseDirectory], ['billing', d.eraseBilling]]) {
    if (k === 'billing' && holdBilling.length) { rep.account.billing = false; rep.failed.push({ what: 'billing', why: 'kept until ' + holdBilling.join(', ') + ' is removed — run Delete my account again' }); continue } // a grant is stopped through the billing record
    const r = await Promise.resolve().then(() => fn(t)).catch((e) => ({ ok: false, why: String((e && e.message) || e) }))
    rep.account[k] = !!(r && r.ok)
    if (!rep.account[k]) rep.failed.push({ what: k, why: (r && (r.why || r.error)) || 'failed' })
  }
  if (d.withdrawFiled) { const w = await d.withdrawFiled().catch(() => ({ ok: false })); if (!(w && w.ok)) rep.failed.push({ what: 'erase list', why: 'the app’s copy could not be withdrawn' }) } // E3: the Sentinel's copy for this app's tenant
  // THE ATTESTED BACKUPS (the owner, 2026-11-10: "new delete"): each kind's backup is deleted by its own attested app's proof
  // (attestedBackup.js erase → op attested-del). A kind this device cannot prove (its app is not here) cannot be deleted from here:
  // said in the report (`attestedLeft`), never a failure that would keep everything else — its blob stays sealed under the account
  // key just deleted, so nobody can read it. LAST, and only when every step before worked (pass 8, B#1): the server's tombstone is
  // final, so an account that lives on after a failed run keeps its attested backup, and the re-run deletes it.
  if (d.eraseAttested && !rep.failed.length) {
    say('Deleting your attested backups…')
    const out = await Promise.resolve().then(() => d.eraseAttested()).catch(() => [])
    for (const x of Array.isArray(out) ? out : []) {
      if (!x || !x.kind) continue
      if (x.ok) (rep.account.attested = rep.account.attested || []).push(x.kind)
      else if (x.here === false) rep.attestedLeft.push(x.kind)
      else rep.failed.push({ what: 'attested backup (' + x.kind + ')', why: x.reason || 'failed' })
    }
  }
  // THE OTHER DEVICES: signed out through the index (devices.js signOutOthersForErase, reason 'erased' — each wipes itself and says
  // why), written before the index goes, and only once every step worked. BEST EFFORT, never a failure: the index is deleted
  // seconds later, so only a device online then reads the stamp — it must not keep the account alive for the rest.
  if (d.signOutOthers && !rep.failed.length) {
    say('Signing out your other devices…')
    const r = await Promise.resolve().then(() => d.signOutOthers()).catch(() => null)
    rep.account.otherDevices = !!(r && r.ok)
  }
  if (d.indexRoom && !rep.failed.length) { // LAST, and only after everything else worked: a run that did not finish keeps the list it re-runs from
    const r = await d.deleteRoom(d.indexRoom).catch(() => ({ ok: false, status: 0 }))
    if (queuedOnly(r)) await confirmQueued(d, [d.indexRoom], rep, say) // the index holds the account key: confirmed before the wipe (9·S#1)
    else if (r.ok) rep.deleted.push(d.indexRoom); else if (r.status === 404) rep.lapsing.push(d.indexRoom); else rep.failed.push({ room: d.indexRoom, why: 'delete ' + (r.status || 'unreachable') })
  }
  if (!rep.failed.length) { say('Done.'); try { await d.wipe() } catch { /* */ } }
  return rep
}
