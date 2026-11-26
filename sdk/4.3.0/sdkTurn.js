// sdkTurn.js — a turn you can hold (https://witbitz.chat/docs/sdk-roadmap.md, item 6, 2026-10-05).
//
// `space.send()` keeps the room's semantics: it posts a message, and whatever the room does next (the assistant replies,
// stays quiet, someone else speaks) arrives on `on('message')`. Builders asked for the other shape too — "I sent this,
// tell me when ITS answer is done" — and wired it by hand from three events. `space.turn(text)` is that shape:
//
//   const t = space.turn('Plan the trip', { timeoutMs: 120_000 })
//   t.on('partial', ({ text }) => draw(text))      // the reply as it streams (this turn only)
//   const { status, reply } = await t.finished     // 'done' | 'silent' | 'failed' | 'aborted' | 'timeout'
//   t.abort()                                      // stop it: the text streamed so far is kept as the reply
//
// HOW THE REPLY IS FOUND. The turn request returns when the server has finished the turn (with the reply's text), or is
// cut at ~30 s by the API front door while the server goes on (`pending`). The reply MESSAGE arrives through the poll. A
// room runs one reply at a time (the server answers `busy` and the SDK resends), so the first assistant message that
// lands after the attempt that actually ran is this turn's — matched by its text when the server gave it, else by order.
// `finished` never rejects: the status says what happened, and `error` carries the server's code when there is one.
import { turnVerdict, QUEUE_MAX_TRIES, QUEUE_RETRY_MS } from './turnVerdict.js'

/** A turn's usage as a builder reads it (Tomer, 2026-10-10: "tokens in/out/cached and the cost, so we can measure a turn
 *  without waiting for daily billing"), from the record the server keeps on the reply (agent/turnUsage.mjs). `costMicros`
 *  is the PROVIDER's figure in millionths of a dollar; `source` 'provider-partial'/'none' = some calls reported no cost
 *  (the total then counts only the priced ones). null when the turn made no model call. */
export function turnUsage (rec) {
  if (!rec || typeof rec !== 'object' || !Number.isFinite(rec.in)) return null
  const n = (v) => (Number.isFinite(v) ? v : 0)
  return {
    tokensIn: n(rec.in), tokensOut: n(rec.out), tokensCached: n(rec.cached),
    costMicros: n(rec.costMicros), costUsd: n(rec.costMicros) / 1e6,
    calls: n(rec.calls), models: Array.isArray(rec.models) ? rec.models.slice() : [],
    source: typeof rec.source === 'string' ? rec.source : 'none',
    ...(rec.estimated ? { estimated: true } : {}), ...(rec.funded ? { funded: true } : {}),
  }
}

// THE APP'S WAIT (docs sync, 2026-11-22): the Spaces app holds a send for QUEUE_MAX_TRIES × QUEUE_RETRY_MS (~16 min, turnVerdict.js),
// longer than the longest turn the server runs (13 min, under the 900 s Lambda, since 2026-11-18). This was 180 s — the old hold —
// so a long, healthy turn timed out here and was STOPPED (`_stop`). One constant now; spaces/test/sdkTurnWait.test.mjs holds it.
export const TURN_TIMEOUT_MS = QUEUE_MAX_TRIES * QUEUE_RETRY_MS

const randStopKey = () => {
  const a = new Uint8Array(18); crypto.getRandomValues(a)
  return btoa(String.fromCharCode(...a)).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)
}
const isReply = (m) => !!(m && m.self && !m.sys)

