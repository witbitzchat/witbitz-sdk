// codeProgress: what a confidential model is doing while nothing of its answer has reached OpenCode yet.
//
// The owner, watching Kimi K3 · confidential show "Thinking…" for minutes: "Why can't we see what he is thinking about".
// Measured on that turn: no thinking was sent at all (0 reasoning tokens) — 154 s went to reading a 78,518-token
// conversation before the first word, and a later step spent 4½ minutes writing a whole document as ONE tool call, which
// the confidential proxy holds back until TrustedRouter's receipt verifies. OpenCode cannot be told any of that (its AI SDK
// runs every tool call still open when a stream closes), so the proxy tells the connector, and the connector tells the
// phone: { t:'progress', sessionID, label, phase, attempt, tool?, subject?, chars?, bytes? } (tools/code-confidential.mjs).
// Never the tool call's contents — its name, the file it names, and how big it has grown.

export const PHASES = new Set(['waiting', 'answering', 'writing', 'checking', 'retrying', 'end'])

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)

/** A progress message from the connector, checked — or null. */
export function normProgress(m) {
  if (!m || typeof m !== 'object') return null
  if (typeof m.sessionID !== 'string' || !/^ses[A-Za-z0-9_-]{1,80}$/.test(m.sessionID)) return null
  if (!PHASES.has(m.phase)) return null
  return {
    sessionID: m.sessionID,
    phase: m.phase,
    label: str(m.label, 60),
    attempt: Math.min(num(m.attempt) || 1, 9),
    tool: str(m.tool, 40),
    subject: str(m.subject, 200),
    chars: num(m.chars),
  }
}

const fileName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || ''
const size = (n) => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString('en-US')} KB` : '')

function writingWhat(tool, subject) {
  const file = fileName(subject)
  if (tool === 'write') return file ? `Writing ${file}` : 'Writing a file'
  if (tool === 'edit' || tool === 'multiedit' || tool === 'patch' || tool === 'apply_patch') return file ? `Editing ${file}` : 'Editing a file'
  if (tool === 'bash') return 'Preparing a command'
  if (tool === 'todowrite') return 'Updating the to-do list'
  if (tool === 'task') return 'Starting an agent'
  return tool ? `Preparing ${tool}` : 'Preparing a step'
}

/** The working line's words for a progress report — '' when the transcript itself says it better (words are arriving). */
export function progressLine(p) {
  if (!p) return ''
  const who = p.label || 'The model'
  if (p.phase === 'waiting') return p.attempt > 1 ? `Asking ${who} again` : `${who} is reading the conversation`
  if (p.phase === 'writing') { const s = size(p.chars), what = writingWhat(p.tool, p.subject); return s ? `${what} · ${s}` : what }
  if (p.phase === 'checking') return "Checking TrustedRouter's receipt"
  if (p.phase === 'retrying') return 'TrustedRouter renewed its proof — asking again'
  return ''
}
