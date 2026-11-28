// codeHistory: a conversation's messages without re-reading all of them (the owner: "When I change code sessions it
// reloads every time. Can't it be cached somehow? … only the last part of the conv, and when scrolled back gets the past
// context. A lazy load will also be fine.").
//
// Measured on opencode 1.18.30 (the owner's computer, 2026-09-14):
//   • GET /session/:id/message sent the WHOLE history: "Witbitz 1" was 9,753,679 bytes (136 messages; one message alone
//     2.5 MB of tool output) — through the relay to a phone on every switch, and again after EVERY step of a turn.
//   • `?limit=N` returns the LAST N messages (the last 20 of that session: 206 KB), oldest first, with an `x-next-cursor`
//     header and `Link: …&before=<cursor>; rel="next"` for the page before them. `before=<message id>` is refused (400).
//   • The cursor is base64url(JSON {"id": <oldest message id>, "time": <its info.time.created>}) — built here it equals
//     the header byte for byte, and walking back 40 at a time returned all 136 messages in order, none twice. The relay
//     does not forward response headers, so the page builds it itself.
// The page keeps a window: the newest messages, plus whatever older pages were scrolled into, per session in memory.

// Sizes from the owner's longest conversation: its newest 30 messages were 1,325 KB, 20 → 206 KB, 8 → 34 KB, 4 → 20 KB
// (tool output makes recent messages heavy). A turn's step needs only what changed since the last read.
export const TAIL = 20 // messages read when a conversation opens
export const STEP_TAIL = 6 // messages re-read after each step of a running turn (more is read only when they do not overlap)
export const PAGE = 20 // messages read each time you scroll back past the top
export const CACHED_SESSIONS = 8

const b64url = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** The cursor for the page BEFORE `message` (the oldest one you hold) — '' when it cannot be built. */
export function cursorBefore(message) {
  const info = (message && message.info) || {}
  const time = info.time && Number(info.time.created)
  if (typeof info.id !== 'string' || !info.id || !Number.isFinite(time)) return ''
  return b64url(JSON.stringify({ id: info.id, time }))
}

/** The query for the newest `limit` messages, or the `limit` before `cursor`. */
export const pageQuery = ({ limit = TAIL, cursor = '' } = {}) => `limit=${limit}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`

/** Did a page come back full, i.e. may there be more before it? */
export const mayHaveMore = (page, limit) => Array.isArray(page) && page.length >= limit

/**
 * Fold a freshly read TAIL into the messages you hold. The tail's oldest message is found in yours, and everything from
 * there on is taken from the server (a step's parts grew, a message was added — or removed by an undo that went final).
 * No overlap (more new messages than one tail, e.g. after a long time offline): `overlap:false` — the caller reads further
 * back, or starts a new window.
 */
export function mergeTail(current, tail) {
  const cur = Array.isArray(current) ? current : []
  if (!Array.isArray(tail)) return { messages: cur, overlap: true }
  if (!tail.length) return { messages: [], overlap: true } // the server holds none: the conversation is empty
  const at = cur.findIndex((m) => m && m.info && m.info.id === tail[0].info.id)
  if (at < 0) return { messages: tail, overlap: false }
  return { messages: [...cur.slice(0, at), ...tail], overlap: true }
}

/** An older page in front of the messages you hold, without a message twice. */
export function prependOlder(current, older) {
  const cur = Array.isArray(current) ? current : []
  const have = new Set(cur.map((m) => m && m.info && m.info.id))
  return [...(older || []).filter((m) => m && m.info && !have.has(m.info.id)), ...cur]
}

/** Per-session windows, the most recently used kept. { messages, cursor } — cursor '' once the start is reached. */
export class HistoryCache {
  constructor(max = CACHED_SESSIONS) { this.max = max; this.map = new Map() }
  get(sid) {
    const v = this.map.get(sid)
    if (v) { this.map.delete(sid); this.map.set(sid, v) }
    return v || null
  }
  set(sid, value) {
    if (!sid) return
    this.map.delete(sid)
    this.map.set(sid, value)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
  }
  drop(sid) { this.map.delete(sid) }
  clear() { this.map.clear() }
}
