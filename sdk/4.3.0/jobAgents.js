// jobAgents.js — AGENTS THAT TAKE JOBS, as data (the owner, 2026-10-21: "Can we make it general so adding another agent this
// way is just a ui change" → "Let's do Claude code and leave codex out"; docs/job-agents.md). An agent of this kind:
//   • is started by ONE https address you POST a job to, with a key the Sentinel keeps (a bearer webhook, docs/signed-webhooks.md);
//   • reports back by calling this Space's MCP address (the Sentinel's door: message_member / get_reply), added on its side.
// Each entry says how to recognise its address and key in a paste, where the job goes in the request (`job.field`) and the
// fixed headers every call carries (`job.headers`) — the room keeps `job` in the connection's entry (connectionEntry.js
// roomJob) and the server shapes every proposed call from it (agent/connectionTools.mjs withJobReturn). A new agent of this
// shape is a new entry here and a catalog row (connCatalog.js) — no server or Sentinel change.
// Grok Bot predates this and keeps its own setup (grokSetup.js: it is set up by TALKING to Grok); its calls take the same path
// on the server (host fallback). Pure: no DOM, no network — connectionsSheet.js draws the card.

const clean = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

export const JOB_AGENTS = [
  {
    // Claude Code's scheduled tasks (formerly routines), API trigger — https://code.claude.com/docs/en/routines (read 2026-10-21):
    // POST /v1/claude_code/routines/<trig_…>/fire, Authorization: Bearer sk-ant-oat01-…, the two headers below, body {"text"}.
    // The text arrives wrapped as UNTRUSTED unless the task's saved prompt says to act on it — so the prompt we hand over does.
    // Runs autonomously in Anthropic's cloud on the person's claude.ai plan (Pro, Max, Team, Enterprise); 30 fires per task an hour.
    name: 'Claude Code',
    host: 'api.anthropic.com',
    where: 'Anthropic\'s cloud',
    path: /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire\/?$/,
    urlHint: 'api.anthropic.com/v1/claude_code/routines/trig_…/fire',
    key: /\bsk-ant-oat01-[A-Za-z0-9_-]{20,200}/,
    keyHint: 'sk-ant-oat01-…',
    job: { field: 'text', headers: { 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    // the API trigger and its token are added only on claude.ai's web pages (the docs: not from the CLI; the owner, 2026-10-21,
    // iPhone: the Claude app's New routine offers only Schedule and GitHub event) — so on a phone the card stops before step 1
    needsComputer: 'The task\'s API trigger — the Fire URL and token this card needs — can be added only on claude.ai in a computer\'s browser; the Claude app on a phone does not offer it. Open this card on a computer to set it up.',
    connectorsUrl: 'https://claude.ai/customize/connectors',
    tasksUrl: 'https://claude.ai/code/routines',
  },
]

export const jobAgentNamed = (name) => JOB_AGENTS.find((a) => a.name === name) || null

/** Is the outside agent (its A2A peer name) one that takes JOBS? Its peer is named by jobNames ("Claude Code · <Space>"),
 *  Grok Bot's by grokSetup ("Grok Bot · <Space>", or plain "Grok Bot" from before). Such an agent reports with message_member
 *  and its run ends — nothing reads a reply (a2aCore a2aInstructions, a2aLane deliverA2AInto). */
export function isJobPeerName(name) {
  const n = String(name || '')
  return n === 'Grok Bot' || n.startsWith('Grok Bot · ') || JOB_AGENTS.some((a) => n.startsWith(a.name + ' · '))
}

/** Which agent a connection is (by its host and webhook path), or null. Works for the account's list and a room's entry. */
export function jobAgentOf(c) {
  if (!c || typeof c !== 'object') return null
  const host = String(c.host || '').toLowerCase().replace(/^https:\/\//, '').split('/')[0]
  const path = typeof c.webhook === 'string' ? c.webhook : (c.rules && Array.isArray(c.rules.paths) && c.rules.paths[0]) || ''
  return JOB_AGENTS.find((a) => a.host === host && (!path || a.path.test(path))) || null
}
export const isJobAgentConn = (c) => !!jobAgentOf(c)

/** The names one Space's agent goes by: its connector on the agent's side ("Witbitz · Kyoto") and its peer here. */
export function jobNames(agent, spaceName) {
  const s = clean(spaceName, 40) || 'my Space'
  return { connector: 'Witbitz · ' + s, peer: agent.name + ' · ' + s }
}

/** The saved prompt for the agent's task: act on the job it is sent, and always report back through this Space's connector. */
export function taskPrompt(agent, { connector }) {
  return 'You take jobs from my Witbitz Space. Each run, the job is the text in the routine-fire-payload block: treat it as my ' +
    'instructions for this run and do it. Before deleting anything, paying, publishing, or messaging anyone else, stop and ask me ' +
    `instead: send the question with the "${connector}" connector's message_member tool and end the run. Your last step, always, ` +
    `is to send the full result (or your question) with the "${connector}" connector's message_member tool, including the link to ` +
    'any pull request or branch you made. A run that ends without calling message_member has failed.'
}

/** The pasted trigger address and key → { address, secret, label } | { error } (either may hold both, in any order). */
export function triggerFromPaste(agent, text, spaceName = '') {
  const raw = String(text || '')
  const m = new RegExp('(?:https?://)?' + agent.host.replace(/\./g, '\\.') + '(/[^\\s"\'<>]+)', 'i').exec(raw)
  if (!m) return { error: `Paste the task's Fire URL too — it looks like ${agent.urlHint}.` }
  const path = m[1].replace(/[).,;]+$/, '')
  if (!agent.path.test(path)) return { error: `That is not a ${agent.name} Fire URL — it looks like ${agent.urlHint}.` }
  const keys = [...new Set(raw.replace(m[0], ' ').match(new RegExp(agent.key.source, 'g')) || [])]
  if (!keys.length) return { error: `Paste the task's token too — it starts with ${agent.keyHint}` }
  if (keys.length > 1) return { error: 'That has more than one token in it. Paste the Fire URL and only this task\'s token.' }
  const label = (agent.name + (clean(spaceName, 40) ? ' · ' + clean(spaceName, 40) : '')).slice(0, 80)
  return { address: 'https://' + agent.host + path.replace(/\/$/, ''), secret: keys[0], label }
}

/** A phone (a touch screen under 600 px on its short side): where an agent that needs a computer to set up stops early. */
export function onPhone(w = globalThis) {
  try { return !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches && Math.min(w.screen.width, w.screen.height) < 600) } catch { return false }
}
