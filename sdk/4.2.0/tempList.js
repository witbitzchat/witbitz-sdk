// tempList.js — THE TEMPORARY-SPACES LIST's edits, as pure functions (no DOM, no storage): the page runs them on its own pointer
// (tempRooms.js) and the hosted vault's worker runs them on the pointer it holds (l1-worker.js `tempList`), so the hosted app
// frame never holds the temp index's key or a temp room's key (the owner, 2026-11-13: "Do 1+3+4"; docs/sdk-convergence.md
// § who holds the room key). The list is [{ room, title, at, mk | userShare+commit }], newest first, at most TEMP_LIST_MAX.

export const TEMP_LIST_MAX = 100
export const isTempRoomId = (r) => typeof r === 'string' && r.startsWith('tmp-') && r.length <= 64

// ⛔ THE LIST IS EDITED, NEVER WRITTEN BLIND (2026-11-08, docs/state-machines.md I10 / A#4): read with the version, refuse to write
//   over a list that could not be read (unknown is not empty), apply the change to what is stored, write only over that version
//   (accountStores put ifV): another write in between → read and apply again. `change(list)` → the new list, or null (nothing to
//   write). → the list written (or the stored one, when nothing changed), or null.
export async function editTempList (store, room, mk, change, by = '') {
  for (let i = 0; i < 3; i++) {
    const r = await store.get(room, mk, 'rooms')
    if (!(r && r.status === 200)) return null
    const cur = r.state && Array.isArray(r.state.rooms) ? r.state.rooms : []
    const next = change(cur)
    if (!next) return cur
    const w = await store.put(room, mk, 'rooms', { rooms: next }, 'temp rooms', by || '', Number.isInteger(r.v) ? { ifV: r.v } : {})
    if (w && w.status === 409) continue
    return w && w.status === 200 ? next : null
  }
  return null
}

// AN ADD (or an UPDATE: auto-title, rename) keeps the room's position and its material. Reopen material: `fresh` ({ mk } or
// { userShare, commit }) when the caller has it; else the existing entry's. ★ A title-only update on a resumed room has no fresh
// material (the key is in the worker, the shares were never kept) — reusing the entry's lets it through ("temp rooms stay
// 'Space'"). Nothing to record at all (a new room we could never reopen) → null: nothing is written.
export function addToTempList (all, { room, title, fresh }) {
  const was = all.find((r) => r && r.room === room)
  const reopen = (fresh && fresh.mk) ? { mk: fresh.mk }
    : (fresh && fresh.userShare) ? { userShare: fresh.userShare, commit: fresh.commit || '' }
    : (was && was.mk) ? { mk: was.mk }
    : (was && was.userShare) ? { userShare: was.userShare, commit: was.commit }
    : null
  if (!reopen) return null
  const prev = all.filter((r) => r && r.room !== room)
  const entry = { room, title: title || (was && was.title) || 'Space', at: (was && was.at) || Date.now(), ...reopen }
  return [entry, ...prev].slice(0, TEMP_LIST_MAX)
}

export const removeFromTempList = (all, rooms) => { const gone = new Set(rooms); return all.filter((r) => r && !gone.has(r.room)) }

// What a caller that does not hold the keys is told: each entry without its material, marked `held` (the worker holds it).
export const keylessTempList = (list) => (Array.isArray(list) ? list : []).filter((e) => e && isTempRoomId(e.room))
  .map(({ mk: _mk, userShare: _us, commit: _c, ...rest }) => ({ ...rest, held: 1 }))
