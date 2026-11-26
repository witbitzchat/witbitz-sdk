// ledgerView.js — merging a poll's entries into a room's list, one way for the Spaces app and the SDK (docs/sdk-convergence.md,
// phase 4d). The server REWRITES entries in place under the same id (a reaction: spaceService op 'react'; an image's
// caption and a reply's widgets: asyncTurn rewriteLedgerEntries). The app applied those; the SDK skipped any id it had seen,
// so a builder's `space.messages` kept the first version and never saw a reaction. Pure — no DOM, no network.
//
// canonId: a mirrored/relinked copy of an entry ('sh:<room>:<id>') is the SAME entry wherever it was mirrored from.
export const canonId = (id) => { const s = String(id == null ? '' : id); const m = /^sh:sp-[^:]+:(.+)$/.exec(s); return m ? 'sh:' + m[1] : s }
/** A message's key — what a reaction targets and a reply quotes (= agent/spaceService.mjs entryKey). One rule for the app and the SDK. */
export const entryKeyOf = (e) => `${canonId(e && e.id)}|${e && e.ts != null ? e.ts : ''}`

// An in-place change moves the etag but pages as NOTHING (the server returns the slice after what you hold), so "changed
// with no new entries" means: re-read a short tail — never adopting its etag, or a reply landing in between is swallowed.
export const REACTION_RESYNC_TAIL = 50
export const needsTailResync = (r, held) => !!(r && r.status === 200 && r.changed && Array.isArray(r.entries) && !r.entries.length && held > 0)

const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false } }

export function makeLedgerView () {
  const list = []; const at = new Map() // canonId → index in list
  return {
    list,
    has: (id) => at.has(canonId(id)),
    /** → { added: [entry], updated: [{ id, entry, prev, fields }] } — entries without an id are always added. */
    apply (entries) {
      const added = []; const updated = []
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!e) continue
        const cid = e.id != null ? canonId(e.id) : null
        if (cid == null || !at.has(cid)) { if (cid != null) at.set(cid, list.length); list.push(e); added.push(e); continue }
        const i = at.get(cid); const prev = list[i]
        if (same(prev, e)) continue
        const fields = [...new Set([...Object.keys(prev), ...Object.keys(e)])].filter((k) => !same(prev[k], e[k]))
        list[i] = e
        updated.push({ id: e.id, entry: e, prev, fields })
      }
      return { added, updated }
    },
  }
}

/** Read a room's WHOLE history across the server's pages (sync sweep, 2026-10-10): a poll answers at most ~4.5 MB and
 *  says `more: true` with `version` = where the next page starts. One read was all the mirror, export and the device carry
 *  ever did, so a long room's later history never crossed. `read(sinceCount)` → a poll answer. Returns the FIRST answer
 *  with every page's entries; a page that fails stops the walk and marks the result `incomplete` (not `partial`, which
 *  on a poll is the reply being written). */
export async function readAllPages (read, { maxPages = 400 } = {}) {
  let first = await read(0).catch(() => null)
  // an EMPTY room answers 200 changed:false with no entries — a whole, empty history, not a failed read (sync sweep,
  // 2026-10-10: a move of an empty room failed as history_incomplete)
  if (first && first.status === 200 && first.changed === false && !Array.isArray(first.entries)) first = { ...first, entries: [] }
  // a FIRST read that failed is not an empty room: say so, as a later page's failure does (sync sweep, 2026-10-10)
  if (!first || !Array.isArray(first.entries) || (first.status && first.status !== 200)) return { ...(first || {}), entries: (first && Array.isArray(first.entries)) ? first.entries : [], incomplete: true }
  const entries = [...first.entries]
  let p = first
  for (let i = 1; i < maxPages && p && p.more; i++) {
    const since = Number(p.version)
    if (!Number.isFinite(since) || since <= 0) break
    const next = await read(since).catch(() => null)
    if (!next || !Array.isArray(next.entries) || (next.status && next.status !== 200)) return { ...first, entries, incomplete: true }
    entries.push(...next.entries); p = next
  }
  if (p && p.more) return { ...first, entries, incomplete: true } // stopped at maxPages with pages still to come: not the whole history (sync sweep, 2026-10-10)
  return { ...first, entries, more: false }
}
