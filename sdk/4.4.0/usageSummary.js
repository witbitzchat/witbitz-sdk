// usageSummary.js — a Space's usage, added up ON THE DEVICE from the sealed per-reply records (2026-10-01;
// docs/tenant-billing.md § 8.1; spaces/test/usageSummary.test.mjs). Pure: no DOM, no imports.
//
// Every AI reply carries `usage` (agent/turnUsage.mjs): who asked, tokens, and the provider's own cost per call. The room's
// members see their room's cost by person and by model; Witbitz never sees these totals. A turn some of whose calls
// reported no price is marked `provider-partial`, and the view says so rather than presenting the total as complete.
// It is analysis, not the bill — the bill is the provider's per-key report.

const DAY = 86_400_000
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
const str = (v, n = 80) => String(v == null ? '' : v).slice(0, n)

const usageOf = (e) => (e && e.self && e.usage && typeof e.usage === 'object' ? e.usage : null)

function bucket () { return { turns: 0, calls: 0, in: 0, out: 0, cached: 0, costMicros: 0 } }
function add (b, u, isReply = true) {
  if (isReply) b.turns++ // a room title costs, but it is not a reply
  b.calls += num(u.calls)
  b.in += num(u.in)
  b.out += num(u.out)
  b.cached += num(u.cached)
  b.costMicros += num(u.costMicros)
}

/** @param {object[]} entries the room's decrypted ledger  @param {{now?: number, days?: number}} [o] */
export function roomUsageRecords (entries, titles = []) {
  const records = []
  function record(u, at, title) {
    // Export billing fields only. A reply and a title can both contain other room data.
    const ts = num(at)
    records.push({ self: true, ts: ts <= 8.64e15 ? ts : 0, title, usage: {
      by: title ? 'Room titles' : str(u.by), calls: num(u.calls), in: num(u.in),
      out: num(u.out), cached: num(u.cached), costMicros: num(u.costMicros),
      models: Array.isArray(u.models) ? u.models.slice(0, 8).map(m => str(m)) : [], source: str(u.source, 20),
    } })
  }
  for (const e of entries || []) if (usageOf(e)) record(e.usage, e.ts, false)
  for (const u of Array.isArray(titles) ? titles : []) if (u && typeof u === 'object') record(u, u.at, true)
  return records
}

export function summarizeUsage (entries, { now = Date.now(), days = 7, titles = [] } = {}) {
  const all = bucket(), week = bucket()
  const people = new Map(), models = new Map()
  let partial = false
  for (const e of roomUsageRecords(entries, titles)) {
    const u = usageOf(e)
    if (!u) continue
    add(all, u, !e.title)
    if (num(e.ts) >= now - days * DAY) add(week, u, !e.title)
    const who = str(u.by) || 'Someone'
    if (!people.has(who)) people.set(who, { name: who, ...bucket() })
    add(people.get(who), u)
    for (const m of Array.isArray(u.models) ? u.models.slice(0, 8) : []) {
      const k = str(m, 80)
      if (!models.has(k)) models.set(k, { model: k, turns: 0 })
      models.get(k).turns++
    }
    if (u.source !== 'provider') partial = true
  }
  const byCost = (a, b) => b.costMicros - a.costMicros || b.turns - a.turns
  return { all, week, byPerson: [...people.values()].sort(byCost), byModel: [...models.values()].sort((a, b) => b.turns - a.turns), partial, empty: people.size === 0 }
}

/** Micro-dollars → a price a person can read: four decimals while it is small, cents once it is not. */
export const money = (micros) => {
  const m = Math.round(num(micros))
  if (m === 0) return '$0.00'
  // Round in INTEGER micro-dollars, half up — toFixed on the float shows 12,650 µ$ ($0.01265) as $0.0126.
  if (m < 1_000_000) return '$' + (Math.max(Math.round(m / 100), 1) / 10_000).toFixed(4)
  return '$' + (Math.round(m / 10_000) / 100).toFixed(2)
}

const csvCell = (v) => {
  let s = String(v == null ? '' : v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // a spreadsheet must not run a member's name as a formula
  return /[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** One CSV line per AI reply that carries a record — for a member who wants the numbers in a spreadsheet. */
export function usageCsv (entries) {
  const lines = ['date,asked_by,calls,input_tokens,output_tokens,cached_tokens,cost_usd,credits,models,cost_source']
  for (const e of entries || []) {
    const u = usageOf(e)
    if (!u) continue
    const date = num(e.ts) ? new Date(num(e.ts)).toISOString() : ''
    lines.push([date, str(u.by), num(u.calls), num(u.in), num(u.out), num(u.cached), (num(u.costMicros) / 1e6).toFixed(6), (num(u.costMicros) / 1e4).toFixed(4), (Array.isArray(u.models) ? u.models : []).map((m) => str(m)).join(' '), str(u.source, 20)].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}
