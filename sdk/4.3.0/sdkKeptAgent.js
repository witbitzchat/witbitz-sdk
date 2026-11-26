import { linkOwnAgent, unlinkOwnAgent } from './ownAgentLink.js'
import { enableLaneIn, addPeerIn, removePeerIn, peersOf, mcpUrlOf } from './a2aCore.js'
import { A2A_PEERS_DOC } from './a2aShared.js'
import { sealDoc } from './accountSeal.js'

const fail = (code, text) => Object.assign(new Error('witbitz: ' + text), { code })
const ID = /^[A-Za-z0-9_-]{1,128}$/
const validLink = (link, lane, space) => link && link.lane === lane.room && link.space === space.room && ['connId', 'lPeer', 'sPeer'].every((k) => typeof link[k] === 'string' && ID.test(link[k]))
const queue = (w, fn) => { const out = (w._keptAgentRun || Promise.resolve()).catch(() => {}).then(fn); w._keptAgentRun = out.catch(() => {}); return out }
const DOC = 'xkept-agent-links' // private account doc: the framed page has no raw account-document API
const publicLink = (l) => ({ lane: l.lane, space: l.space, connId: l.connId, lPeer: l.lPeer, sPeer: l.sPeer })
async function readLinks(w, guard) {
  guard()
  if (!w.account.enabled) throw fail('not_enabled', 'enable the account before linking kept assistants')
  const loc = await w.account._where(); guard()
  const got = await w.account._read(loc, DOC, loc.app); guard()
  if (!got.ok) throw fail('unreadable', 'the account’s kept-assistant links could not be read')
  const links = (got.doc && got.doc.links) || {}
  if (got.doc && (got.doc.v !== 1 || typeof links !== 'object' || Array.isArray(links))) throw fail('unopenable', 'the kept-assistant link document is malformed')
  for (const [id, l] of Object.entries(links)) if (!l || id !== l.connId || !['lane', 'space', 'connId', 'lPeer', 'sPeer'].every((k) => typeof l[k] === 'string' && ID.test(l[k]))) throw fail('unopenable', 'a kept-assistant link is malformed')
  return { loc, got, links }
}
async function saveLink(w, link, guard) {
  for (let i = 0; i < 5; i++) {
    const { loc, got, links } = await readLinks(w, guard)
    const next = { v: 1, links: { ...links, [link.connId]: { ...link, at: Math.max(Date.now(), (Number(links[link.connId] && links[link.connId].at) || 0) + 1) } } }
    const sealed = await sealDoc(loc.app, next); guard()
    const r = await w.account._client().state(loc.room, loc.mk, DOC, sealed, 'kept assistant links', 'device', got.v); guard()
    if (r && r.status === 409) continue
    if (!r || r.status !== 200) throw fail('save_failed', 'the kept-assistant link could not be saved')
    return
  }
  throw fail('version_conflict', 'the kept-assistant links kept changing')
}

