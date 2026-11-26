// a2aShared.js — AN OUTSIDE AGENT IN A SOLO VERIFIED SPACE, SHARED BY ALL THE ACCOUNT'S DEVICES (docs/cloud-device.md § 12; owner,
// 2026-11-16: "we should allow drops directly to the solo verified room"). A lane's pending replies live on the device that delivered
// the message (a2aLane.js PENDING_KEY) — so a message the CLOUD DEVICE delivered would leave the phone nothing to review. In a Space
// that is its own agent target, two sealed room docs carry what every device needs:
//   `a2apeers`   { peers: [{ id, name, reply: 'ask'|'auto', job?, own? }] } (own: the member's own private assistant — a2aCore ownInstructions) — written by the phone that manages the agents (a2aSheet.js)
//   `a2apending` { items: [{ taskId, peerId, peerName, reply, text, draft, at, by }] } — an 'ask' agent's draft waiting for review,
//                written by whoever delivered it; removed by the device that sends (or declines) the answer.
// Pure: the app and the cloud device (Node) both import it.
export const A2A_PEERS_DOC = 'a2apeers'
export const A2A_PENDING_DOC = 'a2apending'
export const MAX_SHARED_PENDING = 32
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

export function peersFromDoc (d) {
  const a = d && d.state && Array.isArray(d.state.peers) ? d.state.peers : []
  return a.filter((p) => p && typeof p.id === 'string' && p.id && typeof p.name === 'string')
    .map((p) => ({ id: str(p.id, 64), name: str(p.name, 80), reply: p.reply === 'auto' ? 'auto' : 'ask', ...(p.job === true ? { job: true } : {}), ...(p.own === true ? { own: true } : {}) }))
}
export function pendingFromDoc (d) {
  const a = d && d.state && Array.isArray(d.state.items) ? d.state.items : []
  return a.filter((p) => p && typeof p.taskId === 'string' && p.taskId)
    .map((p) => ({ taskId: str(p.taskId, 128), peerId: str(p.peerId, 64), peerName: str(p.peerName, 80) || 'an outside agent', reply: p.reply === 'auto' ? 'auto' : 'ask', text: str(p.text, 4000), draft: str(p.draft, 20000), at: Number(p.at) || 0, by: str(p.by, 40) }))
}
/** items + one (replacing the same task) → a new list, the newest MAX_SHARED_PENDING. */
export const withShared = (items, it) => [...items.filter((x) => x.taskId !== it.taskId), it].slice(-MAX_SHARED_PENDING)
export const withoutShared = (items, taskId) => items.filter((x) => x.taskId !== taskId)
export const samePeers = (a, b) => JSON.stringify(a) === JSON.stringify(b)
