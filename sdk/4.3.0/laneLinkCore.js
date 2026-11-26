// spaces/public/laneLinkCore.js — the PURE pieces of lane-to-lane linking (docs/spaces-linked-lanes.md).
//
// No imports, no DOM, no localStorage: framing, the hop counter, and correlation matching are all string/number logic
// so they can be unit-tested directly and reasoned about on their own. The driver (laneLink.js) and the registry
// (roomSync.js) hold the stateful parts.
//
// Everything a cross-lane message needs travels IN ITS TEXT. That is not a shortcut — it is forced: the transcript is
// rebuilt from the sealed ledger on reopen and the server silently drops unknown structured fields
// (notes/new-fields-silently-dropped.md), so a marker in a new field would vanish. The text is also exactly what the
// receiving model reads, so one mechanism serves display, attribution AND correlation.

// A line MIRRORED from the shared room — roomName.isLaneCopy's rule, copied here (this file imports nothing; laneLinkCopy.test
// holds the two equal). An `sh:` id alone is not enough: a recreated lane's CARRIED lines keep theirs (sync sweep backlog).
export const isLaneCopy = (e) => !!e && e.source === 'shared' && String(e.id == null ? '' : e.id).startsWith('sh:') && !(e.carried && typeof e.carried === 'object')

// A lane-to-lane message is framed with a single first line, then a blank line, then the body. The delimiters are
// chosen to be effectively absent from ordinary chat text, so parsing is unambiguous without escaping the body.
const OPEN = '\u27EA lane-link '   // ⟪
const CLOSE = ' \u27EB'            // ⟫
const FRAME_RE = /^\u27EA lane-link ([^\u27EB]*)\u27EB\r?\n\r?\n?/

