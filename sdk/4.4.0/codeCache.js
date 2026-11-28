// spaces/public/codeCache.js — the Code section's OFFLINE CACHE: the sessions you have opened, kept device-local so the
// page can show them when the computer is asleep, unpaired, or you have no network at all. The owner, 2026-09-17, after
// the Spaces airplane-mode work: "Can we make the code sessions also cache".
//
// The Code section was entirely LIVE until now — every session list and every message came off the sealed relay, so a
// computer that was not answering left the page with nothing to draw. Rooms have had this since the beginning
// (chatCache.js); this is the same idea with one difference that matters: a code transcript is far bigger than a chat.
// A single session can carry megabytes of tool output and diffs, so what is kept is capped three ways — messages per
// session, bytes per session (oldest trimmed first), and sessions per computer — and the cache is written from what the
// page ALREADY holds in memory, never by asking the computer for more.
//
// What is stored is what the page was already showing: the connector withholds secret-looking files and oversized
// patches before they ever reach the phone (codeRelay.js projectResponse), so nothing new crosses that line by being
// remembered. It is plaintext at rest on YOUR device, the same trust boundary as the room chat cache, and it is dropped
// with the rest of the app's storage on sign-out.
import { idb } from './idb.js'

const SESS = (cid, sid) => `code:sess:${cid}:${sid}`
const LIST = (cid) => `code:list:${cid}`
export const codeSessKey = SESS
export const codeListKey = LIST

export const MAX_MSGS = 150            // a long turn is a few dozen messages; 150 covers a working day of one session
export const MAX_BYTES = 1_200_000     // ~1.2 MB of JSON per session: enough for real transcripts, small enough to write often
export const MAX_SESSIONS = 20         // per computer, by last use — the history sheet shows far fewer than this
export const MAX_OUTPUT = 24_000       // per tool output / patch kept on the device

// A step's output and its patch are the heavy part, by a wide margin: codeHistory.js measured ONE real session at
// 9.7 MB over 136 messages, with a single message carrying 2.5 MB of tool output. Keeping the head of each is what
// makes a whole transcript fit — you can still read what ran and how it started, and the live copy has the rest
// whenever the computer is there. The cut is marked so the step sheet can say so rather than imply the output ended.
const clip = (s) => (typeof s === 'string' && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) : s)
export function trimMessage(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.parts)) return m
  let touched = false
  const parts = m.parts.map((p) => {
    const st = p && p.state
    const md = st && st.metadata
    const big = (v) => typeof v === 'string' && v.length > MAX_OUTPUT
    if (!st || !(big(st.output) || (md && (big(md.output) || big(md.diff) || (md.filediff && big(md.filediff.patch)))))) return p
    touched = true
    const next = { ...p, state: { ...st } }
    if (big(st.output)) next.state.output = clip(st.output)
    if (md) {
      next.state.metadata = { ...md, wbClipped: true }
      if (big(md.output)) next.state.metadata.output = clip(md.output)
      if (big(md.diff)) next.state.metadata.diff = clip(md.diff)
      if (md.filediff && big(md.filediff.patch)) next.state.metadata.filediff = { ...md.filediff, patch: clip(md.filediff.patch) }
    } else next.state.metadata = { wbClipped: true }
    return next
  })
  return touched ? { ...m, parts } : m
}

/** Clip each message's heavy parts, then drop messages from the FRONT until the whole thing fits: the newest are the
 *  ones worth keeping. */
export function trimMessages(msgs, { maxMsgs = MAX_MSGS, maxBytes = MAX_BYTES } = {}) {
  let out = (Array.isArray(msgs) ? msgs.slice(-maxMsgs) : []).map(trimMessage)
  while (out.length > 1) {
    let size = 0
    try { size = JSON.stringify(out).length } catch { return out.slice(-10) } // circular/exotic → keep a token tail
    if (size <= maxBytes) break
    out = out.slice(Math.max(1, Math.ceil(out.length * 0.15))) // 15% off the front per pass, so a huge tail converges fast
  }
  return out
}

