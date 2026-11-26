// spaces/public/emptySpaces.js — Settings → "Remove empty Spaces" (spaces/test/emptySpaces.test.mjs). The owner,
// 2026-10-10, after a day of Help attempts left a run of unnamed, empty Spaces in the list: "Build it that way" — check
// each Space with the server, list what qualifies, ask once, delete them on the server and from every device.
//
// ★ WHAT QUALIFIES — all of it, or the Space is kept:
//   - the server answers for it, and it holds NO message (a name entry is not a message);
//   - nobody else was invited into it (its sealed config names no other email);
//   - it is not pinned, not the Help Space, not a private lane or one with a lane, not temporary.
// ★ HOW IT GOES: the server delete first (roomDelete.deleteOwnRoom — the account's delete commitment; the server itself
//   refuses a Space someone else has used, 409), then the device forgets it exactly as a delete by hand does (tombstone
//   → every device). A Space this account did not create carries no commitment (404): it holds nothing, so it is only
//   forgotten. Anything the server refuses or fails is kept and said.

let _h = {
  rooms: () => [],                 // → [{ room, title, pinned, archived }] — this device's list (recents)
  read: async () => null,          // (room) → { entries, config } | null (the server's answer; null = could not read)
  me: () => '',                    // → this account's email
  keep: () => false,               // (room) → true for the Help Space, lanes, anything never to touch
  deleteOnServer: async () => ({ ok: false, status: 0 }), // (room) → roomDelete.deleteOwnRoom
  forget: async () => {},          // (room) → the device's delete (forgetSpace + afterItemGone)
  gone: async () => false,         // (room) → true when the Space answers 'deleted' (410): the server finished after the call gave up
}
export const setEmptySpacesHooks = (h) => { _h = { ..._h, ...h } }

/** A message is anything a person or the assistant put in the room — not its name (title entries) or a system line. */
export const hasMessages = (entries) => (Array.isArray(entries) ? entries : []).some((e) => e && e.kind !== 'title' && !e.sys)
/** Other people named in its sealed config (invited by email, admins, owners) — then it is not only yours. */
export async function ownAdmissionEntries(config, email, readRoster) {
  const mine = String(email || '').trim().toLowerCase()
  if (!mine || ![config?.allow, config?.admins, config?.owners].some(p => p?.users?.length || p?.mh?.length)) return []
  const book = await Promise.resolve().then(readRoster).catch(() => null)
  if (book?.status !== 200) return []
  return Object.values(book.seen || {}).filter(row => String(row?.email || '').trim().toLowerCase() === mine)
    .flatMap(row => Array.isArray(row.entries) ? row.entries : [])
}
export function othersIn(config, me, selfHash = '', selfEntries = []) {
  if (!config || typeof config !== 'object' || config.gated || config.error) return true
  for (const policy of [config.allow, config.admins, config.owners]) {
    if (policy?.mh && (!Array.isArray(policy.mh) || policy.mh.some(hash => hash !== selfHash && !selfEntries.includes('mh:' + hash)))) return true
    if (policy?.domains?.length) return true
    if (policy?.users?.some(user => !user?.handle || !selfEntries.includes('u:' + String(user.handle).toLowerCase()))) return true
  }
  const mine = String(me || '').trim().toLowerCase()
  const lists = [config && config.allow && config.allow.emails, config && config.admins && config.admins.emails, config && config.owners && config.owners.emails]
  return lists.flat().filter(Boolean).map((x) => String(x).trim().toLowerCase()).some((x) => x && x !== mine)
}

