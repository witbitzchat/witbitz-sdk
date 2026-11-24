// Export / recreate a Space (this file is the description — there is no separate doc). EXPORT decrypts the FULL ledger + the agent config into a portable,
// human-readable JSON — for debugging, a plaintext backup, and recreating the room elsewhere. RECREATE mints a fresh
// room from such a bundle (its config) and replays the entries (mirror, server-deduped by id). Unlike the sealed offline
// backup (offlineBundle.js), this file is DECRYPTED cleartext — treat it exactly like the conversation it contains.
const EXPORT_KIND = 'witbitz-space-export'

// Build a decrypted snapshot of a room: { v, kind, room, title, exportedAt, count, config?, entries }.
// entries = the COMPLETE ledger (poll with sinceCount=0 returns all of it, decrypted). config is best-effort.
// READER, not (mk, client). The export is now assembled ENTIRELY IN L1: `reader` is the l1 façade, so the ledger is
// polled and the config read by the realm that HOLDS mk, and only plaintext comes back. The app never needs the key.
//
// That is what finally fixes this. The old signature forced the caller to produce mk in the app realm, which under
// mk-confinement it does not have — and the three attempts to find it there each failed differently: `recallMk` (the
// main thread has none), then `awaitVaultKey` (the vault answers from a page-level keyring that a worker-remembered
// key never reaches). Asking the holder to do the work removes the question instead of answering it.
//
// `reader` needs exactly two methods, both already l1 ops: poll(room, undefined, 0) and getConfig(room).
import { readAllPages } from './ledgerView.js'
export async function exportSpace(room, reader, meta = {}) {
  if (!room || !reader || typeof reader.poll !== 'function') throw new Error('bad_args')
  const p = await readAllPages((since) => reader.poll(room, undefined, since)) // the whole history, every page
  // A page that failed would make a SHORT export look whole: refuse it, so the person tries again (sync sweep, 2026-10-10).
  if (p && p.incomplete) throw Object.assign(new Error('export_incomplete'), { userMsg: 'Part of this Space’s history couldn’t be read — try the export again.' })
  const raw = p && Array.isArray(p.entries) ? p.entries : []
  // Collapse fork/relink mirror duplicates by canonical id (a fork changes the `sh:<sharedRoom>:` prefix), so an export
  // matches what's shown in-app and a recreate doesn't carry doubles — even if the server ledger hasn't been collapsed yet.
  const canon = (id) => { const s = String(id == null ? '' : id); const m = /^sh:sp-[^:]+:(.+)$/.exec(s); return m ? 'sh:' + m[1] : s }
  const seenC = new Set()
  const entries = raw.filter((e) => { if (!e || e.id == null) return true; const c = canon(e.id); if (seenC.has(c)) return false; seenC.add(c); return true })
  let config = null
  try { config = typeof reader.getConfig === 'function' ? await reader.getConfig(room) : null } catch { /* config is best-effort — a ledger-only export is still useful */ }
  const withBytes = typeof reader.blob === 'function' ? await Promise.all(entries.map((e) => inlineAttachments(e, room, reader))) : entries
  // DIAGNOSTICS (the owner, 2026-10-04, after a members sheet nobody could explain from the file: "add more info to the
  // export"). The guest book and the server's sign-in records are what the members sheet is built from; the authors
  // summary says which keys each name posted under; `device` is what the exporting device holds (public keys only).
  let guestBook = null
  try {
    const g = typeof reader.state === 'function' ? await reader.state(room, 'roster') : null
    if (g && (g.state || g.seen)) guestBook = { people: (g.state && Array.isArray(g.state.people)) ? g.state.people : [], ...(g.seen ? { seen: g.seen } : {}) }
  } catch { /* best-effort, like the config */ }
  return {
    v: 1, kind: EXPORT_KIND, room, title: meta.title || '', exportedAt: meta.now || Date.now(), count: entries.length,
    ...(meta.device ? { device: meta.device } : {}),
    ...(config ? { config } : {}),
    ...(guestBook ? { guestBook } : {}),
    authors: authorsOf(entries),
    entries: withBytes,
  }
}

