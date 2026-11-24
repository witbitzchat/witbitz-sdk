// mcpRecommended.js — the RECOMMENDED tool setting for an MCP server in a Space (the owner, 2026-10-10: "We should have like a
// recommended settings for the tools for each connection. If the user wants to customize it he can.").
//
// Recommended = every tool the server offers (up to the per-server cap, the ones that say they only read first, so a
// cut never drops a read for a write), and the ones that say they only read run WITHOUT ASKING; everything that may
// change something asks first, as a card. A server's "read-only" claim is its own word: it is what the recommendation
// trusts, and a member can switch any tool back to asking (or off) in the picker — the Space is then "Custom".
import { MCP_TOOLS_PER_SERVER } from './connectionEntry.js'

/** tools: the room's tool shapes ({ name, readOnly }) → { chosen: [names], auto: [names] } */
export function recommendedChoice (tools, cap = MCP_TOOLS_PER_SERVER) {
  const list = (Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === 'string' && t.name)
  const ordered = [...list.filter((t) => t.readOnly === true), ...list.filter((t) => t.readOnly !== true)]
  const chosen = ordered.slice(0, cap).map((t) => t.name)
  const keep = new Set(chosen)
  const auto = list.filter((t) => t.readOnly === true && keep.has(t.name)).map((t) => t.name)
  return { chosen, auto }
}

/** Does a Space's current choice equal the recommendation for these tools? (order-free) */
export function isRecommended (tools, chosen, auto, cap = MCP_TOOLS_PER_SERVER) {
  const r = recommendedChoice(tools, cap)
  const same = (a, b) => { const x = new Set(a || []), y = new Set(b || []); return x.size === y.size && [...x].every((n) => y.has(n)) }
  return same(r.chosen, chosen) && same(r.auto, auto)
}