/** Remember one session's transcript. `msgs` is the page's own message array; meta rides along for the list row. */
export async function saveSession(cid, sid, msgs, meta = {}, store = idb) {
  if (!cid || !sid) return
  const kept = trimMessages(msgs)
  if (!kept.length) return
  await store.set(SESS(cid, sid), { msgs: kept, at: Date.now(), trimmed: Array.isArray(msgs) && kept.length < msgs.length, ...meta })
}

/** → { msgs, at, trimmed, … } or null. */
export async function clearSession(cid, sid, store = idb, strict = false) {
  if (strict && cid && sid && store.delStrict) { await store.delStrict(SESS(cid, sid)); return }
  if (cid && sid) await store.del(SESS(cid, sid))
}

export async function removeCachedSession(cid, sid, store = idb, local) {
  await clearSession(cid, sid, store, true)
  const saved = await loadList(cid, store)
  if (saved?.list.some(row => row.id === sid)) {
    await saveList(cid, saved.list.filter(row => row.id !== sid), store, { allowEmpty: true })
    if ((await loadList(cid, store))?.list.some(row => row.id === sid)) throw new Error('The cached session directory could not be updated')
  }
  const raw = local?.getItem('oc.list')
  if (!raw) return
  const directory = JSON.parse(raw)
  const entry = directory?.entries?.find(e => e.key === cid)
  if (entry?.sessions?.some(row => row.id === sid)) {
    entry.sessions = entry.sessions.filter(row => row.id !== sid)
    local.setItem('oc.list', JSON.stringify(directory))
  }
}

export async function loadSession(cid, sid, store = idb) {
  if (!cid || !sid) return null
  const c = await store.get(SESS(cid, sid))
  return c && Array.isArray(c.msgs) && c.msgs.length ? c : null
}

/** The session LIST as the computer last gave it, so the history sheet has something to show when it is away. */
export async function saveList(cid, list, store = idb, { allowEmpty = false } = {}) {
  if (!cid || !Array.isArray(list) || (!list.length && !allowEmpty)) return // never write an empty list over a good one
  await store.set(LIST(cid), { list: list.slice(0, 200), at: Date.now() })
}

export async function loadList(cid, store = idb) {
  if (!cid) return null
  const c = await store.get(LIST(cid))
  return c && Array.isArray(c.list) ? c : null
}

/** Which sessions this device is holding for a computer, newest first: [{ id, at, msgs, title, dir }]. Enough to draw a
 *  drawer row from, so the list survives even when the list itself was never saved. */
export async function cachedSessions(cid, store = idb) {
  if (!cid) return []
  const pfx = `code:sess:${cid}:`
  const rows = await store.entries(pfx)
  return rows
    .map(([k, v]) => ({ id: k.slice(pfx.length), at: (v && v.at) || 0, msgs: (v && Array.isArray(v.msgs) && v.msgs.length) || 0, title: (v && v.title) || '', dir: (v && v.dir) || '' }))
    .sort((a, b) => b.at - a.at)
}

/** Keep the newest MAX_SESSIONS per computer. Called after a save — cheap, and it bounds a year of use. */
export async function prune(cid, keep = MAX_SESSIONS, store = idb) {
  const all = await cachedSessions(cid, store)
  for (const s of all.slice(keep)) await store.del(SESS(cid, s.id))
  return all.length - Math.min(all.length, keep)
}

/** Forget one computer entirely (unpaired / removed) — its transcripts have no other home to belong to. */
export async function forgetComputer(cid) {
  if (!cid) return
  await idb.delPrefix(`code:sess:${cid}:`)
  await idb.del(LIST(cid))
}

export function slimSession(x) {
  const o = { id: x.id }
  for (const f of ['title', 'slug', 'directory', 'path', 'parentID', 'agent', 'projectID']) if (typeof x[f] === 'string') o[f] = x[f]
  const t = x.time || {}
  o.time = {}
  for (const f of ['created', 'updated', 'archived']) if (typeof t[f] === 'number') o.time[f] = t[f]
  return o
}