const keyIdOf = (k) => (k && k.x && k.y ? k.x.slice(0, 8) + '…' : '')
/** Per author: how many entries, under which signing keys, verified or not, the attested @username, first/last time. */
export function authorsOf(entries = []) {
  const by = new Map()
  for (const e of entries) {
    if (!e || e.self) continue
    const name = String(e.name || e.from || (e.kind === 'agent' ? 'agent' : '?'))
    const a = by.get(name) || { name, kinds: {}, entries: 0, verified: 0, keys: [], first: e.ts || 0, last: e.ts || 0 }
    a.entries++; if (e.verified === true) a.verified++
    a.kinds[e.kind || 'text'] = (a.kinds[e.kind || 'text'] || 0) + 1
    if (e.user && !a.user) a.user = e.user
    const k = keyIdOf(e.spk || e.vspk); if (k && !a.keys.includes(k)) a.keys.push(k)
    if (e.ts) { a.first = Math.min(a.first || e.ts, e.ts); a.last = Math.max(a.last, e.ts) }
    by.set(name, a)
  }
  return [...by.values()]
}

// An export is the WHOLE conversation, attachments included. A photo or document stored OUT OF LINE is a pointer in its
// entry (`ref` / `parts`) to a blob sealed to THIS room's key — useless in a file, and useless to a recreated room (a new
// key). So the export carries the bytes inline (reader.blob = the l1 op that opens a blob), and a recreate's mirror
// stores them out of line again under the new room. Best-effort per attachment: one that will not open keeps its pointer.
const isStored = (a) => !!a && !(typeof a.b64 === 'string' && a.b64) && ((typeof a.ref === 'string' && !!a.ref) || (Array.isArray(a.parts) && a.parts.length > 0))
async function inlineAttachments(e, room, reader) {
  if (!e || typeof e !== 'object') return e
  const out = { ...e }
  for (const k of ['images', 'files']) {
    if (!Array.isArray(e[k]) || !e[k].some(isStored)) continue
    out[k] = await Promise.all(e[k].map(async (a) => {
      if (!isStored(a)) return a
      try {
        const refs = Array.isArray(a.parts) && a.parts.length ? a.parts : [a.ref] // empty parts → `ref`, media.js's rule (sync sweep, 2026-10-10)
        if (!refs[0]) return a
        const parts = await Promise.all(refs.map((ref) => reader.blob(room, ref)))
        if (parts.some((p) => !p || p.status !== 200 || typeof p.b64 !== 'string' || !p.b64)) return a
        const { ref, parts: _p, size, ...rest } = a
        return { ...rest, b64: parts.map((p) => p.b64).join(''), mime: a.mime || parts[0].mime || 'application/octet-stream' }
      } catch { return a }
    }))
  }
  return out
}

export function isExport(bundle) { return !!bundle && bundle.kind === EXPORT_KIND && Array.isArray(bundle.entries) }

// Recreate a room from an export: mint a NEW room carrying the exported agent config, then replay the entries. Injected
// `createSpace(config) → { room, mk }` and `mirror(room, mk, entries)` keep this decoupled from the app's create wiring
// (and testable). The new room gets a fresh key — the export's room id/key are NOT reused (a clone, not the same room).
// A whole history goes to op 'mirror' in SLICES, as the lane mirror (mirrorLoop.js) and the SDK do: one request with every
// entry — attachment bytes included — went over the request limit on a long room (sync sweep, 2026-10-10). A slice the
// server refuses STOPS the copy (later slices would leave a hole in the middle) and the count says how far it got; it
// never throws, so a fork that already minted its room still finishes.
export const MIRROR_BATCH = 25
export async function mirrorInBatches(mirror, room, mk, entries) {
  let sent = 0
  for (let i = 0; i < entries.length; i += MIRROR_BATCH) {
    const slice = entries.slice(i, i + MIRROR_BATCH)
    let r; try { r = await mirror(room, mk, slice) } catch { break }
    if (r && typeof r.status === 'number' && r.status !== 200) break
    sent += slice.length
  }
  return sent
}

export async function recreateSpace(bundle, { createSpace, mirror }) {
  if (!isExport(bundle)) throw new Error('bad_export')
  const made = await createSpace(bundle.config || {})
  if (!made || !made.room || !made.mk) throw new Error('create_failed')
  // A "room moved" notice (kind 'fork') is a forwarding address of the OLD room's history — every other copy path drops
  // it, or the new room's poll follows a stale move (spaceFork.js; sync sweep, 2026-10-10).
  // Rows ride as DATA (`carry: 'fork'`, as spaceFork.js marks them), so the new room's store holds the same rows.
  const entries = bundle.entries.filter((e) => e && e.kind !== 'fork').map((e) => (e.kind === 'data' && Array.isArray(e.ops) ? { ...e, carry: 'fork' } : e))
  const carried = entries.length ? await mirrorInBatches(mirror, made.room, made.mk, entries) : 0
  return { ...made, carried, total: entries.length }
}