/** Runs the app's complete link/rollback workflow where the credentials live: directly, or INSIDE the vault. */
function deps(w, lane, space, guard) {
  const a = w.a2a, made = {}, held = new Map(), byRoom = new Map([[lane.room, lane], [space.room, space]])
  const call = async (fn) => { guard(); const r = await fn(); guard(); return r }
  const url = (room) => { const c = a._s.lanes[room]; return c ? mcpUrlOf(a.endpoint, c.handle) : null }
  return {
    unavailable: () => '', hosted: () => false,
    hasLane: (room) => !!a._s.lanes[room],
    enableLane: (room, name) => call(() => a._change((s) => enableLaneIn(s, room, { name }))),
    addPeer: (room, name, opts) => call(async () => { const r = await a._change((s) => addPeerIn(s, room, name, opts, fail)); made[room] = r.id; return r }),
    removePeer: (room, id) => call(async () => { if (peersOf(a._s, room).some((p) => p.id === id)) await a._change((s) => removePeerIn(s, room, id)) }),
    push: async () => {}, // _change already pushes and commits each change only after acknowledgement
    peersOf: (room) => peersOf(a._s, room), mcpUrl: url,
    syncSpaceAgents: (room) => call(async () => {
      const sp = byRoom.get(room)
      for (let i = 0; i < 5; i++) {
        const d = await sp._client.state(room, sp._mk, A2A_PEERS_DOC); guard()
        if (!d || d.status !== 200 || !Number.isInteger(d.v)) throw fail('unreadable', 'the kept assistant’s peer list could not be read')
        const peers = peersOf(a._s, room)
        const r = await sp._client.state(room, sp._mk, A2A_PEERS_DOC, { peers }, `${peers.length} outside agents may write here`, sp._who(), d.v)
        guard()
        if (r && r.status === 409) continue
        if (!r || r.status !== 200) throw fail('save_failed', 'the kept assistant’s peer list could not be saved')
        return
      }
      throw fail('version_conflict', 'the kept assistant’s peer list kept changing')
    }),
    report: (room, peerId, target) => call(async () => { try { return await w.cloudDevice._ask('report', { room, peerId, ...(target ? { url: target.url, token: target.token, name: target.name || '' } : { off: true }) }) } catch (e) { if (target || (e.code !== 'not_enrolled' && e.code !== 'not_kept')) throw e } }), // 11·O#4: off where the device holds no such Space = done
    connect: (spec, input) => call(async () => {
      const conn = await w.connections.attachMcp({ url: spec.url, label: spec.label, token: input.token }); guard()
      const link = { lane: lane.room, space: space.room, lPeer: made[lane.room], sPeer: made[space.room], connId: conn.id, pending: true }
      try {
        await saveLink(w, link, guard)
        if (w._keepAgentConnection) await w._keepAgentConnection(conn, link)
        w._keptAgentConnections = w._keptAgentConnections || new Map()
        w._keptAgentConnections.set(conn.id, { ...conn, ownLink: link }); held.set(conn.id, conn)
      } catch (e) { await w.connections.detach(conn.id).catch(() => {}); throw e }
      return conn
    }),
    disconnect: (id) => call(() => w.connections.detach(id, { spaces: [lane] })),
    useIn: (_room, id) => call(() => lane.connections.grant(held.get(id), { reads: 'auto' })),
  }
}

function checked(lane, space) {
  const w = lane._wb
  if (!w || !lane._sharedRoom || !space || space._sharedRoom || space._wb !== w || space.room === lane.room) throw fail('invalid_argument', 'link a private lane and a kept Space from the same client')
  const session = w._session, state = w.backup._s
  const guard = () => { if (w._session !== session || w.backup._s !== state) throw fail('account_changed', 'the account changed during assistant linking') }
  return { w, guard }
}

export function linkKeptAgent(lane, space, { spaceName = space && space.title, laneName = lane.title } = {}) {
  const { w, guard } = checked(lane, space)
  return queue(w, async () => {
    guard()
    if (!(await space.alwaysOn.status()).on) throw fail('not_always_on', 'keep this Space on the cloud device before linking it')
    guard()
    const { links } = await readLinks(w, guard)
    const existing = Object.values(links).find((l) => l && !l.gone && l.lane === lane.room && l.space === space.room)
    guard()
    if (existing && !existing.pending) {
      if (!w.a2a._s.lanes[lane.room] || !w.a2a._s.lanes[space.room]) throw fail('a2a_state_required', 'restore this account’s A2A state before reopening its kept-assistant link')
      const cfg = await lane._gateConfig({ fresh: true }); guard()
      if (!cfg || cfg.gated && !cfg.allow) throw fail('unreadable', 'the private assistant’s connections could not be read')
      const connections = Array.isArray(cfg?.connections) ? cfg.connections : []
      if (connections.some((c) => c.id === existing.connId)) return publicLink(existing)
    }
    if (existing) await unlinkKnown(w, lane, space, existing, guard)
    const d = deps(w, lane, space, guard)
    const result = await linkOwnAgent({ lane: lane.room, space: space.room, spaceName: String(spaceName || 'Kept assistant').slice(0, 80), laneName: String(laneName || 'Private assistant').slice(0, 80) }, d)
    guard()
    const link = { lane: lane.room, space: space.room, ...result }
    await saveLink(w, link, guard)
    return link
  })
}