/** → [{ room, title }] of the Spaces that qualify. Reads up to 4 at a time; a Space it cannot read is kept. */
export async function findEmptySpaces({ onProgress, onUnreadable } = {}, hooks = _h) {
  const me = hooks.me()
  const list = (hooks.rooms() || []).filter((r) => r && r.room && !String(r.room).startsWith('tmp-') && !r.pinned && !hooks.keep(r.room))
  const out = []
  let i = 0, done = 0
  const worker = async () => {
    while (i < list.length) {
      const r = list[i++]
      let v = null
      try { v = await hooks.read(r.room) } catch { v = null }
      done++; try { onProgress && onProgress(done, list.length) } catch { /* */ }
      if (v?.excluded) continue
      if (!v || !Array.isArray(v.entries) || !v.config || v.config.gated || v.config.error) { onUnreadable?.(r.room); continue } // unknown → kept
      if (hasMessages(v.entries) || othersIn(v.config, me, v.selfHash, v.selfEntries)) continue
      out.push({ room: r.room, title: (r.title && r.title !== r.room) ? r.title : 'Space' })
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return out
}

/** Why a Space stayed, in words — the owner saw "the server did not answer" for a delete that never left the phone. */
export function whyKept (r) {
  const st = (r && r.status) || 0, err = (r && r.body && r.body.error) || ''
  if (err === 'room_changed' || err === 'cleanup_unconfirmed') return 'the final check could not confirm the room was unchanged'
  if (st === 200 && r?.body?.deleted === false) return 'deletion has not been confirmed'
  if (st === 409) return 'someone else has used it'
  if (err === 'no_account_key') return 'this device has no key for deleting your Spaces — open the app on the device you made it on'
  if (!st) return 'the server could not be reached'
  return `the server refused it (${st}${err ? ' ' + err : ''})`
}

/** Delete each on the server, then forget it on every device. → { removed, forgottenOnly, kept: [{ title, why }] } */
export async function removeEmptySpaces(found, hooks = _h) {
  const rep = { removed: 0, forgottenOnly: 0, kept: [] }
  for (const s of found) {
    const listed = (hooks.rooms() || []).find(item => item.room === s.room)
    const policy = listed && hooks.prepare ? await hooks.prepare(s.room).catch(() => null) : null
    const latest = listed && !listed.pinned && !s.room.startsWith('tmp-') && !hooks.keep(s.room)
      ? await hooks.read(s.room).catch(() => null) : null
    if (!latest || !Array.isArray(latest.entries) || hasMessages(latest.entries) || othersIn(latest.config, hooks.me(), latest.selfHash, latest.selfEntries)) {
      rep.kept.push({ title: s.title, why: 'could not confirm it is still empty and only yours' })
      continue
    }
    let r = { ok: false, status: 0 }
    for (let n = 0; n < 5; n++) { r = await hooks.deleteOnServer(s.room, latest.etag || 'absent', policy?.body?.policyVersion).catch(() => ({ ok: false, status: 0 })); if (r.status !== 207) break } // 207: partly done, call again
    if (r.status === 200 && r.body?.deleted === false && hooks.checkDeletion) {
      const until = Date.now() + 120000
      do {
        await new Promise(resolve => setTimeout(resolve, 2000))
        const checked = await hooks.checkDeletion(s.room).catch(() => null)
        if (!checked || checked.status !== 200 || checked.body?.deleted === true) { if (checked?.body?.deleted === true) r = checked; break }
      } while (Date.now() < until)
    }
    if ((r.ok || r.status === 200) && r.body?.deleted === true) { await hooks.forget(s.room); rep.removed++ }
    else if (r.status === 404) { await hooks.forget(s.room); rep.forgottenOnly++ } // not created by this account: nothing on it to delete
    // the delete marks the Space deleted FIRST and then sweeps its data — a sweep longer than the gateway's 30 s answers 503 (or
    // nothing) to a delete that went through (the owner, 2026-10-16: 'Try' kept with 503; the server logged it done, 75–98 s)
    else if (r.status !== 409 && await hooks.gone(s.room).catch(() => false)) { await hooks.forget(s.room); rep.removed++ }
    else rep.kept.push({ title: s.title, why: whyKept(r) })
  }
  return rep
}
