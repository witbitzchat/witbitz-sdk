// enclaveSnapshotMerge.js — what the VAULT's one key worker is told about the enclave when several app frames speak (the main app,
// a lane panel, the Code page inside it): each sends its own `{ t:'enclave', key, attested, keys, acceptance, rooms }` and the worker
// REPLACES its state on every message (l1-worker.js case 'enclave').
// ⛔ STATE MACHINES PASS 8, R#1: the vault relayed the LAST frame's key, attestation and acceptance whole — a panel holding an older
// enclave key (the enclave re-attested since it opened) put that key back over the main app's newer one. The main app's key and
// attestation win; a panel only fills what is missing. Per-region keys merge the same way; accepted builds and confidential rooms are
// the UNION (a room wrongly listed costs a read, one missing sends its key unsealed — sync sweep 2026-11-09 #1).
const union = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])]
const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})

// ⛔ PASS 9, X#1 — AND THE NEWER ATTESTATION WINS, WHOEVER SENT IT. "The main app's wins" alone froze the first key: the enclave is
// restarted (a wake, a repin), the person wakes it from the lane panel, the panel attests the NEW key — and the vault handed the
// worker the main app's old one again; every turn from the panel was sealed to a dead key until the main frame happened to
// attest. Every snapshot carries when its key was attested (`attested.at`, enclaveRoute.js): the later one is the enclave's key
// now. Equal or unknown times → the main app's, as pass 8 left it.
const at = (a) => (a && Number.isFinite(a.at) && a.at > 0 ? a.at : 0)

/** prev: the last merged snapshot (or null); msg: a frame's; fromMain: it came from the main app's window. → the merged message. */
export function mergeEnclaveSnapshot (prev, msg, fromMain) {
  const p = prev || {}
  // which of two attested keys stands: 'm' (this message's) or 'p' (what the worker holds)
  const side = (mKey, mAtt, pKey, pAtt) => {
    if (mKey == null) return 'p'
    if (pKey == null) return 'm'
    const a = at(mAtt), b = at(pAtt)
    if (a && b && a !== b) return a > b ? 'm' : 'p'
    return fromMain ? 'm' : 'p'
  }
  const top = side(msg.key, msg.attested, p.key, p.attested)
  const keys = { ...obj(p.keys) }
  for (const [region, e] of Object.entries(obj(msg.keys))) {
    const was = keys[region]
    if (side(e && e.key, e && e.attested, was && was.key, was && was.attested) === 'm') keys[region] = e
  }
  const pt = p.acceptance && p.acceptance.trusted, mt = msg.acceptance && msg.acceptance.trusted
  return {
    ...msg,
    key: (top === 'm' ? msg.key : p.key) ?? null,
    attested: (top === 'm' ? (msg.attested ?? p.attested) : (p.attested ?? msg.attested)) ?? null,
    keys,
    acceptance: Array.isArray(pt) || Array.isArray(mt) ? { ...obj(p.acceptance), ...obj(msg.acceptance), trusted: union(pt, mt) } : { ...obj(p.acceptance), ...obj(msg.acceptance) },
    rooms: union(p.rooms, msg.rooms),
  }
}