export class Turn {
  /** Use `space.turn(text, opts)`. */
  constructor(space, text, { timeoutMs = TURN_TIMEOUT_MS, ...sendOpts } = {}) {
    this._space = space
    this._subs = {}
    this._stopKey = randStopKey()
    this._mark = null       // messages.length when the attempt that RAN was posted
    this._replyText = null  // the server's word on the reply, when it gave one
    /** 'running' until it settles; then 'done' | 'silent' | 'failed' | 'aborted' | 'timeout'. */
    this.status = 'running'
    /** The reply as it has streamed so far ('' before the first token). */
    this.text = ''
    /** The send() result, once the server answered. */
    this.result = null
    this.finished = new Promise((res) => { this._resolve = res })
    this._onPartial = (p) => { if (this.status !== 'running' || p.text == null) return; this.text = p.text; this._emit('partial', p) }
    this._onMessage = () => this._look()
    space.on('partial', this._onPartial)
    space.on('message', this._onMessage)
    this._timer = timeoutMs > 0 ? setTimeout(() => { this._settle('timeout'); this._stop() }, timeoutMs) : null
    space.send(text, { ...sendOpts, stopKey: this._stopKey, _onAttempt: () => { this._mark = space.messages.length }, _aborted: () => this.status !== 'running' })  // aborted OR timed out: a held message is never resent after the turn settled
      .then((r) => this._answered(r), (e) => this._settle('failed', { error: (e && e.code) || String((e && e.message) || e) }))
  }

  /** Listen: 'partial' ({ text, step }) while it streams, 'done' (the settled result). Returns an unsubscribe function. */
  on(event, cb) { (this._subs[event] ||= []).push(cb); return () => { this._subs[event] = (this._subs[event] || []).filter((x) => x !== cb) } }
  _emit(event, arg) { for (const cb of (this._subs[event] || [])) { try { cb(arg) } catch { /* a listener must not break the turn */ } } }

  /** Stop the reply. The server keeps what streamed so far as the reply; `finished` settles as 'aborted'. */
  async abort() {
    if (this.status !== 'running') return false
    this._settle('aborted')
    await this._stop()
    return true
  }
  async _stop() { try { await this._space._client.stop(this._space.room, this._stopKey) } catch { /* a stop that cannot be sent leaves the turn to finish */ } }

  _answered(r) {
    this.result = r
    const v = turnVerdict(r)
    if (v.kind === 'silent') return this._settle('silent')
    if (v.kind === 'ok') { this._replyText = typeof r.reply === 'string' ? r.reply : null; if (this._replyText === '') return this._settle('silent'); return this._look() }
    if (r && r.pending) return this._look() // cut at the front door; the reply still comes on the poll
    // NO ANSWER at all (status 0) settles as failed with its code — it MAY have posted (sdk.md): read the room before resending
    this._settle('failed', { error: (r && r.error) || v.code || v.kind, reason: (r && r.reason) || v.reason }) // the server's sentence too (sweep 11-04 P3: TurnResult had no reason)
  }

  // Is this turn's reply in `messages` yet?
  _look() {
    if (this.status !== 'running' || this._mark === null) return
    if (this.result === null) return // the request is still out: a reply that lands now may be a previous turn's
    const list = this._space.messages
    const after = list.slice(this._mark).filter(isReply)
    const m = (this._replyText ? after.find((x) => String(x.text || '') === this._replyText) : null) || after[0]
    if (m) this._settle(m.stopped ? 'aborted' : 'done', { reply: m })
  }

  _settle(status, extra = {}) {
    if (this.status !== 'running') return
    this.status = status
    clearTimeout(this._timer)
    this._space.off('partial', this._onPartial)
    this._space.off('message', this._onMessage)
    const reply = extra.reply || null
    if (reply && typeof reply.text === 'string') this.text = reply.text
    // usage: from the turn's answer, else (a turn cut at the 30 s front door) from the stored reply, which carries it too
    const usage = (this.result && this.result.usage) || turnUsage(reply && reply.usage)
    const out = { status, reply, text: this.text, proposed: (this.result && Array.isArray(this.result.proposed)) ? this.result.proposed : [], ...(usage ? { usage } : {}), ...(extra.error ? { error: String(extra.error) } : {}), ...(extra.reason ? { reason: String(extra.reason).slice(0, 500) } : {}) }
    this._emit('done', out)
    this._resolve(out)
  }
}
