// deviceCall.js — answering a turn that asked THIS device to run a tool (an `await` action: read the calendar, ask the host
// page), one way for the Spaces app and the SDK (docs/sdk-convergence.md, phase 4b). Once per call id; the handler is
// found by the caller (the SDK: its actions; the app: its device tools, the app-site, the embedding page, the parent
// panel); its answer — or why there is none — goes back to the waiting turn, which otherwise times out gracefully.
//
// Executed once, answered once (docs/state-machines.md G-M3):
//  · `claim(name, dc)` (optional) is asked AFTER a handler is found and BEFORE it runs: false → another device of the member
//    took the call (G#3: tell_lane ran on two devices) — this one does nothing; null/throw → not known (the claim did not
//    reach the server) — the call is let go and tried again the next time a poll surfaces it.
//  · the call counts as answered only once `send` succeeded (G#4: a failed send was swallowed and the call marked done, so
//    the turn waited out its 25 s): a failed send keeps the RESULT — the tool never runs twice — and the next surfacing of
//    the same call sends it again.
export const HANDLED_ELSEWHERE = Symbol('handled elsewhere') // `find` (or its handler) sent the call on (e.g. to a parent page) — that side answers it

const _unsent = new WeakMap() // done set → Map(callId → result not yet delivered)
const _sending = new WeakMap() // done set → Set(callId) a send is in flight for
const bucket = (wm, done, mk) => { let b = wm.get(done); if (!b) { b = mk(); wm.set(done, b) } return b }

const sentOk = (r) => !(r && typeof r === 'object' && (r.ok === false || r.error || (typeof r.status === 'number' && r.status !== 200)))

async function deliver (callId, result, done, send) {
  const unsent = bucket(_unsent, done, () => new Map()), sending = bucket(_sending, done, () => new Set())
  if (sending.has(callId)) return
  sending.add(callId)
  try {
    let r
    try { r = await send(result) } catch { r = { ok: false } }
    if (sentOk(r)) unsent.delete(callId); else unsent.set(callId, result) // kept for the next surfacing — never re-run
  } finally { sending.delete(callId) }
}

export async function answerDeviceCall (dc, { done, find, send, claim }) {
  if (!dc || !dc.callId || !dc.name) return
  if (done.has(dc.callId)) { // ran here already — only a result whose send failed is owed
    const unsent = _unsent.get(done)
    if (unsent && unsent.has(dc.callId)) await deliver(dc.callId, unsent.get(dc.callId), done, send)
    return
  }
  done.add(dc.callId)
  let result
  try {
    const fn = await find(String(dc.name), dc)
    if (fn === HANDLED_ELSEWHERE) return
    if (typeof fn === 'function' && typeof claim === 'function') {
      let won = null
      try { won = await claim(String(dc.name), dc) } catch { won = null }
      if (won === false) return // another device of the member runs it: done here, nothing to answer
      if (won !== true) { done.delete(dc.callId); return } // not known: ask again when the call surfaces again
    }
    result = typeof fn === 'function' ? await fn(dc.args || {}) : { error: `No handler for "${String(dc.name).slice(0, 40)}" on this device.` }
    if (result === HANDLED_ELSEWHERE) return
  } catch (e) { result = { error: 'The tool failed on this device' + (e && e.message ? ': ' + String(e.message).slice(0, 200) : '.') } }
  await deliver(dc.callId, result, done, send)
}
