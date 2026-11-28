// ownAgentLink.js — YOUR ALWAYS-ON SPACE AS AN OUTSIDE AGENT OF ONE OF YOUR PRIVATE ROOMS, AS GROK BOT IS (docs/cloud-device.md § 13.6
// decision 2; the owner, 2026-11-24: "I meant always on like an outside agent to the private lane" → "Like grokbot"). Two doors, one
// each way — the same doors Grok Bot uses, so nothing new at the Sentinel:
//   JOBS OUT   — the private room gets a CONNECTION (MCP) to the always-on Space's own door, with the token of a peer that Space keeps
//                for it: marked `own` (a2aCore ownInstructions — it is the member asking) and `auto` (the cloud device answers, no draft).
//                The private assistant sends a job with message_member on it; a call asks the member first unless its tool says otherwise.
//   RESULTS IN — the private room keeps a JOB PEER named after the always-on Space (a2aCore jobInstructions: a report, no reply drafted);
//                its token goes to the cloud device with that Space (door.mjs `report`), which sends each answer into the private
//                room with message_member (cloud-device/report.mjs).
// Undo takes all of it away: both peers (their tokens stop at once), the connection, the device's target. A failure half-way undoes
// what was done. In the hosted app the vault installs both credentials and the page registers their hashes.
// `d` = the app's functions (space.js passes them; tests pass fakes).

export const ownPeerName = (laneName) => `Your assistant in “${String(laneName || 'a private room').slice(0, 60)}”`

/** The link between private room `lane` and always-on Space `space`, as this device's A2A record holds it → { lPeer, sPeer } | null. */
export function ownAgentLinkOf ({ lane, space, spaceName, laneName }, d) {
  const lp = d.peersOf(lane).find((p) => p.job === true && p.name === spaceName)
  const sp = d.peersOf(space).find((p) => p.own === true && p.name === ownPeerName(laneName))
  return lp && sp ? { lPeer: lp.id, sPeer: sp.id } : null
}

/** Is the private room's connection to the Space's door in place? A link whose two doors exist but whose connection does not
 *  (an attach that failed, its undo lost — the owner's iPhone, 2026-11-25: Help said "already set", the assistant could not reach it)
 *  is NOT linked. → true / false; null when it cannot be told. */
export async function ownAgentConnected ({ lane, space, connId }, d) {
  if (!d.connectionsIn) return null
  let u; try { u = new URL(d.mcpUrl(space)) } catch { return null }
  const list = await d.connectionsIn(lane)
  if (!Array.isArray(list)) return null
  return list.some((c) => c && (!connId || c.id === connId) && c.host === u.host && c.mcp && c.mcp.path === u.pathname)
}

/** Set it up. → { lPeer, sPeer, connId } (what Undo needs) — or throws the reason, having undone what it did. */
export async function linkOwnAgent ({ lane, space, spaceName, laneName }, d) {
  const unavailable = d.unavailable()
  if (unavailable) throw new Error(unavailable)
  let prepared
  const done = { lPeer: '', sPeer: '', connId: '', reported: false }
  try {
    // RESULTS IN: the private room's job peer, named after the always-on Space
    if (!d.hasLane(lane)) await d.enableLane(lane, 'Private assistant')
    if (!d.hasLane(space)) await d.enableLane(space, spaceName)
    if (d.hosted()) prepared = await d.prepare({ space, laneUrl: d.mcpUrl(lane), spaceUrl: d.mcpUrl(space), laneName, spaceName })
    const inTok = await d.addPeer(lane, spaceName, { reply: 'ask', job: true, ...(prepared && { tokenHash: prepared.reportHash }) })
    done.lPeer = inTok.id
    // JOBS OUT: the always-on Space's own door, a peer for this private assistant, answered by the device
    const outTok = await d.addPeer(space, ownPeerName(laneName), { reply: 'auto', own: true, ...(prepared && { tokenHash: prepared.jobHash }) })
    done.sPeer = outTok.id
    await d.push()
    await d.syncSpaceAgents(space) // what the cloud device reads: who may write, answered without asking, as the member's own
    done.reported = true // also clear a target whose acknowledgement was lost
    if (prepared) {
      const conn = await d.install(prepared.jobHash, done.sPeer)
      done.connId = conn.id
      await d.keepHeld(conn)
    } else {
      await d.report(space, done.sPeer, { url: d.mcpUrl(lane), token: inTok.token, name: laneName })
      const conn = await d.connect({ kind: 'mcp', url: d.mcpUrl(space), label: spaceName }, { token: outTok.token })
      done.connId = conn.id
    }
    if (d.keepLink) await d.keepLink({ lane, space, lPeer: done.lPeer, sPeer: done.sPeer, connId: done.connId, pending: true })
    await d.useIn(lane, done.connId)
    if (d.keepLink) await d.keepLink({ lane, space, lPeer: done.lPeer, sPeer: done.sPeer, connId: done.connId })
    return { lPeer: done.lPeer, sPeer: done.sPeer, connId: done.connId }
  } catch (e) {
    if (prepared && !done.connId) {
      const cancelled = await d.cancel(prepared.jobHash).catch(() => null)
      if (cancelled?.connId) done.connId = cancelled.connId
    }
    await unlinkOwnAgent({ lane, space, ...done }, d).catch(() => null)
    throw e
  }
}

/** Take it away (Help's Undo; and a half-done link). Each step on its own: one that fails does not keep the others. → true */
export async function unlinkOwnAgent ({ lane, space, lPeer, sPeer, connId, reported = true }, d) {
  const errs = []
  const step = async (f) => { try { await f() } catch (e) { errs.push(String((e && e.message) || e)) } }
  if (!connId && lane && space && lPeer && sPeer && d.connectionsIn) {
    const url = new URL(d.mcpUrl(space)), connections = await d.connectionsIn(lane)
    if (!Array.isArray(connections)) throw new Error('the private assistant’s connections could not be read')
    const matches = connections.filter((c) => c && c.host === url.host && c.mcp?.path === url.pathname)
    if (matches.length > 1) throw new Error('more than one connection uses this agent’s address')
    connId = matches[0]?.id
  }
  if (connId) await step(() => d.disconnect(connId))
  if (sPeer && reported) await step(() => d.report(space, sPeer, null))
  if (lPeer) await step(() => d.removePeer(lane, lPeer))
  if (sPeer) await step(() => d.removePeer(space, sPeer))
  if (lPeer || sPeer) await step(() => d.push())
  if (sPeer) await step(() => d.syncSpaceAgents(space))
  if (errs.length) throw new Error(errs[0])
  if (connId && d.keepLink) await d.keepLink({ lane, space, lPeer, sPeer, connId, gone: true })
  return true
}
