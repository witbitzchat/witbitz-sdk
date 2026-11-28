// spaces/public/codeSent.js — did a prompt reach the computer? For a turn whose REQUEST failed.
//
// A turn POST answers only when the model has finished, so on a long run it outlives the connection that carried it: the
// phone sleeps, the relay redials, a minute offline and the transport gives up on it (codeTransport.js GIVE_UP_MS) — while
// the computer is still working on the prompt. The page used to take that as a failed send and put the prompt back in the
// box (the owner: "When there is a long run I sometimes get my prompt back in the input box"). Now it asks the computer
// first: a prompt it has is a turn that ran or is running. Pure: no DOM.

import { splitPdfBlocks } from './pdfText.js'
import { unwrapJsonMessage } from './opencodeWire.js'

export function providerRefusal(result) {
  const err = result?.info?.error
  return err ? unwrapJsonMessage(err.data?.message || err.message || err.name || 'the provider refused this turn') : ''
}

const words = (s) => String(s == null ? '' : s).trim()

/** The ids of the user messages there are now — taken when a prompt is sent. */
export const userIds = (messages) => new Set((Array.isArray(messages) ? messages : []).filter((m) => m && m.info && m.info.role === 'user' && m.info.id).map((m) => m.info.id))

/**
 * Is there a user message that was not there when the prompt was sent, carrying its words? (A prompt with only files has no
 * words, so history alone cannot confirm delivery.) `text` is what the person typed; the message may carry more after it (a PDF's text)
 * and a language line beside it, never less.
 */
export function promptLanded(messages, { knownUserIds, text }) {
  const known = knownUserIds instanceof Set ? knownUserIds : new Set()
  const want = words(text)
  const history = Array.isArray(messages) ? messages : []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i], info = m?.info
    if (info?.role !== 'user' || !info.id) continue
    if (known.has(info.id)) break
    if (want && (m.parts || []).some(p => p?.type === 'text' && !p.synthetic && (words(p.text) === want || splitPdfBlocks(words(p.text)).text === want))) return true
  }
  return false
}

export function firstOutputStarted(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role === 'user') break
    if (message?.parts?.some(part => part && part.type !== 'step-start')) return true
  }
  return false
}

/** In-memory failed submissions, scoped to the computer/session chosen by the caller. */
export class PendingCodeDrafts {
  constructor() { this.sessions = new Map(); this.sequence = 0 }
  list(key) { return [...(this.sessions.get(key)?.values() || [])] }
  get(key, id) { return this.sessions.get(key)?.get(id) || null }
  close() { this.closed = true; this.sessions.clear() }
  add(key, draft) {
    if (this.closed) return null
    const id = String(++this.sequence)
    if (!this.sessions.has(key)) this.sessions.set(key, new Map())
    this.sessions.get(key).set(id, { ...draft, id })
    return id
  }
  discard(key, id) {
    const queue = this.sessions.get(key)
    if (!queue?.delete(id)) return false
    if (!queue.size) this.sessions.delete(key)
    return true
  }
}