export function unlinkKeptAgent(lane, space, link) {
  const { w, guard } = checked(lane, space)
  if (!validLink(link, lane, space)) throw fail('invalid_argument', 'use the link returned by lane.linkKept for these rooms')
  return queue(w, async () => {
    guard()
    const { links } = await readLinks(w, guard), known = links[link.connId]
    if (!known) throw fail('not_in_account', 'that kept-assistant link is not in this account')
    if (known.gone) return { disconnected: true }
    if (!validLink(known, lane, space) || known.lPeer !== link.lPeer || known.sPeer !== link.sPeer) throw fail('not_in_account', 'that kept-assistant link does not belong to these rooms')
    await unlinkKnown(w, lane, space, known, guard)
    return { disconnected: true }
  })
}

async function unlinkKnown(w, lane, space, link, guard) {
  if (!w._agentRoom && (!w.a2a._s.lanes[lane.room] || !w.a2a._s.lanes[space.room])) throw fail('a2a_state_required', 'restore this account’s A2A state before unlinking its kept assistant')
  const missing = [[lane.room, link.lPeer], [space.room, link.sPeer]]
    .filter(([room, id]) => !peersOf(w.a2a._s, room).some((p) => p.id === id))
  if (missing.length) {
    const remote = await w.a2a.status()
    guard()
    if (remote?.ok !== true || !Array.isArray(remote.lanes)) throw fail('unreadable', 'the active outside-agent peers could not be checked')
    for (const [room, id] of missing) {
      const active = remote.lanes.find((l) => l.room === room)
      if (active && (!Array.isArray(active.peers) || active.peers.some((p) => p.id === id))) throw fail('a2a_state_required', 'restore this account’s current A2A state before unlinking its kept assistant')
    }
  }
  await unlinkOwnAgent({ lane: lane.room, space: space.room, lPeer: link.lPeer, sPeer: link.sPeer, connId: link.connId }, deps(w, lane, space, guard))
  guard()
  await saveLink(w, { ...publicLink(link), gone: true }, guard)
  if (w._forgetAgentConnection) await w._forgetAgentConnection(link.connId)
  if (w._keptAgentConnections) w._keptAgentConnections.delete(link.connId)
}

export async function keptAgentSpaceIds(w) {
  const legacy = Object.keys(w.a2a?._s?.lanes || {})
    .filter((room) => peersOf(w.a2a._s, room).some((p) => p.own === true))
  if (!w.account?.enabled || typeof w.account._read !== 'function') return legacy
  const session = w._session, state = w.backup._s
  const guard = () => { if (w._session !== session || w.backup._s !== state) throw fail('account_changed', 'the account changed while reading kept links') }
  const { links } = await readLinks(w, guard)
  return [...new Set([...legacy, ...Object.values(links).filter((l) => !l.gone).map((l) => l.space)])]
}

/** Stop every link to a Space, including links created on another device. Uses the private account doc, not page-supplied ids. */
export function disconnectKeptSpace(space) {
  const w = space._wb, session = w._session, state = w.backup._s
  const guard = () => { if (w._session !== session || w.backup._s !== state) throw fail('account_changed', 'the account changed while stopping kept assistants') }
  return queue(w, async () => {
    guard()
    const { links } = w.account?.enabled ? await readLinks(w, guard) : { links: {} }
    const errors = []
    for (const link of Object.values(links).filter((l) => l && !l.gone && l.space === space.room)) {
      let lane, close = false
      try {
        if (w._agentRoom) lane = w._agentRoom(link.lane)
        else {
          const rec = w.backup.rooms.find((r) => r.room === link.lane)
          if (!rec) throw fail('not_in_account', 'the private assistant must be restored before unlinking it')
          lane = await w.openSpace(rec.link, { live: false }); close = true
        }
        guard()
        await unlinkKnown(w, lane, space, link, guard)
      } catch (e) { errors.push(e) }
      finally { if (lane && (close || w._agentRoom)) lane.close() }
    }
    if (w.a2a) {
      const d = deps(w, space, space, guard)
      for (const p of d.peersOf(space.room).filter((p) => p.own === true)) {
        try { await unlinkOwnAgent({ space: space.room, sPeer: p.id }, d) } catch (e) { errors.push(e) }
      }
    }
    if (errors.length) throw errors[0]
  })
}
