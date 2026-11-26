// spaces/public/sdkLaneLink.js — `lane.link(other)`: one member's two private assistants ask each other (2026-10-03,
// the owner: "Build the lane links"). The SDK twin of the app's linked lanes (https://witbitz.chat/docs/sdk-agents.md#lane-links; laneLink.js),
// on the SAME pure core (laneLinkCore.js: the frame, the hop counter, which answer goes back), so the two cannot drift.
//
// ENTIRELY ON THE DEVICE, as the design decided: the device holds both lanes' keys, so it is the only thing that can
// bridge them, and the server never joins two rooms. Two legs, one primitive (post into a lane + wake its assistant):
//   • OUT — the asking assistant calls `tell_lane` (an `await` action: this device answers it within the turn). The
//     device frames the question, posts it into the other lane and wakes that lane's assistant, then answers the tool
//     AT ONCE: the exchange is asynchronous, never a blocking wait (Decision 2).
//   • BACK — the device watches the lane that was asked; when its assistant answers, planForward() picks the answer and
//     the device carries it back framed as a reply and wakes the asking assistant, which relays it to the member.
// The hop cap bounds BOTH legs (Decision 4): an ask continues the chain of the message that triggered it, so a loop of
// assistants asking each other stops at the cap. Default 3; `cap: 0` = no lane-to-lane traffic.
// ⚑ It runs while both lanes are OPEN on this device (the app's driver is "app-open only" too). `link.state` carries the
//   cursors; pass it back as `resume` to pick up an exchange that was in flight when the page closed.
import { buildFramed, parseFramed, newCorr, askHopFrom, canForward, planForward, DEFAULT_LANE_LINK_CAP } from './laneLinkCore.js'

const GUIDANCE =
  'You can ask the member\'s OTHER linked assistants a question with tell_lane. It is ASYNCHRONOUS: tell_lane posts ' +
  'your question and returns immediately — the other assistant\'s answer arrives here later as a new message, and you ' +
  'will be asked to relay it to the member then. So do NOT wait for the answer inside this turn and never invent one; ' +
  'just send the question and tell the member you have asked. Keep the question self-contained — the other assistant ' +
  'cannot see this conversation, only what you put in `message`.'
const DEFAULT_LABEL = 'linked assistant'
// How long a post into the other lane may take. A turn returns only AFTER its reply (the send IS the turn), so 10 s read
// every slower reply as "not delivered" — tell_lane told the model "busy" and a pass forwarded the same reply again (sync
// sweep, 2026-10-10). Now just past the server's turn budget (240 s), as the app waits for the turn's answer itself.
const WAKE_WAIT_MS = 280_000
const ASK_WAIT_MS = 6_000 // tell_lane: a refusal or a busy answer comes back at once; past this the question is in

const fail = (code, msg) => Object.assign(new Error('witbitz: ' + msg), { code })
const isAgent = (e) => !!(e && e.self === true)

/** The peers of `lane`, labelled the way its model sees them: [{ label, link, peer }]. Twins are suffixed ("… (2)"), and
 *  the tool's enum and its executor both read THIS list, so the name the model picks can never resolve to another lane
 *  (the app's linkedLaneChoices rule). */
export function peersOf(lane) {
  const seen = new Map(), out = []
  for (const link of (lane._laneLinks || [])) {
    if (link._dead) continue
    const side = link._sideOf(lane)
    const base = side.to || DEFAULT_LABEL
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    out.push({ label: n === 1 ? base : `${base} (${n})`, link, peer: side.other })
  }
  return out
}

/** The `tell_lane` def + guidance this lane's turns carry, or null when it has no live link. */
export function laneLinkTool(lane) {
  const peers = peersOf(lane)
  if (!peers.length) return null
  return {
    def: {
      name: 'tell_lane',
      mode: 'await',
      description:
        'Ask one of the member\'s OTHER linked assistants a question, on their behalf. `lane` is which assistant to ask; ' +
        '`message` is the full question (the other assistant sees ONLY this — include everything it needs). ' +
        'ASYNCHRONOUS: this returns immediately; the answer arrives later as a new message, and you relay it to the ' +
        'member then. Never wait for it or make one up.',
      inputSchema: { type: 'object', properties: { lane: { type: 'string', enum: peers.map((p) => p.label), description: 'Which linked assistant to ask.' }, message: { type: 'string', description: 'The complete question to ask it.' } }, required: ['lane', 'message'] },
    },
    guidance: GUIDANCE,
  }
}

