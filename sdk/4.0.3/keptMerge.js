// keptMerge.js — ONE SET OF MERGE RULES for what an account keeps on every device of it: the Siri inbox (by Space), the outside
// agents' lanes (by inbox, agents by id), the connections' call keys (by id) and the removal marks and tombstones that say what
// was taken off (docs/vault-core-convergence-review.md § Option C, C3; the owner: "Yes", 2026-11-13).
// THE RULES ONLY, NOT THE FORMATS (the owner, 2026-10-05: "Don't merge the formats"): the app keeps its records in `space:siri` /
// `space:a2a` / `space:connectionKeys`, the index2 doc and the backup (store.js mergeSiriRecords, a2aCore.js mergeA2ARecords,
// backupMerge.js); a builder's vault keeps them in `xvaultkeep` (vaultKeep.js mergeKeep / keepPass). Each side reads and writes
// its own format and calls these. They fixed the same class twice (pass 9 K#3 the app, K#8 the keep) and drifted: one rule here.
// Pure: no DOM, no storage, no crypto.

export const MAX_MARKS = 64 // removal marks per record (a lane's `removed`, Siri's `gone`, the lanes' `gone`)
export const MAX_TOMBS = 300 // tombstones per kept map (the keep's connections and lanes)
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)
/** JSON with every object's keys sorted: two copies alike in content compare equal whatever their key order. */
export const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v))

/** Two copies' removal marks ({ key: at }) into one: the later time for each key, newest first, at most `max` (a side that bounds
 *  its record itself passes Infinity). A mark is never dropped by a merge before the bound: what one copy took off stays off. */
export function unionMarks (a, b, max = MAX_MARKS) {
  const out = {}
  for (const m of [a, b]) for (const [k, at] of Object.entries(m && typeof m === 'object' && !Array.isArray(m) ? m : {})) if (num(Number(at))) out[k] = Math.max(out[k] || 0, Number(at))
  const all = Object.entries(out).sort((x, y) => y[1] - x[1])
  return Object.fromEntries(Number.isFinite(max) ? all.slice(0, max) : all)
}

/** TWO COPIES OF ONE INBOX (the same lane handle) into one (pass 9 K#3 K#8): the preferred copy's name and rules, the agents of
 *  both by id (the preferred copy's first), and an agent EITHER copy removed never comes back — peer ids are never reused. */
export function mergePeers (pref, other, max = MAX_MARKS) {
  const removed = unionMarks(pref && pref.removed, other && other.removed, max)
  const mine = Array.isArray(pref && pref.peers) ? pref.peers : [], theirs = Array.isArray(other && other.peers) ? other.peers : []
  const have = new Set(mine.map((p) => p && p.id))
  const peers = [...mine, ...theirs.filter((p) => p && !have.has(p.id))].filter((p) => p && !removed[p.id])
  return { ...pref, peers, ...(Object.keys(removed).length ? { removed } : {}) }
}

/** SIRI, SPACE BY SPACE (pass 9 K#3 K#8): a Space's entry is alive unless a mark took it off after it was made (`gone[room]` ≥
 *  its `at`). Per Space: the preferred copy's entry while it is alive, else the other's — a Space switched on AGAIN after the
 *  mark is kept even when the preferred copy still holds its entry from before (C3: the keep lost it); neither alive → gone. */
export function mergeSiriRooms (pref, other, gone, { newer = true } = {}) {
  const alive = (r, e) => !!(e && typeof e === 'object') && !(gone && gone[r] && num(Number(e.at)) <= gone[r])
  const out = {}
  for (const r of new Set([...Object.keys(other || {}), ...Object.keys(pref || {})])) {
    const p = (pref || {})[r], o = (other || {})[r]
    // both alive: the NEWER entry (its `at` — made, or renamed) — a tie keeps the preferred copy's (sync sweep 2026-11-14 P8)
    if (newer && alive(r, p) && alive(r, o)) out[r] = num(Number(o.at)) > num(Number(p.at)) ? o : p
    else if (alive(r, p)) out[r] = p
    else if (alive(r, o)) out[r] = o
  }
  return out
}
/** THE SAME RULE FOR ANY MAP OF ENTRIES ({ at, … }) AGAINST REMOVAL MARKS — the app's connection call keys beside their `connGone`
 *  marks (store.js mergeConnectionRecords; the owner, 2026-11-13: an added field, not a format change). An entry with no `at`
 *  (written before marks existed) is older than any mark; a re-attach after the mark is kept. The keep's newerEntry, per id. */
export const mergeByMarks = (pref, other, gone) => mergeSiriRooms(pref, other, gone, { newer: false }) // connection keys: the preferred copy's, as before
/** The Shortcut key: the copy with the higher generation (`rev`, raised by Delete Siri setup) decides it, an empty one included —
 *  a copy from before the delete never brings the old key back (K#3); a tie keeps a key either copy has (preferred first). */
export function siriKeyOf (pref, other) {
  const rp = num(Number(pref && pref.rev)), ro = num(Number(other && other.rev))
  const tp = (pref && pref.token) || '', to = (other && other.token) || ''
  return rp > ro ? tp : ro > rp ? to : (tp || to)
}
/** The default Space: the first one wanted that is still a Space of the merge (C3: the app blanked it when its own had gone). */
export const siriDefaultOf = (rooms, ...wanted) => wanted.find((d) => d && rooms && rooms[d]) || ''

/** LAST WRITER WINS PER ENTRY ({ at, …} or a tombstone { at, gone: true }) — the keep's connections and lanes. A tie: the
 *  tombstone wins; two entries alike in time are ordered by their content, so the merge is the same either way round. */
export const newerEntry = (x, y) => (!x ? y : !y ? x : num(y.at) > num(x.at) ? y : num(y.at) < num(x.at) ? x : (y.gone && !x.gone) ? y : (x.gone && !y.gone) ? x : canon(y) > canon(x) ? y : x)
/** Two maps of entries into one, `pick` per id; past `max` tombstones the oldest go (a device that old re-adds: the safe side). */
export function mergeEntries (a, b, pick = newerEntry, max = MAX_TOMBS) {
  const out = {}
  for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[id] = pick((a || {})[id], (b || {})[id])
  const tombs = Object.entries(out).filter(([, e]) => e && e.gone).sort((x, y) => num(y[1].at) - num(x[1].at))
  for (const [id] of tombs.slice(max)) delete out[id]
  return out
}

/** WRITE ONLY WHAT WAS APPLIED (sync sweep 2026-11-12 #1 #2): what a device records as "what I hold" must be what its stores
 *  hold — a merged view carries the other devices' entries, and an entry recorded but not held reads, next pass, as removed
 *  here. So the merged view is recorded and applied only by a pass that SAVED (`ok`) while the stores did NOT change (`moved`);
 *  any other pass records this device's own view and applies nothing, and a pass during which they changed runs again.
 *  → { record, apply: the merged view | null (nothing new), again } */
export function settleOf ({ ok, moved, keep, own, prev, same }) {
  const whole = ok === true && !moved
  return { record: whole ? keep : own, apply: whole && !same(prev, keep) ? keep : null, again: !!moved }
}
