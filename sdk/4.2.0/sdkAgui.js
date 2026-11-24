// spaces/public/sdkAgui.js — a Witbitz Space as an AG-UI agent (the Agent–User Interaction protocol, 1.0; docs:
// https://witbitz.chat/docs/sdk-agents.md#ag-ui). It runs IN THE BUILDER'S PAGE, on the Space the SDK already decrypts there, so an AG-UI
// front end (CopilotKit's components, or any client of @ag-ui/client) shows a Witbitz room without the room leaving the
// device: the adapter turns what the Space already emits into AG-UI events, and AG-UI's input back into the Space.
//
//   partial (the reply so far)        → TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT (deltas) / TEXT_MESSAGE_END
//   message (self: the reply)         → closes the message (or carries it whole, when nothing streamed)
//   proposal (waits for a human)      → TOOL_CALL_START / ARGS / END, and the run ends with an INTERRUPT outcome
//   input.resume (resolved/cancelled) → space.approve / space.deny → TOOL_CALL_RESULT
//   input.context                     → this turn's `instructions` (never stored in the room)
//   space.messages                    → MESSAGES_SNAPSHOT (aguiHistory) — the agent's initial messages
//
// No dependency: AG-UI's client is rxjs-based, so aguiAgent() takes the builder's OWN AbstractAgent and Observable and
// returns a subclass. aguiRun() is the plain async iterator under it.
// Not mapped (yet): AG-UI front-end tools (input.tools) — a Space's own tools and approvals cover the room; STATE events.

const now = () => Date.now()
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '')
const sentIds = new WeakMap() // per Space: the user-message ids already sent — AG-UI clients resend the whole history every run
const contextText = (ctx) => (Array.isArray(ctx) && ctx.length ? 'Context from the app:\n' + ctx.map((c) => `- ${c.description}: ${c.value}`).join('\n') : '')

/**
 * Run one AG-UI run against a Space. → an async iterator of AG-UI 1.0 events, ending with RUN_FINISHED or RUN_ERROR.
 * @param space a Space (or Lane) from the SDK
 * @param input an AG-UI RunAgentInput ({ threadId, runId, messages, context?, resume? })
 * @param opts { from, mode = 'always', timeoutMs = TURN_TIMEOUT_MS (~16 min, as space.turn()), graceMs = 1500, signal }
 */
import { isLaneCopy } from './roomName.js'
import { TURN_TIMEOUT_MS } from './sdkTurn.js' // the same wait as space.turn() and the app (~16 min) // the one test for a lane's copy of its shared room's line
export function aguiRun(space, input, { from, mode = 'always', timeoutMs = TURN_TIMEOUT_MS, graceMs = 1500, signal } = {}) {
  const queue = [], waiters = []
  let done = false
  const push = (e) => { if (done) return; const ev = { ...e, timestamp: now() }; const w = waiters.shift(); if (w) w({ value: ev, done: false }); else queue.push(ev) }
  const end = () => { done = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }) }
  const { threadId, runId } = input
  const subs = []
  const listen = (ev, cb) => { space.on(ev, cb); subs.push([ev, cb]) }
  const unlisten = () => { for (const [ev, cb] of subs.splice(0)) { try { space.off(ev, cb) } catch { /* an older Space without off() */ } } }
  let timer = null
  const finish = (e) => { if (done) return; clearTimeout(timer); unlisten(); push(e); end() }
  const fail = (message, code) => finish({ type: 'RUN_ERROR', message, code })

  ;(async () => {
    push({ type: 'RUN_STARTED', threadId, runId })
    if (signal) { if (signal.aborted) return finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'cancelled' } }); signal.addEventListener('abort', () => finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'cancelled' } }), { once: true }) }

    // 1. Resume: the person answered an interrupt — approve or deny the proposal in the room.
    const resume = Array.isArray(input.resume) ? input.resume : []
    for (const r of resume) {
      const id = String(r.interruptId)
      try {
        if (r.status === 'resolved') { const out = await space.approve(id, r.payload && typeof r.payload === 'object' && r.payload.from ? { from: r.payload.from } : undefined); push({ type: 'TOOL_CALL_RESULT', messageId: 'wb-res-' + id, toolCallId: id, role: 'tool', content: JSON.stringify({ approved: true, result: out && out.result !== undefined ? out.result : null }) }) }
        else { await space.deny(id); push({ type: 'TOOL_CALL_RESULT', messageId: 'wb-res-' + id, toolCallId: id, role: 'tool', content: JSON.stringify({ approved: false }) }) }
      } catch (e) { return fail(`the room refused ${r.status === 'resolved' ? 'the approval' : 'the denial'}: ${(e && e.message) || e}`, (e && e.code) || 'refused') }
    }

    // 2. The new user message, if there is one this Space has not been sent yet.
    const msgs = Array.isArray(input.messages) ? input.messages : []
    const last = msgs[msgs.length - 1]
    const sent = sentIds.get(space) || new Set(); sentIds.set(space, sent)
    const fresh = last && last.role === 'user' && !sent.has(last.id) && textOf(last.content).trim() ? last : null
    if (!fresh) { if (resume.length) return finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } }); return fail('nothing to send: the last message is not a new user message, and nothing to resume', 'no_input') }

    const mid = 'wb-' + runId
    let started = false, streamed = '', proposals = []
    const start = () => { if (!started) { started = true; push({ type: 'TEXT_MESSAGE_START', messageId: mid, role: 'assistant' }) } }
    const content = (delta) => { if (delta) push({ type: 'TEXT_MESSAGE_CONTENT', messageId: mid, delta }) }
    listen('partial', (p) => {
      if (!p || typeof p.text !== 'string' || !p.text) return
      start()
      if (p.text.startsWith(streamed)) { content(p.text.slice(streamed.length)); streamed = p.text }
    })
    listen('proposal', (p) => { if (p && p.id && !proposals.some((x) => x.id === p.id)) proposals.push(p) })
    listen('message', (m) => {
      if (!m || m.self !== true || done) return
      const final = String(m.text || '')
      start()
      content(final.startsWith(streamed) ? final.slice(streamed.length) : streamed ? '' : final)
      push({ type: 'TEXT_MESSAGE_END', messageId: mid })
      try { if (typeof space._pollPending === 'function') space._pollPending() } catch { /* the proposals poll still runs */ } // ask NOW: a card made during the turn sits on its own channel
      // A proposal made during the turn can reach the device just after the reply (its own channel): wait a beat for it.
      setTimeout(() => {
        if (done) return
        if (!proposals.length) return finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } })
        for (const p of proposals) {
          push({ type: 'TOOL_CALL_START', toolCallId: p.id, toolCallName: p.action || 'proposal', parentMessageId: mid })
          push({ type: 'TOOL_CALL_ARGS', toolCallId: p.id, delta: JSON.stringify(p.args || {}) })
          push({ type: 'TOOL_CALL_END', toolCallId: p.id })
        }
        finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'interrupt', interrupts: proposals.map((p) => ({ id: p.id, reason: 'approval_required', toolCallId: p.id, ...(p.text ? { message: String(p.text) } : {}) })) } })
      }, proposals.length ? 0 : graceMs)
    })
    timer = setTimeout(() => fail(`no reply from the room within ${Math.round(timeoutMs / 1000)} s`, 'timeout'), timeoutMs)
    sent.add(fresh.id)
    let r
    try {
      const instructions = contextText(input.context)
      r = await space.send(textOf(fresh.content), { from: from || fresh.name || 'You', mode, ...(instructions ? { instructions } : {}) })
    } catch (e) { sent.delete(fresh.id); return fail(String((e && e.message) || e), (e && e.code) || 'send_failed') }
    if (r && r.ok === false) { sent.delete(fresh.id); return fail(r.error === 'busy' ? 'the room is busy answering an earlier message' : `the room did not take the message (${r.error || 'refused'})`, r.error || 'refused') }
  })().catch((e) => fail(String((e && e.message) || e), 'adapter'))

  return {
    [Symbol.asyncIterator]() { return this },
    next() { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (done) return Promise.resolve({ value: undefined, done: true }); return new Promise((res) => waiters.push(res)) },
    return() { finish({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'cancelled' } }); queue.length = 0; return Promise.resolve({ value: undefined, done: true }) },
  }
}