// Post a framed message into `lane` and wake its assistant ('always', whatever the lane's reply mode). True once the
// lane ACCEPTED it; a lane still busy past WAKE_WAIT_MS reads as not delivered, and the caller retries / reports it.
// `ask: true` = tell_lane's post, answered within the SERVER's device-call limit (25 s, spaceRoom.mjs): it waits ASK_WAIT_MS
// for a quick refusal, then counts the question as sent and lets the turn run on — the answer comes back through the
// link's pass, as the tool says (sync sweep, 2026-10-10: waiting for the whole reply ran past the limit).
async function postAndWake(lane, text, from, { ask = false } = {}) {
  // Given up = given up (sync sweep, 2026-10-10): a pass's send still held for "busy" is not resent after the wait (the
  // pass retries it, and a second copy would forward twice); and `from` is the LINK's label, never the member's name.
  let timedOut = false
  try {
    const sent = lane.send(text, { from, mode: 'always', ...(ask ? { _noHold: true } : { _aborted: () => timedOut }), _linkPost: true })
    const r = await Promise.race([sent, new Promise((res) => setTimeout(() => { timedOut = true; res(null) }, ask ? ASK_WAIT_MS : WAKE_WAIT_MS))])
    if (r === null && ask) { sent.catch(() => {}); return true } // still running: the question is in, the turn is answering it
    return !!(r && r.status === 200 && !r.busy && r.ok !== false)
  } catch { return false }
}

export class LaneLink {
  constructor(a, b, { to, as, cap, resume } = {}) {
    this.a = a; this.b = b
    // `to`: what A's assistant calls B; `as`: what B's assistant calls A.
    this._labels = { a: String(to || DEFAULT_LABEL).slice(0, 60), b: String(as || DEFAULT_LABEL).slice(0, 60) }
    this.cap = Number.isFinite(Number(cap)) && Number(cap) >= 0 ? Math.floor(Number(cap)) : DEFAULT_LANE_LINK_CAP
    const r = resume && typeof resume === 'object' ? resume : {}
    // Cursor per side: how many of that lane's messages the link has already judged. null = not seen yet → set to the
    // lane's length at first sight, so linking never forwards history (the app's no-backfill rule).
    this._cur = { a: Number.isFinite(r.cursorA) ? r.cursorA : null, b: Number.isFinite(r.cursorB) ? r.cursorB : null }
    this._sent = { a: Array.isArray(r.sentA) ? r.sentA.slice(-200) : [], b: Array.isArray(r.sentB) ? r.sentB.slice(-200) : [] }
    this._dead = false
    this._busy = false
    this._again = false
    this._t = null
    this._subA = () => this._schedule()
    this._subB = () => this._schedule()
    a.on('message', this._subA); b.on('message', this._subB)
    for (const l of [a, b]) {
      l._laneLinks = [...(l._laneLinks || []), this]
      l._reads.tell_lane = (args) => tellLane(l, args)
    }
    Promise.all([a.ready, b.ready].map((p) => Promise.resolve(p).catch(() => {}))).then(() => this._schedule())
  }

  /** The progress to persist (JSON-safe) — hand it back as `link(other, { resume })` after a reload. */
  get state() { return { cursorA: this._cur.a, cursorB: this._cur.b, sentA: this._sent.a.slice(), sentB: this._sent.b.slice() } }

  /** End the link: neither assistant is offered the other any more. */
  unlink() { this._stop(); if (this._onUnlink) { try { this._onUnlink() } catch { /* the account record */ } } }

