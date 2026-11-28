import { parseMcpUrl } from './connections.js'

// connOtherWays.js — the Connections card's "other ways to connect" (an MCP server by its address, a service's own API key): WHERE they
// show and what a typed address means. Pure — the card (connectionsSheet.js renderConnList) draws what these decide.
// The owner, 2026-11-26: "placed in almost unreachable place" — the section was the last, under the whole catalog, and a search that did
// not match its own name hid it (a server not in the catalog — Zoom before its approval — had no way in).

/** An MCP server's address typed or pasted in the search box → its https URL, else ''. A bare host (mcp.zoom.us/…) gets https://;
 *  anything but https on a dotted host is not an address here (the MCP form refuses it anyway). */
export function typedMcpUrl (raw) {
  try {
    const { host, path } = parseMcpUrl(raw)
    return 'https://' + host + path
  } catch { return '' }
}

/** Which of the other ways to show, and under what heading → { title, rows } (rows: a subset of `all`, in order).
 *  Not searching: all, as "Other ways to connect" (placed right after the person's own connections). Searching: the ones whose name
 *  or line matches; when NOTHING on the card matched, all of them, as "Not listed? Connect it another way" — never a dead end. */
export function otherWaysRows ({ all, matches, searching, anythingElse }) {
  if (!searching) return { title: 'Other ways to connect', rows: all }
  const hit = all.filter(matches)
  if (hit.length) return { title: 'Other ways to connect', rows: hit }
  return anythingElse ? { title: '', rows: [] } : { title: 'Not listed? Connect it another way', rows: all }
}

/** Read connection IDs only. An unreadable private assistant makes a negative result inconclusive. */
export async function readConnectionUse(room, assistants, read, { verifiedOnly = false } = {}) {
  const ids = new Set(), locations = new Map()
  let incomplete = false
  for (const id of new Set([room, ...assistants])) {
    let cfg
    try { cfg = await read(id) } catch { cfg = null }
    if (!cfg || typeof cfg !== 'object' || cfg.error || cfg.gated || (cfg.status && cfg.status !== 200)) {
      incomplete = true
      continue
    }
    if (id === room && verifiedOnly && cfg.admission !== 'email') return { ids, locations, incomplete, eligible: false }
    for (const c of Array.isArray(cfg.connections) ? cfg.connections : []) if (typeof c?.id === 'string') {
      ids.add(c.id)
      if (!locations.has(c.id)) locations.set(c.id, [])
      locations.get(c.id).push(id)
    }
  }
  return { ids, locations, incomplete, eligible: true }
}

export async function spacesUsingConnection(id, rooms, read) {
  if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('a connection ID is required'), { code: 'invalid_argument' })
  const uses = [], unreadable = []
  const lanes = new Map()
  for (const row of rooms) if (row.shared) {
    if (!lanes.has(row.shared)) lanes.set(row.shared, [])
    lanes.get(row.shared).push(row.room)
  }
  const rows = rooms.filter(r => r.room && !r.shared && r.kind !== 'lane' && !r.room.startsWith('tmp-'))
  for (let i = 0; i < rows.length; i += 6) {
    const batch = rows.slice(i, i + 6)
    const results = await Promise.all(batch.map(r => readConnectionUse(r.room, lanes.get(r.room) || [], read, { verifiedOnly: true })))
    results.forEach(({ ids, incomplete }, index) => {
      const { room } = batch[index]
      if (ids.has(id)) uses.push(room)
      if (incomplete) unreadable.push(room)
    })
  }
  return { rooms: uses, unreadable, incomplete: unreadable.length > 0 }
}

export function grantStatus(grant, account, known) {
  if (known?.has(grant.id)) return 'connected'
  if (!grant.account || !account) return 'unknown'
  if (grant.account !== account) return 'other_member'
  return known ? 'detached' : 'unknown'
}
