// codeSubagents: how the Code section shows an agent's SUBAGENTS — the child sessions OpenCode's task tool starts.
//
// Every subagent is a session of its own (parentID set, titled "<task> (@explore subagent)"). Listed as peers they filled
// the drawer with conversations nobody started, and their approval asks — which carry the CHILD's session id — never
// reached the conversation the person was reading. So:
//   · the drawer lists only top-level sessions; a parent shows how many agents it ran, and its ✶ while any of them runs.
//     A child whose parent is not in the list (deleted, or outside it) is still listed, so nothing becomes unreachable.
//   · the open session's children are known (list, task steps, live session.created events), and their asks and Auto
//     verdicts are shown IN the parent, naming the agent.
//   · a refused step says who refused it — OpenCode words every rejection "The user rejected permission…", including the
//     ones it CASCADES onto the other pending asks of a session when one is rejected (tools/code-opencode-policy.mjs).

/** What a person's Deny tells the model. With continue_loop_on_deny the turn goes on — this makes it stop and ask. */
export const PERSON_REFUSAL = 'The person refused this in Witbitz — stop and ask them how to proceed.'
const AUTO_MARK = 'Witbitz Auto mode refused this'
const CORRECTED_PREFIX = 'The user rejected permission to use this specific tool call with the following feedback: '
const BARE_REJECTION = 'The user rejected permission to use this specific tool call.'

const textOf = (s) => ((s && s.title) || '') + ' ' + ((s && s.slug) || '') + ' ' + ((s && s.directory) || '')

/** Who a subagent session belongs to, by id → parent id, for the sessions in `all`. */
function parentsOf(all) {
  const ids = new Set(all.map((s) => s && s.id).filter(Boolean))
  const parent = new Map()
  for (const s of all) if (s && s.id && typeof s.parentID === 'string' && s.parentID && ids.has(s.parentID)) parent.set(s.id, s.parentID)
  return parent
}

/** The top-level session a session sits under (itself when it has no listed parent). */
function rootOf(id, parent) {
  let cur = id
  for (let i = 0; i < 8 && parent.has(cur); i++) cur = parent.get(cur)
  return cur
}

/**
 * The drawer's rows for `shown` (the active or the archived list), with `all` (both lists) to resolve parents.
 * → [{ session, agents, agentRunning }] in `shown`'s order. `running`: Map of session id → state, from /session/status.
 */
export function drawerRows(shown, { all = shown, running = new Map(), query = '' } = {}) {
  const parent = parentsOf(all)
  const q = String(query || '').trim().toLowerCase()
  const agents = new Map() // root id → how many subagents ran under it
  const agentRunning = new Set()
  const childMatch = new Set() // root ids a search found through one of their subagents
  for (const s of all) {
    if (!s || !parent.has(s.id)) continue
    const root = rootOf(s.id, parent)
    agents.set(root, (agents.get(root) || 0) + 1)
    if (running.has(s.id)) agentRunning.add(root)
    if (q && textOf(s).toLowerCase().includes(q)) childMatch.add(root)
  }
  return shown
    .filter((s) => s && !parent.has(s.id))
    .filter((s) => !q || textOf(s).toLowerCase().includes(q) || childMatch.has(s.id))
    .map((s) => ({ session: s, agents: agents.get(s.id) || 0, agentRunning: agentRunning.has(s.id) }))
}

/** The subagent sessions under `sid` that this page knows of: from the session list and from the transcript's task steps. */
export function childIdsOf(sid, { sessions = [], messages = [] } = {}) {
  const out = new Set()
  if (!sid) return out
  const parent = parentsOf(sessions)
  for (const s of sessions) if (s && s.id && parent.has(s.id) && rootOf(s.id, parent) === sid) out.add(s.id)
  for (const m of messages || []) {
    for (const p of (m && m.parts) || []) {
      const meta = p && p.type === 'tool' && p.state && p.state.metadata
      if (meta && typeof meta.sessionId === 'string' && meta.sessionId && meta.sessionId !== sid) out.add(meta.sessionId)
    }
  }
  return out
}

/** What a live event says about the family: a session created or updated under `sid` → its id, else ''. */
export function childFromEvent(ev, sid, known = new Set()) {
  const type = ev && ev.type
  if (type !== 'session.created' && type !== 'session.updated') return ''
  const info = ev.properties && ev.properties.info
  if (!info || typeof info.id !== 'string' || typeof info.parentID !== 'string') return ''
  return info.parentID === sid || known.has(info.parentID) ? info.id : ''
}

/** A subagent's short name for a card: "explore" out of "Explore the repo (@explore subagent)", else its title. */
export function agentLabel(session) {
  const title = String((session && session.title) || '')
  const m = title.match(/\(@([^\s)]+) subagent\)\s*$/)
  const task = title.replace(/\s*\(@[^)]*subagent\)\s*$/, '').trim()
  return { name: m ? m[1] : 'subagent', task }
}

/**
 * Who refused a step, from OpenCode's error text.
 *  → { kind: 'auto', reason } Auto mode refused it (the reason it gave the agent)
 *  → { kind: 'person', reason } the person denied it from the Code section
 *  → { kind: 'cancelled' }     a bare rejection: OpenCode cancelled it because ANOTHER ask in the session was rejected
 *  → { kind: 'other', reason } refused with some other feedback (another client)
 *  → null                      not a refusal at all
 */
export function refusalOf(error) {
  const e = String(error || '').trim()
  if (e === BARE_REJECTION) return { kind: 'cancelled' }
  if (!e.startsWith(CORRECTED_PREFIX)) return null
  const feedback = e.slice(CORRECTED_PREFIX.length).trim()
  if (feedback.includes(AUTO_MARK)) return { kind: 'auto', reason: feedback.replace(/\s*\(Witbitz Auto mode refused this[^)]*\)\s*$/, '').trim() }
  if (feedback === PERSON_REFUSAL) return { kind: 'person', reason: '' }
  return { kind: 'other', reason: feedback }
}
