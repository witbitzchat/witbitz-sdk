// accountIndexDoc.js — THE ACCOUNT INDEX'S RULES, pure (docs/sdk-account-format-plan.md, phase 1). The Spaces app keeps the
// account's room list in its index room (the sealed 'index' doc, `xindex`); these are the rules that build what a device writes
// there and fold what it reads back into its own list. They lived inside roomSync.js's push and sync, next to the page's storage;
// here they take state in and give state out — no storage, no DOM, no page state — so the SDK can run the same rules (phase 3).
// roomSync.js calls them; what the app writes and applies is unchanged (spaces/test/accountFormatGolden.test.mjs holds it).

const isTemp = (room) => String(room || '').startsWith('tmp-') // temp rooms never belong in the synced index (roomSync.js)

/** The entry this device writes for one of its rooms: `row` = its recents row, `prev` = the index's entry as read (or none),
 *  `key` = the key part ({ mk } / { split, userShare, commit? } / {} when the key worker injects it), `marks` = what this device
 *  knows of the room ({ help, gate, enclave }). Per-field last writer: a newer rename / archive / pin another device pushed is
 *  kept; the latest activity anywhere orders the list; a Help / verified / confidential mark is never taken off. */
export function indexRoomEntry (row, prev, key, { help = false, gate = '', enclave = false } = {}) {
  const myTitle = (row.title && row.title !== 'Space' && row.title !== row.room) ? row.title : ''
  const myAt = row.titleAt || 0
  const keepRemote = prev && prev.title && (prev.titleAt || 0) > myAt // per-field LWW: don't clobber a newer rename another device pushed
  const archNewer = !prev || (row.archivedAt || 0) >= (prev.archivedAt || 0) // newest archive/unarchive wins
  const pinNewer = !prev || (row.pinnedAt || 0) >= (prev.pinnedAt || 0)
  // KEPT ALWAYS ON by the account's cloud device (the owner, 2026-11-22: "We need to know in every device which rooms are always on"):
  // a fact of the account, set by the device that handed the Space over or took it back — per field, newest wins, like a pin. Written
  // only once it was ever set, so the doc of an account that never used it is byte-for-byte what it was (accountFormatGolden).
  const aoAt = Math.max(row.alwaysOnAt || 0, (prev && prev.alwaysOnAt) || 0)
  const aoOn = !prev || (row.alwaysOnAt || 0) >= (prev.alwaysOnAt || 0) ? !!row.alwaysOn : !!prev.alwaysOn
  return {
    ...key,
    title: keepRemote ? prev.title : myTitle, titleAt: keepRemote ? prev.titleAt : myAt, ...((keepRemote ? prev.manual : (myTitle && row.renamed)) ? { manual: true } : {}), // a name set by hand travels as such (roomTitle.js: never an impostor)
    at: Math.max(row.at || 0, (prev && prev.at) || 0), // ordering: keep the LATEST activity across devices so the list order converges
    archived: archNewer ? !!row.archived : !!prev.archived, archivedAt: Math.max(row.archivedAt || 0, (prev && prev.archivedAt) || 0),
    pinned: pinNewer ? !!row.pinned : !!(prev && prev.pinned), pinnedAt: Math.max(row.pinnedAt || 0, (prev && prev.pinnedAt) || 0),
    ...(aoAt ? { alwaysOn: aoOn, alwaysOnAt: aoAt } : {}),
    ...((help || (prev && prev.help)) ? { help: 1 } : {}), // THE HELP SPACE: other devices open THIS one rather than make another
    ...((gate === 'email' || (prev && prev.gate === 'email')) ? { gate: 'email' } : {}), // a VERIFIED Space says so to the account's other devices — a gate never comes off
    ...(enclave || (prev && prev.enclave) ? { enclave: 1 } : {}), // the enclave tier flag (docs/enclave-room-acceptance.md §3.2) — a device that doesn't know it keeps another's
  }
}

