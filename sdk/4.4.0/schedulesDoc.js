// schedulesDoc.js — A SPACE'S SCHEDULES, kept IN the Space (docs/cloud-device.md § 12): a sealed room document `schedules`,
// one list that the ⋯ → Always on card edits, the assistant reads (its summary line rides every turn, as every widget's
// does), and a cloud device holding this Space runs. Pure — the app, the cloud device (Node) and the agent import it.
//   doc state: { jobs: [{ id, when: { every } | { at, tz }, text, by, at }] }
export const SCHEDULES_DOC = 'schedules'
export const MIN_EVERY_MIN = 5
export const MAX_JOBS = 10
export const MAX_TEXT = 2000
export const PAUSE_AFTER_FAILS = 3 // owner, 2026-11-16: no limits, only this — a schedule that fails 3 runs in a row pauses until resumed
// ALWAYS ON (owner, 2026-11-16: "If it has no cloud device it should refuse"): a cloud device that holds this Space says so IN the
// Space — a sealed doc `alwayson` { on, seen } it writes when it takes the Space, refreshes while it runs, and clears when the
// Space is taken off or the device signed out. The assistant's schedule_task refuses unless it is on and recent: the server cannot
// know which devices hold a room, the room can.
export const ALWAYSON_DOC = 'alwayson'
export const ALWAYSON_REFRESH_MS = 6 * 3600_000
export const ALWAYSON_FRESH_MS = 3 * 24 * 3600_000
export const alwaysOnNow = (doc, now = Date.now()) => !!(doc && doc.state && doc.state.on === true && now - (Number(doc.state.seen) || 0) < ALWAYSON_FRESH_MS)
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const ID = /^j[0-9a-f]{6,12}$/

/** A schedule's `when`, checked → { every } | { at, tz }. Throws on anything else. */
export function checkWhen (w) {
  if (w && Number.isInteger(w.every)) {
    if (w.every < MIN_EVERY_MIN) throw Object.assign(new Error(`every: at least ${MIN_EVERY_MIN} minutes`), { code: 'invalid' })
    if (w.every > 7 * 24 * 60) throw Object.assign(new Error('every: at most a week'), { code: 'invalid' })
    return { every: w.every }
  }
  if (w && typeof w.at === 'string' && HHMM.test(w.at)) {
    const tz = typeof w.tz === 'string' && w.tz ? w.tz : 'UTC'
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { throw Object.assign(new Error('unknown time zone: ' + tz), { code: 'invalid' }) }
    return { at: w.at, tz }
  }
  throw Object.assign(new Error('a schedule is { every: minutes } or { at: "HH:MM", tz }'), { code: 'invalid' })
}

/** The jobs a doc holds — anything malformed is left out, never thrown (a member's device may have written it). */
export function jobsOf (doc) {
  const raw = doc && doc.state && Array.isArray(doc.state.jobs) ? doc.state.jobs : []
  const out = []
  for (const j of raw) {
    if (!j || !ID.test(String(j.id)) || typeof j.text !== 'string' || !j.text.trim()) continue
    let when; try { when = checkWhen(j.when) } catch { continue }
    out.push({ id: j.id, when, text: j.text.slice(0, MAX_TEXT), by: typeof j.by === 'string' ? j.by.slice(0, 80) : '', at: Number(j.at) || 0, ...(j.paused === true ? { paused: true, pausedAt: Number(j.pausedAt) || 0 } : {}) })
    if (out.length >= MAX_JOBS) break
  }
  return out
}

export const whenText = (w) => (w.every ? (w.every % 60 === 0 ? `every ${w.every / 60 === 1 ? 'hour' : w.every / 60 + ' hours'}` : `every ${w.every} min`) : `every day at ${w.at} (${w.tz})`)

/** The short line the assistant reads on its turns (the widget summary). */
export const summaryOf = (jobs) => (jobs.length ? 'Scheduled in this Space: ' + jobs.map((j) => `${whenText(j.when)} — "${j.text.slice(0, 80)}"${j.paused ? ' (paused — the person resumes it in ⋯ → Always on)' : ''}`).join('; ') : 'No schedules in this Space.')

const newId = () => 'j' + [...globalThis.crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** jobs + one more → the new list (a new array). */
export function withJob (jobs, { when, text, by = '' }, now = Date.now()) {
  const t = String(text || '').trim().slice(0, MAX_TEXT)
  if (!t) throw Object.assign(new Error('a schedule needs text'), { code: 'invalid' })
  if (jobs.length >= MAX_JOBS) throw Object.assign(new Error(`at most ${MAX_JOBS} schedules in a Space`), { code: 'limit' })
  return [...jobs, { id: newId(), when: checkWhen(when), text: t, by: String(by || '').slice(0, 80), at: now }]
}
export const withoutJob = (jobs, id) => jobs.filter((j) => j.id !== id)
/** One job paused (after failed runs) or resumed → the new list. */
export const withPaused = (jobs, id, paused, now = Date.now()) => jobs.map((j) => { if (j.id !== id) return j; const { paused: _p, pausedAt: _a, ...rest } = j; return paused ? { ...rest, paused: true, pausedAt: now } : rest })

/** When is a job due? `last` = the last run (ms, 0 = never). */
function localParts (ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }
}
export function isDue (when, last, now) {
  if (when.every) return !last || now - last >= when.every * 60_000
  const n = localParts(now, when.tz)
  if (n.hm < when.at) return false
  return !last || localParts(last, when.tz).day !== n.day
}