  // Stop on THIS device without ending the link in the account (a lane closing).
  _stop() {
    if (this._dead) return
    this._dead = true
    clearTimeout(this._t)
    for (const [l, sub] of [[this.a, this._subA], [this.b, this._subB]]) {
      const subs = l._subs && l._subs.message
      if (subs) { const i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1) }
      l._laneLinks = (l._laneLinks || []).filter((x) => x !== this)
    }
  }

  /** Run one pass now (it also runs on its own whenever either lane gets a message). */
  async run() { return this._pass() }

  _sideOf(lane) { return lane === this.a ? { key: 'a', other: this.b, to: this._labels.a, as: this._labels.b } : { key: 'b', other: this.a, to: this._labels.b, as: this._labels.a } }
  _schedule() { if (this._dead) return; clearTimeout(this._t); this._t = setTimeout(() => { this._pass().catch(() => {}) }, 120) }

  // BACK LEG, both directions: for each lane, the answers its assistant gave to questions it was asked go to the asker.
  async _pass() {
    if (this._dead) return { forwarded: 0 }
    if (this._busy) { this._again = true; return { forwarded: 0 } }
    this._busy = true
    let forwarded = 0
    try {
      for (const lane of [this.a, this.b]) {
        const side = this._sideOf(lane)
        if (lane._more || !(lane._historyRead || lane._hostDriven)) continue // the lane's 'message' events re-run the pass as its history arrives — no timer here (a history that never completes spun one every 120 ms; sync sweep, 2026-10-10) // not yet the WHOLE history (a page still to come, or one that failed — `_more` alone stops being true then; sync sweep, 2026-10-10) // still reading its pages: a cursor set (or a plan made) on part of the history would forward old asks again (sync sweep, 2026-10-10)
        const entries = lane.messages || []
        if (this._cur[side.key] == null) { this._cur[side.key] = entries.length; continue } // first sight: no backfill
        const { forwards, cursor } = planForward(entries, this._cur[side.key], this._sent[side.key], this.cap, isAgent)
        let allOk = true
        for (const f of forwards) {
          if (f.toRoom !== side.other.room) { this._sent[side.key].push(f.corr); continue } // asked by a lane this link does not hold
          // The reply is labelled with how the ASKER knows this lane.
          // Already there (state machines pass 7, L#8): a post that LANDED but whose answer was lost (a 5xx, a timeout) kept
          // the corr out of `sent`, and another device with this link open keeps its own `sent` — both carried the same
          // answer back again. The asking lane is the record: a framed reply with this corr in it is a forward done.
          if ((side.other.messages || []).some((e) => { const p = parseFramed(e && e.text); return p && p.kind === 'reply' && p.corr === f.corr })) { this._sent[side.key].push(f.corr); continue }
          const framed = buildFramed({ from: side.as, fromRoom: lane.room, corr: f.corr, hop: f.hop, cap: this.cap, kind: 'reply', body: f.text })
          if (await postAndWake(side.other, framed, side.as)) { this._sent[side.key].push(f.corr); forwarded++ } else allOk = false
        }
        this._sent[side.key] = this._sent[side.key].slice(-200)
        if (allOk) this._cur[side.key] = cursor // a failed forward holds the cursor, and `sent` keeps the rest from repeating
      }
    } finally {
      this._busy = false
      if (this._again && !this._dead) { this._again = false; this._schedule() }
    }
    return { forwarded }
  }
}

/** OUT LEG: the `tell_lane` handler on `lane` — the device answers the turn at once with what happened. */
async function tellLane(lane, args) {
  const want = String((args && args.lane) || '').trim()
  const hit = peersOf(lane).find((p) => p.label === want)
  if (!hit) return { ok: false, error: 'No linked assistant by that name.' }
  const { link, peer } = hit
  const side = link._sideOf(lane)
  // The ask continues the chain of the message that triggered this turn (a framed peer message → hop+1, else hop 1).
  // the LAST message decides the hop: on part of the history it is a guess that could reset the cap — the app refuses too (sync sweep, 2026-10-11)
  if (lane._more || !(lane._historyRead || lane._hostDriven)) return { ok: false, error: 'Couldn’t read this conversation just now — try again in a moment.' }
  const hop = askHopFrom(lane.messages || [])
  if (!canForward(hop, link.cap)) return { ok: false, error: `This request has crossed too many lanes already (limit ${link.cap}) — answering here instead of asking on.` }
  const corr = newCorr()
  const framed = buildFramed({ from: side.as, fromRoom: lane.room, corr, hop, cap: link.cap, kind: 'ask', body: String((args && args.message) || '') })
  if (link._cur[link._sideOf(peer).key] == null) {
    // the cursor pins at the end of the peer's WHOLE history — on part of it, the pass after the ask would forward older
    // messages as if they answered it (the app reads every page first; sync sweep 10-12)
    if (peer._more || !(peer._historyRead || peer._hostDriven)) return { ok: false, error: `Couldn’t read ${hit.label}’s conversation just now — try again in a moment.` }
    link._cur[link._sideOf(peer).key] = (peer.messages || []).length // the question lands after this point
  }
  const ok = await postAndWake(peer, framed, side.as, { ask: true })
  return ok
    ? { ok: true, corr, message: `Sent to ${hit.label}. Its answer will arrive here shortly.` }
    : { ok: false, error: `${hit.label} is busy right now — try again in a moment.` }
}

/** `a.link(b, opts)` — checks, then the link. Lanes of ANY kind (the owner, 2026-10-11): this client copies the words
 *  between them itself; no room's key is handed to the other's tier. */
export function linkLanes(a, b, opts = {}, { tierMismatch } = {}) {
  if (!b || typeof b.send !== 'function' || !b.room) throw fail('not_a_lane', 'link takes another Lane (from privateLane or openLane)')
  if (b === a || b.room === a.room) throw fail('self_link', 'a lane cannot be linked to itself')
  if ((a._laneLinks || []).some((l) => !l._dead && (l.a === b || l.b === b))) throw fail('already_linked', 'these two lanes are already linked')
  return new LaneLink(a, b, opts)
}

export { parseFramed }