/** Every delete this device knows, as index entries — they win over any live entry. */
export function indexDeletes (tomb) {
  const out = {}
  for (const rm of Object.keys(tomb || {})) out[rm] = { deleted: true, at: tomb[rm] }
  return out
}

/** The deletes the index carries, adopted into this device's tombstones (never undone): → { tomb (a new map), adopted (rooms
 *  newly tombstoned here, in the index's order), deleted (every room the index marks deleted, in its order) }. A delete with no
 *  time is stamped `now()`. */
export function adoptIndexDeletes (remoteRooms, tomb, now = Date.now) {
  const next = { ...(tomb || {}) }, adopted = [], deleted = []
  const rooms = remoteRooms && typeof remoteRooms === 'object' ? remoteRooms : {}
  for (const rm of Object.keys(rooms)) {
    const e = rooms[rm]
    if (!(e && e.deleted)) continue
    deleted.push(rm)
    if (!next[rm]) { next[rm] = e.at || now(); adopted.push(rm) }
  }
  return { tomb: next, adopted, deleted }
}

/** Is the index's entry one this device takes into its list? Never a temp room, a deleted or tombstoned one, nor — when this
 *  device reads the index WITH keys (`keyless` false) — an entry that carries no key of either kind. Archived ones are taken. */
export const adoptableIndexEntry = (room, e, tomb, { keyless = false } = {}) => !(!e || isTemp(room) || (!keyless && !(e.mk || e.userShare)) || e.deleted || (tomb && tomb[room]))

/** A room another device listed, as this device's new recents row (its name, Help mark, archive, pin and order carried). */
export function recentFromIndexEntry (room, e) {
  return { room, title: (e.title && e.title !== room) ? e.title : 'Space', at: e.at || 0, ...(e.help ? { help: true } : {}), ...(e.titleAt ? { titleAt: e.titleAt } : {}), ...(e.title && e.title !== room ? { titled: true } : {}), ...(e.manual && e.title && e.title !== room ? { renamed: true, llmTitled: true } : {}), ...(e.archived ? { archived: true, archivedAt: e.archivedAt || 0 } : {}), ...(e.pinned ? { pinned: true, pinnedAt: e.pinnedAt || 0 } : {}), ...(e.alwaysOnAt ? { alwaysOn: !!e.alwaysOn, alwaysOnAt: e.alwaysOnAt } : {}) }
}

/** The index's entry folded into this device's row for the same room: → { row (a new object; `row` itself when nothing moved),
 *  changed, renamed (a newer name arrived — the open room's header follows) }. Each field by its own clock. */
/** 11·R#2: the index sync merged the remote rows into `cur`, then WAITED (the lanes registry, ≤ 4 s) before saving. Another writer may have
 *  saved the list meanwhile (an attested restore, an invite) — saving `cur` dropped its rows. → the list to save: the list as it is NOW
 *  (`fresh`), with this pass's arrivals added and its merges re-applied. A room `fresh` lost meanwhile (deleted elsewhere) is not brought
 *  back unless this pass brought it. `fresh === cur` (nothing saved meanwhile) → `cur` as it is. */
export function rebaseIndexMerge (cur, fresh, arrived, remote) {
  if (!Array.isArray(fresh) || fresh === cur) return cur
  const out = fresh.slice(), by = new Map(out.map((x) => [x && x.room, x])), came = new Set(arrived || [])
  for (const r of cur) {
    if (!r || !r.room) continue
    const f = by.get(r.room)
    if (!f) { if (came.has(r.room)) { out.push(r); by.set(r.room, r) } continue }
    if (f !== r && remote && remote[r.room]) { const m = mergeIndexEntry(f, remote[r.room], r.room); if (m && m.changed) Object.assign(f, m.row) }
  }
  return out
}