/** The room so far, as AG-UI messages: the assistant's replies as `assistant`, everyone else's as `user` with their name.
 *  → a MESSAGES_SNAPSHOT event (its `.messages` are an agent's initial messages). */
export function aguiHistory(space) {
  const messages = (space.messages || [])
    .filter((m) => m && typeof m.text === 'string' && m.text && !m.sys && m.kind !== 'data' && m.kind !== 'fork')
    // A LANE COPY (a line mirrored from the shared room) is never this agent's turn, even when the shared room's own
    // assistant wrote it: a `user` message, named as from the shared room (sync sweep, 2026-10-10).
    .map((m, i) => { const copy = isLaneCopy(m), who = m.from || m.name; return { id: String(m.id || 'wb-' + i), role: m.self === true && !copy ? 'assistant' : 'user', content: m.text, ...(who || copy ? { name: String(who || 'someone') + (copy ? ' (from the shared room)' : '') } : {}) } })
  return { type: 'MESSAGES_SNAPSHOT', timestamp: now(), messages }
}

/**
 * An AG-UI agent for a Space, built from the BUILDER's own `AbstractAgent` (@ag-ui/client) and `Observable` (rxjs):
 *   import { AbstractAgent } from '@ag-ui/client'; import { Observable } from 'rxjs'
 *   const agent = aguiAgent({ AbstractAgent, Observable }, space, { threadId: space.room })
 * `opts` passes to aguiRun (from, mode, timeoutMs, graceMs) and `agentConfig` to the AbstractAgent constructor.
 */
export function aguiAgent({ AbstractAgent, Observable }, space, { threadId, agentConfig = {}, ...runOpts } = {}) {
  if (typeof AbstractAgent !== 'function' || typeof Observable !== 'function') throw new TypeError('aguiAgent needs { AbstractAgent, Observable } — from @ag-ui/client and rxjs')
  class WitbitzAgent extends AbstractAgent {
    run(input) {
      return new Observable((sub) => {
        const ac = new AbortController()
        ;(async () => {
          try { for await (const e of aguiRun(space, input, { ...runOpts, signal: ac.signal })) sub.next(e); sub.complete() } catch (e) { sub.error(e) }
        })()
        return () => ac.abort()
      })
    }
  }
  return new WitbitzAgent({ threadId: threadId || space.room, initialMessages: aguiHistory(space).messages, ...agentConfig })
}
