// turnFeed.js — what a room says about a running turn, read ONE way for the Spaces app and the SDK (docs/sdk-convergence.md,
// phase 3). Both used to read it separately and drifted: the app hid the status on a stream's `end` frame and on a poll
// that carried none; the SDK did neither, so an Auto "Deciding whether to reply…" that ended in silence stayed on a
// builder's screen. Every rule here is the SERVER's word, never a guess:
//   • text      — the reply so far. A sequence number only moves forward (an out-of-order poll never rewinds what you read).
//   • status    — what the turn is doing before its first word ({ phase } | { tool }, + since).
//   • turn over — a fresh poll with neither (the server keeps a running turn's status in every poll), or a stream `end`.
// It decides; the page draws. Each call returns only what changed: { text?: string|null, status?: object|null, refetch? }
// (a key that is absent means "unchanged"; null means "none any more").
import { isEndFrame } from './streamHint.js'

export const normStep = (s) => (s && typeof s === 'object')
  ? { ...(s.tool ? { tool: String(s.tool) } : { phase: s.phase || 'thinking' }), ...(Number.isFinite(s.since) ? { since: s.since } : {}) }
  : null

export function makeTurnFeed () {
  let seq = -1
  const forward = (q) => { if (!Number.isInteger(q)) return true; if (q < seq) return false; seq = q; return true }
  // A REPLY ALREADY STORED IS NEVER STREAMED AGAIN (the owner, 2026-10-14, a recording: a long answer landed whole and its
  // late stream frames, read as new after the landing reset the order, replayed it in a second bubble — 4ea26b29 fixed the
  // app; the SDK did the same: sync sweep 2026-10-15 #16). Words the stored answer already contains are not a reply in
  // progress. `landed(text)` names it; `sent()` (a new turn, another room) forgets it.
  let stored = ''
  const already = (t) => !!stored && stored.startsWith(String(t).trim().slice(0, 4000))
  return {
    /** A poll answer (spaceClient's shape: partialText / partialStatus / partialSeq / prefetched). */
    poll (r) {
      if (!r || r.status !== 200) return {}
      const text = typeof r.partialText === 'string' ? r.partialText : ''
      if (text) return already(text) ? {} : forward(r.partialSeq) ? { text } : {}
      seq = -1 // no live text: the next turn numbers from the start again
      if (r.partialStatus) {
        // A status is THERE (a turn is running) but may not have opened (spaceClient passes an unreadable one through as
        // the raw string): then it says nothing new — the line keeps its last words, never "the turn is over".
        const st = normStep(r.partialStatus)
        return st ? { text: null, status: st } : { text: null }
      }
      // A push-time prefetch is not a fresh answer — it carries no status by construction, so it says nothing about the turn.
      return r.prefetched ? { text: null } : { text: null, status: null }
    },
    /** A room-stream frame (roomStreamClient): partial / poll / end. */
    stream (ev) {
      if (!ev) return {}
      if (isEndFrame(ev)) return { status: null, end: true } // "no reply in progress" — the finished entry comes by poll
      if (ev.k === 'poll') return { refetch: true }
      if (ev.k !== 'partial') return {}
      if (ev.text) return already(ev.text) ? {} : forward(ev.pseq) ? { text: ev.text } : {}
      if (ev.step) return { status: normStep(ev.step) }
      return {}
    },
    /** The page moved to another room, or the live bubble was superseded by the finished entry. */
    reset () { seq = -1 },
    /** A stored answer landed (a long one: its late frames are dropped). */
    landed (text) { const t = String(text || '').trim(); if (t.length > 40) stored = t },
    /** A new turn was sent, or the page moved to another room: nothing is held back any more. */
    sent () { stored = '' },
  }
}
