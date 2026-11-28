// roomStreamClient.js — the READING end of a room stream (docs/change-inbox.md § Room streams; the writer is
// agent/roomStream.mjs). While a room is on screen, the realm that holds its key keeps a socket on the room's channel on
// the relay and turns sealed frames into events: the reply as it grows (so the bubble is fed directly instead of by a
// poll every 350 ms), "poll now" when the ledger grew, and "the turn ended". It runs wherever the key is — the l1 worker
// by default (mk never leaves it), the page itself on the direct path — so it takes mk and never hands it on.
//
// The channel and the frame key derive from the room key (and, in a gated room, from the current epoch's GRANT, handed
// out only by a poll that passed the room's gate) — identical to agent/roomStream.mjs, held equal by
// spaces/test/roomStreamClient.test.mjs. Nothing here is the record: any doubt (a gap, a rewrite, a frame too big to
// send) becomes one "poll now", and a socket that cannot open leaves the page polling exactly as before.
import { open } from './e2ee.js'
import { RELAY_URL, RELAY_PING, RELAY_PONG, HEARTBEAT_MS, PONG_WAIT_MS } from './changePush.js'

export const STREAM_EPOCH_MS = 10 * 60 * 1000 // == agent/roomStream.mjs
const te = new TextEncoder()
const b64u = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))
export const streamChannel = async (mk, grant = '') => b64u(await sha('witbitz-room-stream|' + mk + (grant ? '|' + grant : '')))
export const streamKey = async (mk, grant = '') => (grant ? b64u(await sha('witbitz-room-stream-key|' + mk + '|' + grant)) : mk)
/** The grant for the epoch `now` falls in, from a poll's grants; null when none is current (poll again for fresh ones). */
export function currentGrant (grants, now = Date.now()) {
  const e = Math.floor(now / STREAM_EPOCH_MS)
  const g = (Array.isArray(grants) ? grants : []).find((x) => x && x.e === e && typeof x.g === 'string')
  return g ? g.g : null
}

/** Pure reassembly: frames in → events out. {k:'partial', text, pseq, step} · {k:'poll', why} · {k:'end'}.
 *  sync(text): the page just POLLED and holds `text` as the reply so far — later deltas continue from it. */
export function frameReader () {
  let text = '', valid = true, lastSeq = 0, owedPoll = false, turn = null
  const poll = (why) => { if (owedPoll) return null; owedPoll = true; return { k: 'poll', why } } // one poll per doubt, not one per frame
  return {
    // A poll's text REPAIRS a reader that lost its place; it never overrides one that has not. The writer stores each
    // step and THEN posts its frame, so a poll can be ahead of the frames or behind them — the frames are the authority
    // while they are whole (the page's renderPartial orders the two by sequence number).
    sync (t) { if (valid) return; text = String(t || ''); valid = true; owedPoll = false },
    apply (f) {
      if (!f || typeof f !== 'object') return null
      // A write announced OUTSIDE any turn (agent/spaceService.mjs announceWrite): poll now, and leave the turn's sequence
      // and the reply in progress exactly as they are — it carries no seq on purpose.
      // An ARTIFACT changed (spaceService noteViewWrite): the page reads the room's one version list — not the ledger.
      // A frame may CARRY the newest entry, sealed with the room key (agent/asyncTurn.mjs frameTail; 2026-10-20): { count, box }
      // rides the poll event as `tail` — the key worker answers that poll from it (l1-worker.js frameTails), no network.
      const tail = Number.isInteger(f.count) && f.count > 0 && typeof f.box === 'string' ? { tail: { count: f.count, box: f.box } } : {}
      if (f.oob) return f.k === 'entries' ? { k: 'poll', why: 'changed', ...tail, ...(typeof f.doc === 'string' && /^[A-Za-z0-9]{1,24}$/.test(f.doc) ? { doc: f.doc } : {}) } : f.k === 'views' ? { k: 'views' } : null
      if (f.seq === 1) { lastSeq = 0; text = ''; valid = true; owedPoll = false; turn = typeof f.tid === 'string' ? f.tid : null } // a new turn
      // ANOTHER TURN'S FRAME (state machines pass 7, L#12): two turns on one channel each count from 1, so the other's next
      // seq could look like ours and its text was spliced onto this reply. A frame naming another publisher is a doubt.
      else if (turn && typeof f.tid === 'string' && f.tid !== turn) { valid = false; return poll('other turn') }
      const gap = lastSeq && f.seq !== lastSeq + 1
      lastSeq = Number(f.seq) || lastSeq
      if (gap) { valid = false; return poll('gap') }
      if (f.k === 'entries') { if (tail.tail) { owedPoll = true; return { k: 'poll', why: 'entries', ...tail } } return poll('entries') } // a carried entry is never deduped away
      if (f.k === 'resync') { valid = false; return poll('resync') }
      if (f.k === 'end') { owedPoll = false; return { k: 'end' } }
      if (f.k !== 'partial') return null
      const add = typeof f.add === 'string' ? f.add : ''
      // A reply only grows, so a frame that starts INSIDE what we hold continues it from there; one that starts beyond it
      // means frames were lost.
      if (f.from === 0) { text = add; valid = true; owedPoll = false } else if (valid && f.from <= text.length) text = text.slice(0, f.from) + add
      else { valid = false; return poll('gap') }
      return { k: 'partial', text, pseq: f.pseq, step: f.step || null }
    },
  }
}

