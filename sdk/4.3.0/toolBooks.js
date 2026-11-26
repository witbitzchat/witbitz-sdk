// toolBooks.js — an MCP connection's chosen tools as a TOOL BOOK (agent/toolBook.mjs; owner, 2026-11-17: "Too many tools … The tool
// book is the fix"), ONE copy for the app's picker (mcpToolsSheet.js) and the SDK's connections.grant (witbitz-sdk.js) — the SDK
// saved the whole list, so "Too many tools" could still fill a Space through it (sync sweep 2026-11-17 #3).
// `io` is one Space: { toolBook(tools) → { status, ref, sha256 }, getConfig() → config, setConfig(patch) }.

/** The tools' descriptions and schemas go into the Space ONCE, as a sealed book; the config keeps names + the book's pin. A server
 *  that cannot take a book yet (older), or any failure: `mcp` unchanged — the whole list, exactly as before. */
export async function withBook (io, mcp) {
  try {
    const r = io && typeof io.toolBook === 'function' ? await io.toolBook(mcp.tools) : null
    if (r && r.status === 200 && typeof r.ref === 'string' && /^[0-9a-f]{64}$/.test(String(r.sha256 || ''))) {
      return { ...mcp, tools: mcp.tools.map((t) => ({ name: t.name, title: t.title, readOnly: t.readOnly === true })), book: { ref: r.ref, sha256: r.sha256 } }
    }
  } catch { /* the whole list, as before */ }
  return mcp
}

/** THE SPACE'S OLDER CONNECTIONS INTO BOOKS (the owner, 2026-11-17, Vercel refused in a Space holding Todoist and GitHub saved
 *  whole: "I cannot add vercel"): before a connection is added or saved, every OTHER connection of the Space whose tools still sit
 *  whole in the config is moved into a book, one config update each — so the room is freed without anyone re-saving by hand.
 *  Best effort: a connection that cannot be booked stays as it is. */
export async function bookTheRest (io, exceptId) {
  let cfg = null; try { cfg = await io.getConfig() } catch { cfg = null }
  for (const c of ((cfg && cfg.connections) || [])) {
    if (!c || !c.id || c.id === exceptId || !c.mcp || c.mcp.book || !Array.isArray(c.mcp.tools) || !c.mcp.tools.length) continue
    if (!c.mcp.tools.some((t) => t && (t.description || (t.inputSchema && Object.keys(t.inputSchema.properties || {}).length)))) continue // names only already
    const mcp = await withBook(io, c.mcp)
    if (!mcp.book) return // the server takes no book (older): nothing more to try
    try { await io.setConfig({ connections: { update: { id: c.id, mcp } } }) } catch { /* stays whole */ }
  }
}
