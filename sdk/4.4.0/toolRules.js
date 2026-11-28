// toolRules.js — WHICH TOOLS RUN ON THEIR OWN, PER ROOM (docs/approvals-model.md step 1 = docs/always-on-agent-plan.md Phase 0.2;
// the owner, 2026-11-18: "each tool's setting is the floor"; 2026-11-23: "do it start to end"). One sealed settings doc per room,
// `toolrules` = { rules: { <tool name>: 'auto' | 'ask' }, at }, read by the server on every turn (both tiers) and written like the
// room's other settings (members; admins where the room has admins). No entry = today's default for that tool.
//   'ask'  → the tool never runs inside a turn: a card, approved by a person, as an effectful tool is today.
//   'auto' → the tool runs inside the turn with no card — only because a person wrote this entry; never by a model or a default.
// Shared by the server (agent/spaceService.mjs brainWith), the app (the ⋯ → Tools sheet) and the SDK (space.toolRules).

/** "todo__add_task" → "Todo · add task"; "read_url" → "read url". A connection's tools carry its name before "__". */
export function toolLabel (name) {
  const s = String(name || '')
  const i = s.indexOf('__')
  const words = (x) => x.replace(/[_-]+/g, ' ').trim()
  if (i > 0) { const c = words(s.slice(0, i)); return (c.charAt(0).toUpperCase() + c.slice(1)) + ' · ' + words(s.slice(i + 2)) }
  return words(s)
}

export const TOOLRULES_DOC = 'toolrules'
export const RULE_VALUES = ['auto', 'ask']
const NAME = /^[A-Za-z0-9_.:-]{1,100}$/
export const RULES_MAX = 300

/** Any object → the rules the server honours: known values, tool-shaped names, at most RULES_MAX. */
export function cleanRules (o) {
  const out = {}
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= RULES_MAX) break
    if (NAME.test(k) && RULE_VALUES.includes(v)) out[k] = v
  }
  return out
}
/** The `toolrules` doc (as `state(room, 'toolrules')` returns it) → its rules ({} when none). */
export const rulesFromDoc = (d) => cleanRules(d && d.state && d.state.rules)
/** The doc's state for a set of rules. */
export const toolRulesDocOf = (rules) => ({ rules: cleanRules(rules), at: Date.now() })

/** THE GATE: the run-now set a turn would use, with the room's rules applied. `offered`: every tool this turn can call (by its
 *  real name); `fixed`: tools a rule never moves (transport and search tools, a device's declared tools, whose own path decides).
 *  'ask' takes a tool out; 'auto' puts an offered tool in. → a new array; the input is not changed. */
export function applyToolRules (immediate, { rules, offered, fixed = [] } = {}) {
  const r = cleanRules(rules)
  const off = offered instanceof Set ? offered : new Set(offered || [])
  const keep = fixed instanceof Set ? fixed : new Set(fixed)
  const set = new Set(Array.isArray(immediate) ? immediate : [])
  for (const [name, v] of Object.entries(r)) {
    if (keep.has(name)) continue
    if (v === 'ask') set.delete(name)
    else if (v === 'auto' && off.has(name)) set.add(name)
  }
  return [...set]
}
