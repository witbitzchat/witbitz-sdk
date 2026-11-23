// streamHint.js — what a phone does with a change HINT for the room it has OPEN while it holds that room's stream
// (docs/change-inbox.md § Room streams). The stream carries what a TURN writes and nothing else, so a hint is explained
// by the stream only when it is about a turn the stream actually delivered:
//   · the socket is down                        → poll (the stream explains nothing it did not deliver)
//   · a turn STARTING (t:'start')               → nothing: its frames follow on the stream
//   · a turn ENDING (t:'end')                   → nothing if the stream delivered that turn's END frame; otherwise poll
//                                                 once — a silent turn, a turn that failed before streaming, a lost frame
//   · any other change                          → poll once: a reaction, a widget, a photo caption, the room's config —
//                                                 and the ALLOW-LIST, whose edit rotates a gated room's stream grant, so
//                                                 this poll is how the members who remain pick up the new one
// Pure; the page and the emulator (infra/enclave/emulator/lab.mjs) both follow it.

/** How long an end hint and its end frame may be apart and still be the same turn. They travel different channels. */
export const END_FRAME_WINDOW_MS = 5000
/** How long to wait for the end frame when the end HINT arrives first. */
export const END_HINT_GRACE_MS = 1000

export const isEndFrame = (f) => !!(f && f.k === 'end')

/** 'none' | 'poll' | 'wait' ('wait': an end hint with no end frame yet — ask again after END_HINT_GRACE_MS, then poll). */
export function openRoomHintAction (hint, { streamUp = false, lastEndFrameAt = 0, now = Date.now(), waited = false } = {}) {
  if (!streamUp) return 'poll'
  const t = hint && hint.t
  if (t === 'start') return 'none'
  if (t === 'end') {
    if (lastEndFrameAt && Math.abs(now - lastEndFrameAt) <= END_FRAME_WINDOW_MS) return 'none'
    return waited ? 'poll' : 'wait'
  }
  return 'poll'
}

/** After a poll of a gated room: did its grants change (a rotation)? Then drop the old channels and open the new ones. */
export function grantsChanged (prev, next) {
  const ids = (l) => (Array.isArray(l) ? l.map((x) => x && x.g).join(',') : '')
  return ids(prev) !== ids(next)
}
