// spaces/public/prefetchPoll.js — the rules for answering a room's first poll from what the service worker PREFETCHED
// when the push arrived (the owner, 2026-10-02: a tapped notification took over a second to show its message — the
// room was drawn from cache, THEN the server was asked). Pure, so the L1 worker's use of it is testable here.
//   • the worker records the room's position after every successful poll: cnt:<room> = { etag, count }
//   • the push handler asks pollsealed since that count and stores prefetch:<room> = { at, sinceCount, r }
//   • the first poll since then, asking from the SAME count, is answered from `r` (decoded with mk, the same decoder
//     the network path uses) — once; the network is still asked right after, so nothing can go stale.
//   • NO POSITION (2026-10-20 — the owner's phone, protected storage: every push said "no position known", so a tapped message
//     waited 9 s for the network): the push handler asks the room's COUNT, then the last PREFETCH_TAIL entries, and keeps
//     them as a TAIL under a hash of the room (prefetchHashKey — nothing kept under the room's name). The first poll
//     takes the part from ITS position on, when the tail reaches back that far.
export const PREFETCH_MAX_AGE_MS = 15 * 60 * 1000
export const PREFETCH_TAIL = 30

/** Where a TAIL prefetch is kept: a hash of the room, the same in the service worker (sw-notif-core.js wbxPrefetchHashKey). */
export async function prefetchHashKey (room) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wb-prefetch\n' + String(room || ''))))
  return 'prefetch:h:' + Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Is this prefetched answer usable for a poll asking from `sinceCount`? A reason string when not. */
export function prefetchUsable(pf, sinceCount, now = Date.now()) {
  if (!pf || typeof pf !== 'object' || !pf.r || typeof pf.r !== 'object') return 'none'
  if (!Number.isFinite(pf.at) || now - pf.at > PREFETCH_MAX_AGE_MS) return 'stale'
  if (pf.tail) { // a tail covers any position from where it starts to the count it saw
    if (!Number.isInteger(pf.sinceCount) || pf.sinceCount > (sinceCount | 0) || !Number.isInteger(pf.r.count) || (sinceCount | 0) > pf.r.count) return 'position moved'
  } else if (!Number.isInteger(pf.sinceCount) || pf.sinceCount !== (sinceCount | 0)) return 'position moved'
  if (!pf.r.changed || typeof pf.r.sealed !== 'string') return 'nothing new in it'
  return ''
}

/** The position record to keep after a poll answered: null when the answer carries none. */
export function positionOf(result) {
  if (!result || result.status !== 200 || !Number.isInteger(result.version)) return null
  return { etag: typeof result.etag === 'string' ? result.etag : '', count: result.version, at: Date.now() }
}

/** What the push handler stores — or null when the server's answer has nothing worth keeping (bounded in size). */
export function prefetchRecord(j, sinceCount, { maxBytes = 400000, now = Date.now() } = {}) {
  if (!j || !j.changed || typeof j.sealed !== 'string' || j.sealed.length > maxBytes || !Number.isInteger(sinceCount)) return null
  const { notif, ...r } = j // the preview envelope is the notification's business, not the ledger's
  return { at: now, sinceCount, r }
}

/** The stored answer as the client's decoder expects it: the service worker kept the response BODY, and the client's own
 *  fetch path adds `status` from the response — without it `decodeSealed` sees "not 200" and hands the body back undecoded
 *  (the owner's trail, 2026-10-02 19:24: "prefetch: decoded to status undefined"). */
export function prefetchAnswer(pf, sinceCount) {
  let r0 = pf && pf.r && typeof pf.r === 'object' ? pf.r : null
  if (!r0) return null
  if (pf.tail && Number.isInteger(sinceCount) && sinceCount > pf.sinceCount) { // a TAIL: only the entries after the page's position
    let sl = null; try { sl = JSON.parse(r0.sealed) } catch { return null }
    if (!sl || !Array.isArray(sl.boxes) || sl.from !== pf.sinceCount || sinceCount > sl.from + sl.boxes.length) return null
    r0 = { ...r0, sealed: JSON.stringify({ ...sl, boxes: sl.boxes.slice(sinceCount - sl.from), from: sinceCount }), from: sinceCount }
  }
  // A turn's progress is LIVE — never replayed from storage (2026-10-03: a push mid-turn stored "working", and the first
  // poll on return showed "Working on it… 104s" under the finished reply). The entries are what a stored answer is for.
  const { partialStatus, partial, partialSeq, ...r } = r0
  return Number.isInteger(r.status) ? r : { status: 200, ...r }
}
