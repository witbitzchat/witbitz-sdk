// changePush.js — PUSH for the change inbox (docs/change-inbox.md § Push). While the app is open this device keeps ONE
// socket on the relay (relay/relay.mjs, wss://code-relay.witbitz.chat — the Code section's relay, already in the CSP).
// When one of its rooms changes, the Space Lambda posts a sealed HINT to this device's channel and the relay pushes it
// down the socket: the page polls that room at once instead of asking "what changed?" every two seconds.
//
// The relay learns neither the device's inbox nor the room: the CHANNEL and the hint's AES-GCM KEY both derive from the
// inbox id, which only this device and the Lambda hold (agent/changeFeed.mjs hintChannel / sealHint — same derivations,
// held equal by spaces/test/changePush.test.mjs).
//
// A hint is a nudge, never the record: a lost one costs latency (the slow "what changed?" and the sweep remain), never a
// message. A socket that cannot open (another origin, a network that blocks it) simply leaves the page on the 2 s checks.

// Same relay, same heartbeat as codeRelay.js (not imported: that module brings the Code section with it).
export const RELAY_URL = 'wss://code-relay.witbitz.chat'
export const RELAY_PING = '{"t":"relay-ping"}'
export const RELAY_PONG = '{"t":"relay-pong"}'
export const HEARTBEAT_MS = 25_000
export const PONG_WAIT_MS = 10_000
const MIN_BACKOFF = 1000, MAX_BACKOFF = 30_000

const te = new TextEncoder()
const b64u = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))

/** This inbox's relay channel — 43 characters, as the relay requires. == agent/changeFeed.mjs hintChannel. */
export const hintChannel = async (inbox) => b64u(await sha('witbitz-change-channel|' + inbox))
/** Open a sealed hint → { room, live, v, t? }, or null (not a hint, or not ours). */
export async function openHint (inbox, text) {
  try {
    const { iv, ct } = JSON.parse(text)
    const key = await crypto.subtle.importKey('raw', await sha('witbitz-change-hint|' + inbox), 'AES-GCM', false, ['decrypt'])
    const h = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64u(iv) }, key, ub64u(ct))))
    return h && typeof h.room === 'string' ? h : null
  } catch { return null }
}

/** Keep the socket up; call onHint(hint) for each hint; onState(up) on every change. → { up(), wake(), stop() } */
export function startChangePush ({ inbox, onHint = () => {}, onState = () => {}, relay = RELAY_URL, path = 'c', WebSocketImpl = globalThis.WebSocket, heartbeatMs = HEARTBEAT_MS, pongWaitMs = PONG_WAIT_MS } = {}) {
  if (!inbox || typeof WebSocketImpl !== 'function') return { up: () => false, wake () {}, stop () {} }
  let ws = null, up = false, stopped = false, backoff = MIN_BACKOFF, retry = null, beat = null, pongTimer = null
  const setUp = (v) => { if (v !== up) { up = v; try { onState(v) } catch { /* */ } } }
  const clearTimers = () => { clearInterval(beat); clearTimeout(pongTimer); beat = pongTimer = null }
  const drop = () => { clearTimers(); setUp(false); if (ws) { try { ws.onclose = ws.onerror = ws.onmessage = null; ws.close() } catch { /* */ } } ws = null }
  const schedule = () => { if (stopped || retry) return; retry = setTimeout(() => { retry = null; connect() }, backoff); backoff = Math.min(backoff * 2, MAX_BACKOFF) }
  // A dead path can leave a socket "open" for minutes (codeRelay.js measured it): ask the relay, which answers itself.
  const probe = (waitMs = pongWaitMs) => {
    if (!ws || pongTimer) return
    try { ws.send(RELAY_PING) } catch { drop(); schedule(); return }
    pongTimer = setTimeout(() => { pongTimer = null; drop(); schedule() }, waitMs)
  }
  async function connect () {
    if (stopped || ws) return
    let s
    try { s = new WebSocketImpl(String(relay).replace(/\/+$/, '') + '/' + path + '/' + await hintChannel(inbox)) } catch { schedule(); return }
    if (stopped) { try { s.close() } catch { /* */ } return }
    ws = s
    s.onopen = () => { backoff = MIN_BACKOFF; setUp(true); beat = setInterval(() => probe(), heartbeatMs) }
    s.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : ''
      if (text === RELAY_PONG) { clearTimeout(pongTimer); pongTimer = null; return }
      if (!text || text.startsWith('{"t":')) return // the relay's own peer count
      const h = await openHint(inbox, text)
      if (h) { try { onHint(h) } catch { /* */ } }
    }
    s.onclose = s.onerror = () => { if (ws === s) { drop(); schedule() } }
  }
  connect()
  return {
    up: () => up,
    /** The page came back to the foreground: a socket iOS froze in the background may be dead — prove it now. */
    wake () { if (stopped) return; if (!ws) { clearTimeout(retry); retry = null; backoff = MIN_BACKOFF; connect() } else probe(3000) },
    stop () { stopped = true; clearTimeout(retry); drop() },
  }
}