export function mergeIndexEntry (row, e, room) {
  const li = { ...row }
  let changed = false, renamed = false
  if (e.help && !li.help) { li.help = true; changed = true } // the account's Help Space (docs/help-space.md)
  if (e.manual && e.title && e.title === li.title && !li.renamed) { li.renamed = true; changed = true } // the same name, now known to be set by hand (another device named it): Invite must not ask again
  if (e.title && e.title !== room && e.title !== li.title && (e.titleAt || 0) > (li.titleAt || 0)) { // a RENAME on another device (newer titleAt wins)
    li.title = e.title; li.titleAt = e.titleAt; li.titled = true; li.renamed = !!e.manual; changed = true; renamed = true // a name from the index is a name: the first-message heuristic must not replace it (roomTitle.js pinRecentTitle)
  }
  if ((e.archivedAt || 0) > (li.archivedAt || 0) && !!e.archived !== !!li.archived) { li.archived = !!e.archived; li.archivedAt = e.archivedAt || 0; changed = true } // adopt a newer archive/unarchive
  if ((e.pinnedAt || 0) > (li.pinnedAt || 0) && !!e.pinned !== !!li.pinned) { li.pinned = !!e.pinned; li.pinnedAt = e.pinnedAt || 0; changed = true } // adopt a newer pin/unpin
  if ((e.alwaysOnAt || 0) > (li.alwaysOnAt || 0)) { li.alwaysOn = !!e.alwaysOn; li.alwaysOnAt = e.alwaysOnAt; changed = true } // adopt a newer always on / off (another device kept it, or stopped)
  if ((e.at || 0) > (li.at || 0)) { li.at = e.at; changed = true } // converge ORDER to the latest activity anywhere
  return { row: changed ? li : row, changed, renamed }
}

/** A hidden room's pointer ({ room, mk }) as the index carries it, or null. */
export const validPointer = (p) => (p && p.room && p.mk ? p : null)

/** The pointer this device publishes (the pipes room, the message room): the WINNER — the smaller room id — so a split heals in
 *  one round; this device's own when the index has none, and the index's when this device has none, so a device without one
 *  never deletes everyone's (op:'state' replaces the doc). `local` counts once it names a room; `remote` should be validPointer'd. */
export const pointerToPublish = (local, remote) => ((local && local.room && remote) ? (local.room <= remote.room ? local : remote) : (local && local.room ? local : remote))

/** Does the index's id win over this device's (the hidden rooms' pointers, the invite inbox)? When this device has none, or the
 *  index's is the smaller — every device independently picks the same winner, no flip-flop. */
export const adoptsRemote = (localId, remoteId) => (!localId || (remoteId !== localId && remoteId < localId))

/** THE `xindex` DOC (the sealed 'index'): the rooms map, the device registry and its sign-outs, the person's name, the read
 *  positions, and — only when this device has one — the invite inbox, the usage key (with the retired ones) and the pipes /
 *  message room pointers. Key order is the doc's: accountFormatGolden.test.mjs hashes it as written (phase 3: the SDK writes it too). */
export const indexDoc = ({ rooms, devices, signouts, name, seen, vseen, inviteKey, usageKey, usageKeysOld, pipesRoom, msgsRoom }) =>
  ({ v: 2, rooms, devices, signouts, name, seen, vseen, ...(inviteKey ? { inviteKey } : {}), ...(usageKey ? { usageKey, usageKeysOld } : {}), ...(pipesRoom ? { pipesRoom } : {}), ...(msgsRoom ? { msgsRoom } : {}) })

/** THE `xindex2` DOC (the sealed 'index2'): contacts, the personal calendar and to-dos, the Code settings, the connections'
 *  call keys with their removal marks (`connGone` only once someone detached), Siri and the A2A lanes. */
export const index2Doc = ({ contacts, events, todos, code, connections, connGone, siri, a2a }) =>
  ({ v: 2, contacts, events, todos, code, connections, ...(connGone ? { connGone } : {}), siri, a2a })
