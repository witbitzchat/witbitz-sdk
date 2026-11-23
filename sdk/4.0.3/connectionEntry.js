// connectionEntry.js — what a ROOM keeps about a connection (its sealed config), bounded: never a secret; for an MCP
// server, the tools the members chose and which of them run without asking (docs/mcp-connections.md § 5).
// Shared by spaceClient.setConfig (the write) and the Connections sheet (what it shows), so the two cannot disagree.

export const MCP_TOOLS_PER_SERVER = 40 // = agent/connectionTools.mjs MCP_TOOLS_PER_SERVER (the server drops the rest)
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/** One tool as the room keeps it: name, title, description, input schema (≤ 8 KB), the server's read-only claim. */
export function roomTool(t) {
  if (!isObj(t) || !TOOL_NAME.test(String(t.name || ''))) return null
  const schema = isObj(t.inputSchema) && JSON.stringify(t.inputSchema).length <= 8192 ? t.inputSchema : { type: 'object', properties: {} }
  return { name: String(t.name), title: String(t.title || '').slice(0, 120), description: String(t.description || '').slice(0, 1000), inputSchema: schema, readOnly: t.readOnly === true }
}

// AN AGENT THAT TAKES JOBS (jobAgents.js, docs/job-agents.md): where a job goes in the request and the fixed headers every
// call carries. Kept only on a webhook connection. The credential headers can never be named here — the Sentinel drops them
// anyway (custody.mjs CALLER_HEADER_DROP). ≡ agent/connectionTools.mjs jobOf (a test holds them equal).
const JOB_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/, JOB_HEADER = /^[a-z0-9][a-z0-9-]{0,39}$/
export const JOB_HEADER_DROP = new Set(['authorization', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'x-api-key', 'webhook-id', 'webhook-timestamp', 'webhook-signature'])
export function roomJob(j) {
  if (!isObj(j)) return null
  const headers = {}
  for (const [k, v] of Object.entries(isObj(j.headers) ? j.headers : {}).slice(0, 6)) {
    const lk = String(k).toLowerCase()
    if (JOB_HEADER.test(lk) && !JOB_HEADER_DROP.has(lk) && !lk.startsWith('x-witbitz-') && typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v)) headers[lk] = v
  }
  return { field: JOB_FIELD.test(String(j.field || '')) ? String(j.field) : 'text', headers }
}

/** A connection entry → its bounded form, or null. `mcp` is kept only with at least one tool. */
export function roomConnection(x) {
  if (!isObj(x) || !x.id || !x.account || !x.callKey) return null
  const out = { account: String(x.account), id: String(x.id), callKey: String(x.callKey), label: String(x.label || '').slice(0, 80), host: String(x.host || '') }
  if (typeof x.webhook === 'string' && /^\/[^\s?#]{1,199}$/.test(x.webhook)) out.webhook = x.webhook // a signed webhook's one path, so the assistant can name it (docs/signed-webhooks.md)
  if (out.webhook && isObj(x.job)) out.job = roomJob(x.job) // an agent that takes jobs (jobAgents.js)
  if (isObj(x.mcp) && Array.isArray(x.mcp.tools)) {
    const tools = x.mcp.tools.map(roomTool).filter(Boolean).slice(0, MCP_TOOLS_PER_SERVER)
    const names = new Set(tools.map((t) => t.name))
    if (tools.length) {
      out.mcp = {
        tools,
        auto: (Array.isArray(x.mcp.auto) ? x.mcp.auto.map(String) : []).filter((n) => names.has(n)),
        ...(x.mcp.own === true ? { own: true } : {}),
        ...(Number.isFinite(x.mcp.listedAt) ? { listedAt: x.mcp.listedAt } : {}),
        // THE TOOL BOOK (agent/toolBook.mjs): the tools' descriptions and schemas, stored once in the room — the entry keeps names
        ...(isObj(x.mcp.book) && /^i_[A-Za-z0-9_-]{8,64}$/.test(String(x.mcp.book.ref || '')) && /^[0-9a-f]{64}$/.test(String(x.mcp.book.sha256 || '')) ? { book: { ref: x.mcp.book.ref, sha256: x.mcp.book.sha256 } } : {}),
      }
    }
  }
  return out
}

/** The room's current list + a DECLARATIVE patch ({ add } | { remove } | { update: { id, mcp } } | a whole list). */
export function applyConnectionsPatch(cur, c) {
  const list = Array.isArray(cur) ? cur : []
  const v = c == null ? null
    : Array.isArray(c) ? c
      : c.add ? [...list.filter((x) => x && x.id !== c.add.id), c.add]
        : c.remove ? list.filter((x) => x && x.id !== c.remove)
          : c.update && c.update.id ? list.map((x) => (x && x.id === c.update.id ? { ...x, mcp: c.update.mcp } : x))
            : list
  return v == null ? undefined : v.map(roomConnection).filter(Boolean).slice(0, 32)
}

// The name the model calls an MCP tool by — `<label>__<tool>`. ≡ agent/connectionTools.mjs mcpToolName (a test holds them
// equal), so a card and the typing line can say which server and tool a proposed call is for.
const slug = (s, n) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n)
export function mcpToolName(conn, tool) {
  const left = slug(conn.label || conn.host || conn.id, 24) || 'server'
  return `${left}__${slug(tool, 64 - left.length - 2) || 'tool'}`
}
/** A proposed action's type → { conn, tool } for the room's MCP connections, or null. */
export function mcpToolFor(connections, type) {
  if (typeof type !== 'string' || !type.includes('__')) return null
  for (const c of Array.isArray(connections) ? connections : []) {
    if (!c || !c.mcp || !Array.isArray(c.mcp.tools)) continue
    const t = c.mcp.tools.find((x) => x && mcpToolName(c, x.name) === type)
    if (t) return { conn: c, tool: t }
  }
  return null
}
/** A call's arguments as short lines a person can read: "title: Fix the login bug". */
export function argLines(args, { max = 8, len = 160 } = {}) {
  if (!args || typeof args !== 'object') return []
  return Object.entries(args).slice(0, max).map(([k, v]) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return `${k}: ${s.length > len ? s.slice(0, len) + '…' : s}` })
}