/** Hold the room's stream. onEvent(ev) per event above; onState(up). → { up(), sync(text), setGrants(grants), stop() }.
 *  `grants` null → an open room (the key alone); an array → a gated room (no current grant → no socket until fresh ones). */
export function openRoomStream ({ mk, grants = null, tag = '', onEvent = () => {}, onState = () => {}, relay = RELAY_URL, path = 'c', WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), heartbeatMs = HEARTBEAT_MS, pongWaitMs = PONG_WAIT_MS } = {}) {
  if (!mk || typeof WebSocketImpl !== 'function') return { up: () => false, sync () {}, setGrants () {}, stop () {} }
  const reader = frameReader()
  let ws = null, up = false, stopped = false, backoff = 1000, retry = null, beat = null, pongTimer = null, epochTimer = null, key = null, gs = grants
  const setUp = (v) => { if (v !== up) { up = v; try { onState(v) } catch { /* */ } } }
  const drop = () => { clearInterval(beat); clearTimeout(pongTimer); clearTimeout(epochTimer); beat = pongTimer = epochTimer = null; setUp(false); if (ws) { try { ws.onclose = ws.onerror = ws.onmessage = null; ws.close() } catch { /* */ } } ws = null }
  const schedule = () => { if (stopped || retry) return; retry = setTimeout(() => { retry = null; connect() }, backoff); backoff = Math.min(backoff * 2, 30_000) }
  async function connect () {
    if (stopped || ws) return
    const grant = gs ? currentGrant(gs, now()) : ''
    if (gs && !grant) return // a gated room with no current grant: wait for the next poll's
    key = await streamKey(mk, grant)
    let s
    // path 's': a page on ANY origin (the SDK) — the relay's /s/ namespace (relay/relay.mjs); the app keeps 'c'
    try { s = new WebSocketImpl(String(relay).replace(/\/+$/, '') + '/' + path + '/' + await streamChannel(mk, grant) + (tag ? '?v=' + encodeURIComponent(tag) : '')) } catch { schedule(); return } // tag: THIS device is viewing (spaceClient viewingTag)
    if (stopped) { try { s.close() } catch { /* */ } return }
    ws = s
    s.onopen = () => {
      backoff = 1000; setUp(true)
      beat = setInterval(() => { if (!ws || pongTimer) return; try { ws.send(RELAY_PING) } catch { drop(); schedule(); return } pongTimer = setTimeout(() => { pongTimer = null; drop(); schedule() }, pongWaitMs) }, heartbeatMs)
      if (gs) { const t = now(); epochTimer = setTimeout(() => { drop(); connect() }, (Math.floor(t / STREAM_EPOCH_MS) + 1) * STREAM_EPOCH_MS - t + 50) } // a gated room moves to the next epoch's channel
    }
    s.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : ''
      if (text === RELAY_PONG) { clearTimeout(pongTimer); pongTimer = null; return }
      if (!text || text.startsWith('{"t":')) return
      let f = null
      try { f = JSON.parse((await open(JSON.parse(text), { mk: key })) || 'null') } catch { f = null }
      const e = f && reader.apply(f)
      if (e) { try { onEvent(e) } catch { /* */ } }
    }
    s.onclose = s.onerror = () => { if (ws === s) { drop(); schedule() } }
  }
  connect()
  return {
    up: () => up,
    sync: (t) => reader.sync(t),
    /** Fresh grants from a poll (a gated room): reconnect only if the current epoch's grant changed (a rotation). */
    setGrants (next) {
      if (!Array.isArray(next)) return
      const changed = currentGrant(next, now()) !== currentGrant(gs, now())
      gs = next
      if (changed || !ws) { drop(); clearTimeout(retry); retry = null; connect() }
    },
    stop () { stopped = true; clearTimeout(retry); drop() },
  }
}