const esc = (v) => String(v == null ? '' : v).replace(/[\u27EA\u27EB"\n\r]/g, ' ').trim()

/** Build the framing line + body. `from` is the human label of the SENDING lane (what the reader should see), `fromRoom`
 *  its room id (so a lane linked to several others can attribute a reply to the right one — a label is not unique),
 *  `corr` the correlation id, `hop` the count this message carries, `cap` the ceiling so the reader knows its budget.
 *  `kind` is 'ask' (a question awaiting a reply) or 'reply' (the answer being carried back) — the distinction is what
 *  stops a forwarded reply from being mistaken for a new question and ping-ponging. */
export function buildFramed({ from = '', fromRoom = '', corr = '', hop = 0, cap = 0, kind = 'ask', body = '' } = {}) {
  const attrs = [`from="${esc(from)}"`, `fromRoom="${esc(fromRoom)}"`, `corr="${esc(corr)}"`, `hop="${Number(hop) || 0}"`, `cap="${Number(cap) || 0}"`, `kind="${kind === 'reply' ? 'reply' : 'ask'}"`]
  return OPEN + attrs.join(' ') + CLOSE + '\n\n' + String(body == null ? '' : body)
}

/** Parse a framed message. Returns `{ from, fromRoom, corr, hop, cap, kind, body }`, or `null` if the text carries no
 *  framing. `body` is the message with the frame removed, so a renderer can show the words without the machine line. */
export function parseFramed(text) {
  const s = String(text == null ? '' : text)
  const m = FRAME_RE.exec(s)
  if (!m) return null
  const out = { from: '', fromRoom: '', corr: '', hop: 0, cap: 0, kind: 'ask', body: s.slice(m[0].length) }
  for (const a of m[1].split(/\s+/)) {
    const eq = a.indexOf('=')
    if (eq < 0) continue
    const k = a.slice(0, eq), v = a.slice(eq + 1).replace(/^"|"$/g, '')
    if (k === 'hop' || k === 'cap') out[k] = Math.max(0, parseInt(v, 10) || 0)
    else if (k === 'from' || k === 'fromRoom' || k === 'corr') out[k] = v
    else if (k === 'kind') out.kind = v === 'reply' ? 'reply' : 'ask'
  }
  return out
}

/** A fresh correlation id. Prefix keeps it identifiable in logs; the random suffix is what disambiguates. */
export function newCorr() {
  return 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** The hop a message FORWARDED from an incoming one will carry. A human-originated turn is hop 0; every lane-to-lane
 *  forward adds one. So the first cross-lane message carries 1. */
export const nextHop = (incomingHop) => (Math.max(0, Number(incomingHop) || 0)) + 1

/** The hop a NEW ASK (`tell_lane`) should carry, given the asking lane's entries. The turn calling `tell_lane` was
 *  triggered by the lane's last entry: if that is a framed peer message, this ask continues that chain (`hop+1`); if it
 *  is a human (or the lane's own agent) entry, the turn was human-originated and the ask is a fresh hop 1.
 *
 *  This is what makes the cap bound a chain of NEW asks, not only replies carried back. Without it `tell_lane` would
 *  always send hop 1, `canForward` could never bite on the ask leg, and a trigger→ask→trigger cycle would be unbounded
 *  (the exact runaway Decision 4 uses a hop counter to prevent). Inheriting through a reply is deliberate: resetting to
 *  1 after every reply would reopen the hole. */
export function askHopFrom(entries) {
  const list = Array.isArray(entries) ? entries : []
  // the last entry of THIS lane: a line mirrored from the shared room (`sh:` id) is not what triggered the turn, and
  // taking it reset the hop to 1 (sync sweep, 2026-10-11 — findAnswer skips them the same way)
  let last = null
  for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; if (!isLaneCopy(e)) { last = e; break } }
  const p = last && parseFramed(last.text)
  return nextHop(p ? p.hop : 0)
}

/** May a message carrying `hop` still be forwarded, given `cap`? Refuse past the cap rather than forward. A cap of 0
 *  means "no lane-to-lane forwarding at all"; an absent/NaN cap falls back to `defaultCap`. */
/** The built-in hop ceiling when neither the pipe nor the account names one (docs/spaces-linked-lanes.md, Decision 4).
 *  Resolution lives in roomSync.effectiveLaneLaneCap: pipe `cap` → account default → this. */
export const DEFAULT_LANE_LINK_CAP = 3
export function canForward(hop, cap, defaultCap = DEFAULT_LANE_LINK_CAP) {
  const c = Number.isFinite(Number(cap)) && Number(cap) >= 0 ? Number(cap) : defaultCap
  return (Number(hop) || 0) <= c
}

/** Find the reply to a framed question in a lane's entries. `entries` is oldest→newest (the poll's order); `cursor` is
 *  how many entries the device had already seen when it posted, so only entries after it are candidates.
 *
 *  Primary match: an agent entry whose text echoes the correlation id. Fallback: the first agent entry after the
 *  cursor. Returns `{ entry, index, byCorr }` or `null`. `isAgent(e)` decides what counts as a reply (defaults to the
 *  ledger's `self === true`). */
export function matchReply(entries, corr, cursor, isAgent = (e) => e && e.self === true) {
  const list = Array.isArray(entries) ? entries : []
  const start = Math.max(0, Number(cursor) || 0)
  let first = null
  for (let i = start; i < list.length; i++) {
    const e = list[i]
    if (!isAgent(e)) continue
    const txt = String((e && e.text) || '')
    if (corr && txt.includes(corr)) return { entry: e, index: i, byCorr: true }
    if (!first) first = { entry: e, index: i, byCorr: false }
  }
  return first
}

/** The correlation ids of framed QUESTIONS a lane has received since `since`. Only `kind:'ask'` counts: a forwarded
 *  reply is framed too, but it is not a question, and treating it as one would let an answer ping-pong back. A lane's
 *  own agent never writes a frame; only the driver and `tell_lane` do, so any framed ask is inbound by definition. */
export function inboundCorrs(entries, since) {
  const list = Array.isArray(entries) ? entries : []
  const out = []
  for (let i = Math.max(0, Number(since) || 0); i < list.length; i++) {
    if (isLaneCopy(list[i])) continue // mirrored from the shared room: not an ask TO this lane (sync sweep, 2026-10-11) — roomName.isLaneCopy's rule, so a recreated lane's CARRIED lines still count (sync sweep backlog)
    const p = parseFramed(list[i] && list[i].text)
    if (p && p.corr && p.kind === 'ask') out.push({ corr: p.corr, index: i, from: p.from, fromRoom: p.fromRoom, hop: p.hop })
  }
  return out
}

/** Decide what a driver pass should forward for ONE side of a lane-lane pipe. Pure: given the lane's entries, how many
 *  it had already seen (`cursor`), which corrs were already forwarded (`forwarded`), and the pipe's `cap`, return the
 *  messages to send onward and the new cursor.
 *
 *  This is the RETURN leg. `tell_lane` posts the question directly; the driver watches the lane that RECEIVED it and,
 *  when its assistant answers, carries the answer back to the lane that asked. A reply is forwarded when an agent
 *  entry answers an inbound ask that has not been forwarded yet AND its hop is within the cap. Ordinary lane activity
 *  (no ask) is never forwarded — that is what keeps an agent's own final answer to its member from bouncing back, and
 *  it is why the loop is bounded without a cycle detector.
 *
 *  THE CURSOR HOLDS AT THE EARLIEST UNANSWERED QUESTION. A question can be posted in one pass and answered several
 *  passes later; if the cursor advanced past it, the reply — which arrives after it — would never be scanned. So the
 *  cursor stops just before the first unanswered ask, and a later pass picks it up.
 *
 *  Each forward is `{ corr, hop, toRoom, text }`: `toRoom` is the ASKING lane (where the reply goes), and the caller
 *  stamps its OWN lane as the reply's source. Returns `{ forwards, cursor }`. */
export function planForward(entries, cursor, forwarded, cap, isAgent = (e) => e && e.self === true) {
  const list = Array.isArray(entries) ? entries : []
  const cur = Math.max(0, Number(cursor) || 0)
  const done = new Set(Array.isArray(forwarded) ? forwarded : [])
  const forwards = []
  let hold = list.length // where the cursor may advance to
  for (const { corr, hop, index, fromRoom } of inboundCorrs(list, cur)) {
    if (done.has(corr)) continue
    const hit = findAnswer(list, corr, index, isAgent)
    if (!hit) { if (index < hold) hold = index; continue } // unanswered → hold the cursor here
    if (!canForward(nextHop(hop), cap)) { done.add(corr); continue } // past the cap → drop it, never forward
    if (!fromRoom) { done.add(corr); continue } // a legacy frame with no origin → nowhere to send it
    forwards.push({ corr, hop: nextHop(hop), toRoom: fromRoom, text: String(hit.entry.text || '') })
  }
  return { forwards, cursor: hold }
}

/** The answer to the question at `index`. Prefer an agent entry that echoes `corr`; otherwise the FIRST agent entry
 *  after the question, but only when nothing a HUMAN wrote sits between — so a member chatting in the lane while a
 *  question is outstanding cannot have their agent's unrelated reply carried across as the answer. Returns the
 *  matchReply shape, or null when the question is still unanswered. */
export function findAnswer(list, corr, index, isAgent = (e) => e && e.self === true) {
  let firstAgent = null
  for (let i = index + 1; i < list.length; i++) {
    const e = list[i]
    // A line MIRRORED from the shared room (an `sh:` id — roomName.isLaneCopy's rule) is neither this lane's answer nor a
    // human here: it keeps the shared side's `self`, so it read as the answer or as an interruption (sync sweep, 2026-10-11)
    if (isLaneCopy(e)) continue
    if (isAgent(e)) {
      if (String((e && e.text) || '').includes(corr)) return { entry: e, index: i, byCorr: true }
      if (!firstAgent) firstAgent = { entry: e, index: i, byCorr: false }
      continue
    }
    if (parseFramed(e && e.text)) continue // another lane's frame is not a human interruption
    break // a human spoke → the exchange is over; anything later is a new one
  }
  return firstAgent
}

